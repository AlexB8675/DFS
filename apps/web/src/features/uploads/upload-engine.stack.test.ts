import { ApiClient, workspace } from '@dfs/contract'
import { sessionSchema } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { apiSend, setCsrfToken } from '@/lib/api/client'
import { UploadEngine } from './upload-engine'
import { useUploadStore, type UploadItem } from './upload-store'
import { httpTransport } from './upload-transport'

// The upload engine against a running stack (BACKEND.md §4.2): the real engine
// and HTTP transport, with upload requests failing on the way, answers lost on
// the way back, and an outage long enough to fail uploads, which are then
// resumed. The bot stores blobs through the ChaosBlobStore, so syncing retries
// too. Skipped unless DFS_API is set.
//
// Start `pnpm dev` with `BLOB_STORE=chaos`, from the root `.env` or the
// shell's environment (`$env:BLOB_STORE = 'chaos'` in PowerShell); the bot
// then logs a `BLOB_STORE=chaos` warning. Take it out afterwards. Then:
//
//   DFS_API=http://127.0.0.1:3000 DFS_USERNAME=… DFS_PASSWORD=… pnpm --filter @dfs/web check:engine
//
// DFS_ORIGIN is the web app's address (default http://localhost:5173), and
// DFS_CHAOS_SEED replays a run's faults.

const env = import.meta.env as Record<string, string | undefined>
const apiBase = env.DFS_API
const origin = env.DFS_ORIGIN ?? 'http://localhost:5173'
const seed = Number(env.DFS_CHAOS_SEED ?? Date.now() % 1_000_000)

/** Of upload requests: how many never arrive, and how many lose their answer. */
const FAILURE_RATE = 0.15
const LOST_ANSWER_RATE = 0.15

