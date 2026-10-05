import type { ServerResponse } from 'node:http'
import { storeAllStagedBlobs } from '@dfs/bot/uploader'
import { ApiClient, text, uploadFile, workspace } from '@dfs/contract'
import { notifyEvent } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { LocalBlobStore } from '@dfs/storage'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

let database: TestDatabase
let app: FastifyInstance
let address: string
let origin: string
let store: LocalBlobStore
let cleanup: () => Promise<void>
let eventStream: ServerResponse | null = null

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url === '/api/events') eventStream = reply.raw
    done()
  })
  address = await app.listen({ port: 0, host: '127.0.0.1' })
  origin = setup.config.publicBaseUrl
  store = new LocalBlobStore(setup.config.localBlobDir)
  await seedUser(app.db, {
    username: 'owner',
    password: 'the-owner-password',
    isOwner: true,
    role: 'admin',
  })
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

/** Reads SSE messages from a stream until `found` says stop. */
async function readEvents(
  response: Response,
  found: (type: string, data: unknown) => boolean,
): Promise<void> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader()
  if (!reader) throw new Error('No stream.')
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('The stream ended first.')
      buffer += value
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const message = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const type = /^event: (.+)$/m.exec(message)?.[1]
        const data = /^data: (.+)$/m.exec(message)?.[1]
        if (type && data && found(type, JSON.parse(data))) return
      }
    }
  } finally {
    await reader.cancel()
  }
}

describe('live events (§6.1)', () => {
  it('disconnects a stalled client instead of buffering more events', async () => {
    const client = new ApiClient(address, origin)
    const { user } = await client.signIn('owner', 'the-owner-password')
    const response = await client.fetch('GET', '/events')
    const stream = eventStream
    if (!stream) throw new Error('No server event stream.')
    const write = vi.spyOn(stream, 'write').mockReturnValueOnce(false)
    try {
      // A pg notification reaches the actual HTTP stream. Make its next write
      // signal backpressure, as it would when a client stops reading.
      // The first subscription connects lazily; wait until a notification reaches it.
      await vi.waitFor(
        async () => {
          await notifyEvent(app.db, {
            userId: user.id,
            type: 'nodes.changed',
            payload: { parentIds: [user.rootFolderId] },
          })
          expect(write).toHaveBeenCalled()
        },
        { timeout: 5000 },
      )
      await vi.waitFor(() => {
        expect(stream.destroyed).toBe(true)
      })
    } finally {
      write.mockRestore()
      await response.body?.cancel().catch(() => undefined)
    }
  })

  it('tells the owner when a file finishes syncing', async () => {
    const client = new ApiClient(address, origin)
    await client.signIn('owner', 'the-owner-password')
    const stream = await client.fetch('GET', '/events')
    expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/)

    const root = await workspace(client)
    const upload = await uploadFile(client, root.id, 'event.txt', text('hello'))
    const received = readEvents(stream, (type, data) => {
      if (type !== 'nodes.synced') return false
      expect(data).toEqual({
        nodes: [{ id: upload.nodeId, parentId: root.id, syncState: 'stored' }],
      })
      return true
    })
    await storeAllStagedBlobs({ db: app.db, staging: app.staging, store })
    await received
  })

  it('ends open streams when the server shuts down', async () => {
    const setup = await testConfig({ DATABASE_URL: database.url })
    const other = await buildApp({ config: setup.config, logger: false })
    const otherAddress = await other.listen({ port: 0, host: '127.0.0.1' })
    const client = new ApiClient(otherAddress, origin)
    await client.signIn('owner', 'the-owner-password')
    const stream = await client.fetch('GET', '/events')
    const started = Date.now()
    await other.close()
    expect(Date.now() - started).toBeLessThan(3000)
    await stream.body?.cancel().catch(() => undefined)
    await setup.cleanup()
  })

  it('refuses a stream without a session', async () => {
    const response = await new ApiClient(address, origin).fetch('GET', '/events')
    expect(response.status).toBe(401)
  })
})
