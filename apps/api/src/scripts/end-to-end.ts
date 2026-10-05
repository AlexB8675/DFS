import { createHash } from 'node:crypto'
import { ApiClient, createFolder, sha256Hex, workspace } from '@dfs/contract'
import {
  nodePageSchema,
  nodeSchema,
  uploadBatchResultSchema,
  type CreateUploadInput,
  type UploadSession,
} from '@dfs/shared'

// The end-to-end check of BACKEND.md §4.2, against a running stack (`pnpm dev`):
// 1,000 small files and a 1 GB file go up the way the web app sends them,
// sync to storage, and come back byte for byte. Then many clients upload new
// versions of the same names at once, which must all go through.
//
//   DFS_USERNAME=… DFS_PASSWORD=… pnpm --filter @dfs/api check:end-to-end
//
// Options: DFS_API (default http://127.0.0.1:3000), DFS_ORIGIN (the web app's
// address, default http://localhost:5173), DFS_SMALL_FILES, DFS_LARGE_MB.

const api = process.env.DFS_API ?? 'http://127.0.0.1:3000'
const origin = process.env.DFS_ORIGIN ?? 'http://localhost:5173'
const smallFiles = Number(process.env.DFS_SMALL_FILES ?? 1000)
const largeBytes = Number(process.env.DFS_LARGE_MB ?? 1024) * 1024 * 1024
const { DFS_USERNAME: username, DFS_PASSWORD: password } = process.env
if (!username || !password) {
  console.error('[ERROR] Set DFS_USERNAME and DFS_PASSWORD.')
  process.exit(1)
}

/** When the current part of a step began, for `phase`. */
let phaseStarted = performance.now()

const client = new ApiClient(api, origin)
await client.signIn(username, password)
const root = await workspace(client)
console.info(`[INFO] Working in “${root.name}”.`)

await step(`${String(smallFiles)} small files`, async () => {
  const folder = await createFolder(client, root.id, 'Small files')
  const content = (index: number) =>
    new TextEncoder().encode(`file ${String(index)}\n`.repeat(1 + (index % 50)))
  const inputs: CreateUploadInput[] = Array.from({ length: smallFiles }, (_, index) => ({
    parentId: folder.id,
    name: `file-${String(index).padStart(4, '0')}.txt`,
    sizeBytes: content(index).length,
    mimeType: 'text/plain',
  }))
  // Sessions in batches of 64 and 8 parts in flight, as the upload engine does.
  const sessions: UploadSession[] = []
  for (let start = 0; start < inputs.length; start += 64) {
    const { results } = await client.call('POST', '/uploads/batch', uploadBatchResultSchema, {
      json: { uploads: inputs.slice(start, start + 64) },
    })
    for (const result of results) {
      if (!result.ok) throw new Error(result.error.message)
      sessions.push(result.session)
    }
  }
  phase('sessions')
  await inParallel(8, sessions, async (session, index) => {
    const bytes = content(index)
    await client.send('PUT', `/uploads/${session.uploadId}/parts/0`, {
      body: bytes,
      headers: { 'X-Part-SHA256': await sha256Hex(bytes) },
    })
  })
  phase('uploads')
  await waitUntilStored(sessions.map((session) => session.nodeId))
  phase('syncing')
  await inParallel(16, sessions, async (session, index) => {
    const response = await client.fetch('GET', `/files/${session.nodeId}/content`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!equal(bytes, content(index))) throw new Error(`File ${String(index)} came back different.`)
  })
  phase('downloads')
  const page = await client.call('GET', `/nodes/${folder.id}/children?limit=500`, nodePageSchema)
  const fullPage = Math.min(500, smallFiles)
  if (page.items.length !== fullPage || Boolean(page.nextCursor) !== smallFiles > 500) {
    throw new Error('Listing pages are off.')
  }
})

