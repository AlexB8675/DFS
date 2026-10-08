import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import {
  sessionSchema,
  uploadBatchResultSchema,
  uploadStatusSchema,
  type UploadSession,
} from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// A file streamed in one request (DESIGN.md §6.1), over real HTTP: a stream
// can break off partway, which `app.inject` can't do.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let base: string
let origin: string

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  origin = setup.config.publicBaseUrl
  app = await buildApp({ config: setup.config, logger: false })
  base = await app.listen({ port: 0, host: '127.0.0.1' })
  for (const username of ['owner', 'other']) {
    await seedUser(app.db, { username, password: `the-${username}-password` })
  }
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

/** A signed-in user's headers: the session cookie, the CSRF token and the Origin. */
async function signIn(username: string): Promise<Record<string, string>> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: `the-${username}-password` }),
  })
  const { csrfToken } = sessionSchema.parse(await response.json())
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ')
  return { origin, cookie, 'x-csrf-token': csrfToken }
}

async function startUpload(headers: Record<string, string>, sizeBytes: number) {
  const { user } = sessionSchema.parse(
    await (await fetch(`${base}/api/auth/me`, { headers })).json(),
  )
  const response = await fetch(`${base}/api/uploads/batch`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      uploads: [
        {
          parentId: user.rootFolderId,
          name: `${crypto.randomUUID()}.bin`,
          sizeBytes,
          mimeType: 'application/octet-stream',
        },
      ],
    }),
  })
  const [result] = uploadBatchResultSchema.parse(await response.json()).results
  if (!result?.ok) throw new Error('Could not start the test upload.')
  return result.session
}

function stream(
  headers: Record<string, string>,
  session: UploadSession,
  from: number,
  body: RequestInit['body'],
): Promise<Response> {
  return fetch(`${base}/api/uploads/${session.uploadId}/content?from=${String(from)}`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body,
    duplex: 'half',
  })
}

async function received(headers: Record<string, string>, session: UploadSession) {
  const response = await fetch(`${base}/api/uploads/${session.uploadId}`, { headers })
  return uploadStatusSchema.parse(await response.json()).receivedParts
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A body that sends the first `bytes` of `data`, then fails, as a dropped connection does. */
function cutShort(data: Uint8Array, bytes: number): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.error(new Error('The connection dropped.'))
        return
      }
      sent = true
      controller.enqueue(data.slice(0, bytes))
    },
  })
}

describe('streamed uploads (§6.1)', () => {
  it('keeps the whole parts of a stream that broke off, and resumes after them', async () => {
    const owner = await signIn('owner')
    const { chunkSize } = app.config.sizes
    const bytes = new Uint8Array(chunkSize * 2 + 10).map((_, i) => i % 251)
    const session = await startUpload(owner, bytes.length)

    await expect(stream(owner, session, 0, cutShort(bytes, chunkSize * 1.5))).rejects.toThrow()
    // A part is hashed, sealed and written before it counts: some seconds, on a busy machine.
    const settled = { timeout: 10_000 }
    await vi.waitFor(async () => {
      expect(await received(owner, session)).toEqual([0])
    }, settled)
    // The part cut short left nothing behind in staging.
    await vi.waitFor(async () => {
      const staged = await readdir(path.join(app.staging.root, 'frames', session.versionId))
      expect(staged).toHaveLength(1)
    }, settled)

    const resumed = await stream(owner, session, 1, bytes.slice(chunkSize))
    expect(resumed.status).toBe(204)
    const partSha256 = await Promise.all(
      [0, 1, 2].map((index) => sha256Hex(bytes.slice(index * chunkSize, (index + 1) * chunkSize))),
    )
    const completed = await fetch(`${base}/api/uploads/${session.uploadId}/complete`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ partSha256 }),
    })
    expect(completed.status).toBe(204)
    const content = await fetch(`${base}/api/files/${session.nodeId}/content`, { headers: owner })
    expect(await sha256Hex(new Uint8Array(await content.arrayBuffer()))).toBe(
      await sha256Hex(bytes),
    )
  })

  it('takes a stream sent without its length, counting its bytes', async () => {
    const owner = await signIn('owner')
    const bytes = new Uint8Array(app.config.sizes.chunkSize + 5).map((_, i) => i % 7)
    const session = await startUpload(owner, bytes.length)
    const chunked = (data: Uint8Array) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data)
          controller.close()
        },
      })

    const longer = new Uint8Array(bytes.length + 1)
    longer.set(bytes)
    const refused = await stream(owner, session, 0, chunked(longer))
    expect(refused.status).toBe(400)
    const accepted = await stream(owner, session, 0, chunked(bytes))
    expect(accepted.status).toBe(204)
    expect(await received(owner, session)).toEqual([0, 1])
  })

  it('answers for another user’s upload as for one that doesn’t exist', async () => {
    const session = await startUpload(await signIn('owner'), 10)
    const response = await stream(await signIn('other'), session, 0, new Uint8Array(10))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'upload_not_found' } })
  })

  it('holds a stream, unread, while staging is full, and takes it once there is room', async () => {
    const owner = await signIn('owner')
    const session = await startUpload(owner, 10)
    const full = vi.spyOn(app.stagingLimit, 'isFull').mockResolvedValueOnce(true)
    try {
      const started = performance.now()
      const response = await stream(owner, session, 0, new Uint8Array(10))
      expect(response.status).toBe(204)
      // It looked again a poll later, and found room.
      expect(performance.now() - started).toBeGreaterThanOrEqual(1500)
      expect(await received(owner, session)).toEqual([0])
    } finally {
      full.mockRestore()
    }
  })
})