describe.skipIf(!apiBase)('the upload engine against the real API, with faults', () => {
  it(
    'uploads everything byte for byte, through failures, lost answers and an outage',
    {
      timeout: 10 * 60_000,
    },
    async () => {
      const network = chaosNetwork(apiBase ?? '', seed)
      console.info(`Chaos seed ${String(seed)} (DFS_CHAOS_SEED replays it).`)
      const started = performance.now()
      const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`

      // The engine's session, through the web app's own API client.
      const login = { username: env.DFS_USERNAME, password: env.DFS_PASSWORD }
      const session = await apiSend('POST', '/auth/login', login, sessionSchema)
      setCsrfToken(session.csrfToken)
      // Setup and checks go around the chaos, with a session of their own.
      const checker = new ApiClient(apiBase ?? '', origin)
      await checker.signIn(login.username ?? '', login.password ?? '')
      const folder = await workspace(checker)
      const usedBefore = await usedBytes(checker)

      const files = [
        file('empty.txt', 0),
        ...Array.from({ length: 30 }, (_, index) =>
          file(`small-${String(index)}.txt`, 1 + index * 97),
        ),
        // Three parts each, streamed: broken streams, lost answers to streams
        // and completions, and resuming.
        file('large-1.bin', 25 * 1024 * 1024),
        file('large-2.bin', 25 * 1024 * 1024),
      ]
      const engine = new UploadEngine(httpTransport)
      network.troubled = true
      // An outage from the middle of the first stream: it breaks after a part
      // and a half, then uploads fail until they give up, as a browser losing
      // its connection would see.
      network.outage = 'armed'
      await engine.enqueue(
        folder.id,
        files.map((picked, index) => ({
          file: picked,
          relativeDir: index % 3 ? '' : 'Nested/Deeper',
        })),
      )
      await until(() => item('large-1.bin')?.status === 'failed', 'the outage to fail large-1.bin')
      expect(item('large-1.bin')?.uploadedBytes).toBeGreaterThan(0)
      network.outage = 'off'
      // Resume failed uploads, as the panel's Retry does: from the first missing part.
      const resumed = new Set<string>()
      await until(
        async () => {
          for (const failed of items().filter((upload) => upload.status === 'failed')) {
            resumed.add(failed.file.name)
            await engine.retry(failed.id)
          }
          return items().every((upload) => upload.status === 'done')
        },
        'every upload to finish',
        () =>
          items()
            .filter((upload) => upload.status !== 'done')
            .map((upload) => `${upload.file.name}: ${upload.status} ${upload.error ?? ''}`)
            .join('\n'),
      )
      network.troubled = false
      console.info(
        `${String(network.failed)} requests failed, ${String(network.lostAnswers)} answers were lost, ` +
          `${String(network.outageFailures)} uploads hit the outage; resumed ${[...resumed].join(', ')}. ` +
          `Uploaded after ${elapsed()}.`,
      )
      expect(resumed).toContain('large-1.bin')
      expect(network.failed).toBeGreaterThan(0)
      expect(network.lostAnswers).toBeGreaterThan(0)

      // Then the bot stores them all, retrying through its own chaos.
      await until(
        async () => {
          await engine.refreshSyncStates()
          return items().every((upload) => upload.syncState === 'stored')
        },
        'every file to be stored',
        () =>
          `${String(items().filter((upload) => upload.syncState !== 'stored').length)} not stored yet`,
        5 * 60_000,
      )
      console.info(`Stored after ${elapsed()}.`)

      for (const upload of items()) {
        const response = await checker.fetch('GET', `/files/${upload.nodeId ?? ''}/content`)
        const actual = new Uint8Array(await response.arrayBuffer())
        const picked = files.find((candidate) => candidate.name === upload.file.name)
        const expected = new Uint8Array((await picked?.arrayBuffer()) ?? new ArrayBuffer(0))
        expect(sameBytes(actual, expected), `${upload.file.name} came back different`).toBe(true)
      }
      // Retried parts, streams and completions count once.
      const total = files.reduce((sum, picked) => sum + picked.size, 0)
      expect((await usedBytes(checker)) - usedBefore).toBe(total)
    },
  )
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Routes the web client's requests (relative `/api/…` URLs) to the stack, with
 * the cookies and `Origin` a browser would send, and faults on upload requests
 * while `troubled`. Absolute URLs (the checker's) pass untouched.
 */
function chaosNetwork(base: string, seed: number) {
  const realFetch = globalThis.fetch
  const cookies = new Map<string, string>()
  const random = mulberry32(seed)
  const network = {
    troubled: false,
    /** `armed` breaks the next stream partway through, and turns `on`. */
    outage: 'off' as 'off' | 'armed' | 'on',
    failed: 0,
    lostAnswers: 0,
    outageFailures: 0,
  }

  globalThis.fetch = async (input, init = {}) => {
    if (typeof input !== 'string' || !input.startsWith('/')) return realFetch(input, init)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    headers.set('Origin', origin)
    if (cookies.size > 0) {
      headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    const upload = network.troubled && input.startsWith('/api/uploads')
    const sending = /\/(parts\/\d+|content)(\?|$)/.test(input)
    if (upload && network.outage === 'armed' && input.includes('/content')) {
      network.outage = 'on'
      // The connection drops a part and a half into the stream: the server
      // keeps the whole part.
      const response = realFetch(new URL(input, base), {
        ...init,
        headers,
        body: cutShort(init.body as Blob, 15 * 1024 * 1024),
        duplex: 'half',
      } as RequestInit)
      await response.then((answer) => answer.body?.cancel()).catch(() => undefined)
      throw new TypeError('Chaos: the connection dropped.')
    }
    if (upload && network.outage === 'on' && sending) {
      // A proxy answering for a server it can't reach; retry at once, to fail fast.
      network.outageFailures += 1
      return Response.json(
        { error: { code: 'unavailable', message: 'Chaos: outage.' } },
        { status: 503, headers: { 'Retry-After': '0' } },
      )
    }
    if (upload && random() < FAILURE_RATE) {
      network.failed += 1
      throw new TypeError('Chaos: the request never arrived.')
    }
    const response = await realFetch(new URL(input, base), { ...init, headers })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';')
      const at = pair.indexOf('=')
      cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    // A lost answer to a batch would leave its sessions to the janitor, holding
    // their reservations for a day by design; batches only fail on the way there.
    const lossy = method !== 'GET' && !input.startsWith('/api/uploads/batch')
    if (upload && lossy && random() < LOST_ANSWER_RATE) {
      await response.body?.cancel()
      network.lostAnswers += 1
      throw new TypeError('Chaos: the answer was lost.')
    }
    return response
  }
  return network
}

/** A body that sends the first `bytes` of `blob`, then fails, as a dropped connection does. */
function cutShort(blob: Blob, bytes: number): ReadableStream<Uint8Array> {
  const reader = blob.stream().getReader()
  let sent = 0
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      const room = bytes - sent
      sent += value.length
      if (value.length < room) {
        controller.enqueue(value)
        return
      }
      controller.enqueue(value.slice(0, room))
      controller.error(new Error('Chaos: the connection dropped.'))
    },
  })
}

function items(): UploadItem[] {
  return useUploadStore.getState().items.map((entry) => entry.store.getState())
}

function item(name: string): UploadItem | undefined {
  return items().find((upload) => upload.file.name === name)
}

/** A file of `size` bytes of noise that depends on its name. */
function file(name: string, size: number): File {
  const bytes = new Uint8Array(size)
  let hash = 7
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  const random = mulberry32(hash)
  for (let index = 0; index < size; index++) bytes[index] = Math.floor(random() * 256)
  return new File([bytes], name, { type: 'application/octet-stream' })
}

async function usedBytes(client: ApiClient): Promise<number> {
  return (await client.call('GET', '/auth/me', sessionSchema)).user.usedBytes
}

async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  progress: () => string = () => '',
  timeoutMs = 3 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}.\n${progress()}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

/** A small seeded random number generator, so a run's faults can be replayed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