await step(`a ${String(largeBytes / 1024 / 1024)} MB file`, async () => {
  const { results } = await client.call('POST', '/uploads/batch', uploadBatchResultSchema, {
    json: {
      uploads: [
        {
          parentId: root.id,
          name: 'large.bin',
          sizeBytes: largeBytes,
          mimeType: 'application/octet-stream',
        },
      ],
    },
  })
  const [result] = results
  if (!result?.ok) throw new Error('The large upload was refused.')
  const session = result.session
  const parts = Array.from({ length: session.chunkCount }, (_, index) => index)
  // Parts are made on the fly, so the gigabyte is never in memory at once.
  await inParallel(4, parts, async (index) => {
    const bytes = part(index, session.chunkSize, largeBytes)
    await client.send('PUT', `/uploads/${session.uploadId}/parts/${String(index)}`, {
      body: bytes,
      headers: { 'X-Part-SHA256': await sha256Hex(bytes) },
    })
  })
  await client.send('POST', `/uploads/${session.uploadId}/complete`)
  await waitUntilStored([session.nodeId])

  const expected = createHash('sha256')
  for (const index of parts) expected.update(part(index, session.chunkSize, largeBytes))
  const actual = createHash('sha256')
  const response = await client.fetch('GET', `/files/${session.nodeId}/content`)
  if (!response.body) throw new Error('No body.')
  for await (const chunk of response.body) actual.update(chunk as Uint8Array)
  if (actual.digest('hex') !== expected.digest('hex'))
    throw new Error('The large file came back different.')
})

await step('12 clients uploading versions of the same names at once', async () => {
  // Starts and completions of one user's uploads interleave, versions of the
  // same files are numbered and pruned concurrently: no request may fail.
  const folders = await Promise.all(
    ['A', 'B'].map((name) => createFolder(client, root.id, `Shared ${name}`)),
  )
  const bytes = new TextEncoder().encode('hello\n')
  await inParallel(12, Array.from({ length: 12 }), async (_, worker) => {
    for (let round = 0; round < 5; round++) {
      const uploads = Array.from({ length: 8 }, (_, index) => ({
        parentId: folders[(worker + index) % 2]?.id ?? root.id,
        name: `shared-${String((round + index) % 12)}.txt`,
        sizeBytes: bytes.length,
        mimeType: 'text/plain',
      }))
      const { results } = await client.call('POST', '/uploads/batch', uploadBatchResultSchema, {
        json: { uploads },
      })
      await Promise.all(
        results.map(async (result) => {
          if (!result.ok) throw new Error(result.error.message)
          await client.send('PUT', `/uploads/${result.session.uploadId}/parts/0`, {
            body: bytes,
            headers: { 'X-Part-SHA256': await sha256Hex(bytes) },
          })
        }),
      )
    }
  })
  for (const folder of folders) {
    const page = await client.call('GET', `/nodes/${folder.id}/children`, nodePageSchema)
    if (page.items.length !== 12) throw new Error('Shared names made the wrong files.')
  }
})

console.info('[INFO] All checks passed.')

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Notes how long the part of a step since the last note took. */
function phase(name: string): void {
  const now = performance.now()
  console.info(`[INFO]   ${name}: ${((now - phaseStarted) / 1000).toFixed(1)} s`)
  phaseStarted = now
}

async function step(name: string, work: () => Promise<void>): Promise<void> {
  phaseStarted = performance.now()
  const started = performance.now()
  const took = () => `${((performance.now() - started) / 1000).toFixed(1)} s`
  try {
    await work()
  } catch (error) {
    console.error(`[ERROR] ✗ ${name} (after ${took()})`)
    throw error
  }
  console.info(`[INFO] ✓ ${name} (${took()})`)
}

async function inParallel<T>(
  limit: number,
  items: T[],
  work: (item: T, index: number) => Promise<void>,
) {
  let next = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        await work(items[index] as T, index)
      }
    }),
  )
}

/** Waits for the bot to store every one of these files. */
async function waitUntilStored(nodeIds: string[]): Promise<void> {
  const pending = new Set(nodeIds)
  const deadline = Date.now() + 10 * 60_000
  while (pending.size > 0) {
    if (Date.now() > deadline) throw new Error(`${String(pending.size)} files never synced.`)
    await inParallel(16, [...pending], async (id) => {
      const node = await client.call('GET', `/nodes/${id}`, nodeSchema)
      if (node.syncState === 'stored') pending.delete(id)
      if (node.syncState === 'failed') throw new Error(`${node.name} failed to sync.`)
    })
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Part `index` of the large file: deterministic noise, the same every time. */
function part(index: number, chunkSize: number, total: number): Uint8Array<ArrayBuffer> {
  const size = Math.min(chunkSize, total - index * chunkSize)
  const bytes = new Uint8Array(size)
  let state = (index + 1) * 2654435761
  for (let i = 0; i < size; i += 4) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[i] = state & 0xff
    bytes[i + 1] = (state >>> 8) & 0xff
    bytes[i + 2] = (state >>> 16) & 0xff
    bytes[i + 3] = (state >>> 24) & 0xff
  }
  return bytes
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
