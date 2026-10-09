import { dataChannels } from '@dfs/bot/storage'
import { settleBlobs } from '@dfs/bot/testing'
import { ApiClient, createFolder, text, uploadFile, workspace } from '@dfs/contract'
import { storageChannels } from '@dfs/db'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { ChunkFrameLayout } from '@dfs/crypto'
import { DiscordBlobStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { setTimeout } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Reading back from Discord (DESIGN.md §6.2), over real HTTP: a ZIP of a
// folder of small files costs one CDN request per pack, not one per file, and
// nothing the second time; a download stalls with its client instead of
// fetching the whole file, stops fetching for one its client cancels, and
// finds a frame whose pack was compacted away mid-download. Attachments of
// 4 MiB make a large file out of little test data.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let client: ApiClient
const discord = new FakeDiscord()

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({
    DATABASE_URL: database.url,
    DISCORD_ATTACHMENT_LIMIT: '4 MiB',
    PACK_THRESHOLD_BYTES: '1 MiB',
  })
  cleanup = setup.cleanup
  // The bot's signing, without the bot: the URLs the uploads saved stay fresh here.
  app = await buildApp({
    config: setup.config,
    logger: false,
    blobStore: new DiscordBlobStore({
      rest: discord,
      channels: () => dataChannels(app.db),
      maxBytes: setup.config.sizes.blobMaxBytes,
      instanceId: () => Promise.resolve('0123456789ab'),
      perChannel: 2,
      fetch: discord.fetch,
    }),
  })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const channel = discord.addTextChannel('storage-00')
  await app.db.insert(storageChannels).values({ discordChannelId: channel.id, name: 'storage-00' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password', role: 'admin' })
  client = new ApiClient(address, setup.config.publicBaseUrl)
  await client.signIn('owner', 'the-owner-password')
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

describe('reading from Discord', () => {
  it('fetch each pack whole once, then come from the frame cache', async () => {
    const folder = await createFolder(client, (await workspace(client)).id, 'Small')
    const names = Array.from({ length: 20 }, (_, index) => `file-${String(index)}.txt`)
    for (const name of names)
      await uploadFile(client, folder.id, name, text(`${name}\n`.repeat(50)))
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    expect(discord.messages).toHaveLength(1)
    await app.frameCache?.idle()

    discord.cdnRequests = 0
    const first = await client.fetch('GET', `/folders/${folder.id}/archive`)
    const zip = Buffer.from(await first.arrayBuffer())
    for (const name of names) expect(zip.includes(Buffer.from(name))).toBe(true)
    expect(discord.cdnRequests).toBe(1)

    await app.frameCache?.idle()
    const second = await client.fetch('GET', `/folders/${folder.id}/archive`)
    expect(Buffer.from(await second.arrayBuffer()).equals(zip)).toBe(true)
    expect(discord.cdnRequests).toBe(1)
  })

  it('stalls a download with its client instead of fetching the whole file', async () => {
    const chunks = 10
    const bytes = new Uint8Array(chunks * app.config.sizes.chunkSize).map((_, index) => index % 251)
    const folder = await createFolder(client, (await workspace(client)).id, 'Large')
    const session = await uploadFile(client, folder.id, 'large.bin', bytes)
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })

    discord.cdnRequests = 0
    const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
      headers: { Range: 'bytes=0-' },
    })
    const body = response.body?.getReader()
    try {
      await body?.read()
      // The client stops reading. The connection's buffers take a few chunks
      // (how many depends on the OS), then the server must stop fetching too.
      await setTimeout(500)
      const stalled = discord.cdnRequests
      await setTimeout(500)
      expect(discord.cdnRequests).toBe(stalled)
      expect(stalled).toBeLessThan(chunks)
    } finally {
      await body?.cancel()
    }
  })

  /** A stored file of `chunks` whole chunks, never read yet. */
  async function storedFile(name: string, chunks: number) {
    const bytes = new Uint8Array(chunks * app.config.sizes.chunkSize).map((_, i) => i % 241)
    const folder = await createFolder(client, (await workspace(client)).id, name)
    const session = await uploadFile(client, folder.id, `${name}.bin`, bytes)
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    return { ...session, folderId: folder.id }
  }

  it('stops fetching for a download cancelled before its first byte, as a seek is', async () => {
    const session = await storedFile('Cancelled early', 4)
    discord.cdnRequests = 0
    discord.cdnAborted = 0
    discord.holdCdnFrom = 1
    try {
      const controller = new AbortController()
      const download = client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
        signal: controller.signal,
      })
      await vi.waitFor(() => {
        expect(discord.cdnRequests).toBe(1)
      })
      controller.abort()
      await expect(download).rejects.toThrow()
      await vi.waitFor(() => {
        expect(discord.cdnAborted).toBe(1)
      })
    } finally {
      discord.holdCdnFrom = Infinity
      discord.releaseCdn()
    }
    await setTimeout(200)
    expect(discord.cdnRequests).toBe(1)
    // Nothing given up on was cached: the next reader fetches it afresh.
    await app.frameCache?.idle()
    const again = await client.fetch('GET', `/files/${session.nodeId}/content`, {
      headers: { Range: 'bytes=0-9' },
    })
    expect((await again.arrayBuffer()).byteLength).toBe(10)
    expect(discord.cdnRequests).toBe(2)
  })

  it('stops what it reads ahead when its client cancels the download', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFile('Cancelled ahead', 6)
    discord.cdnRequests = 0
    discord.cdnAborted = 0
    // The first chunk comes; those read ahead wait.
    discord.holdCdnFrom = 2
    try {
      const controller = new AbortController()
      const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
        signal: controller.signal,
      })
      const body = response.body?.getReader()
      if (!body) throw new Error('No body.')
      // The whole first chunk taken, so the server reads ahead.
      for (let received = 0; received < chunkSize;) {
        const next = await body.read()
        if (next.done) throw new Error('The download ended early.')
        received += (next.value as Uint8Array).length
      }
      await vi.waitFor(() => {
        expect(discord.cdnRequests).toBe(3)
      })
      controller.abort()
      await vi.waitFor(() => {
        expect(discord.cdnAborted).toBe(2)
      })
    } finally {
      discord.holdCdnFrom = Infinity
      discord.releaseCdn()
    }
    await setTimeout(200)
    expect(discord.cdnRequests).toBe(3)
  })

  /** The bytes of a stored file of `chunks` chunks, for checking what comes back. */
  function contentOf(chunks: number): Uint8Array {
    return new Uint8Array(chunks * app.config.sizes.chunkSize).map((_, i) => i % 241)
  }

  /** Reads `response`'s body until it holds `bytes`, or fails after `ms`. */
  async function receive(
    body: ReadableStreamDefaultReader<Uint8Array>,
    bytes: number,
    ms = 3000,
  ): Promise<Uint8Array[]> {
    const received: Uint8Array[] = []
    let total = 0
    const deadline = Date.now() + ms
    while (total < bytes) {
      const next = await Promise.race([
        body.read(),
        setTimeout(Math.max(0, deadline - Date.now())).then(() => null),
      ])
      if (next === null) throw new Error(`Only ${String(total)} of ${String(bytes)} bytes came.`)
      if (next.done) break
      received.push(next.value)
      total += next.value.length
    }
    return received
  }

  it('streams a cold chunk: its first segment comes before the rest has arrived', async () => {
    const session = await storedFile('Streamed', 2)
    discord.cdnRequests = 0
    // The first frame is held after its header and first segment.
    discord.holdNextBodyAt = 14 + 256 * 1024 + 28
    try {
      const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
      })
      const body = response.body?.getReader()
      if (!body) throw new Error('No body.')
      const first = await receive(body, 256 * 1024)
      expect(Buffer.concat(first).subarray(0, 256 * 1024)).toEqual(
        Buffer.from(contentOf(2).subarray(0, 256 * 1024)),
      )
      // Nothing is read ahead until the client has taken a whole chunk.
      expect(discord.cdnRequests).toBe(1)
      discord.releaseCdn()
      const rest = await receive(body, 2 * app.config.sizes.chunkSize, 10_000)
      expect(Buffer.concat([...first, ...rest]).equals(Buffer.from(contentOf(2)))).toBe(true)
    } finally {
      discord.releaseCdn()
    }
  })

  it('asks the CDN for only the segments a range covers', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFile('Sought', 1)
    discord.cdnRanges.length = 0
    const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
      headers: { Range: 'bytes=300000-300099' },
    })
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(contentOf(1).subarray(300_000, 300_100)),
    )
    const layout = new ChunkFrameLayout(chunkSize)
    const start = layout.segmentStart(1)
    expect(discord.cdnRanges).toEqual([
      `bytes=${String(start)}-${String(start + layout.segmentLength(1) - 1)}`,
    ])
  })

  it('fails a range the CDN cuts short, rather than sending it as whole', async () => {
    const session = await storedFile('Cut', 1)
    // Before any segment is whole: nothing is sent.
    discord.cutNextBodyAt = 100_000
    const early = await client.fetch('GET', `/files/${session.nodeId}/content`, {
      headers: { Range: 'bytes=0-999' },
    })
    expect(early.status).toBeGreaterThanOrEqual(500)
    await early.body?.cancel()
    // After one: the download breaks off, short of its length.
    await app.frameCache?.clear()
    discord.cutNextBodyAt = 300_000
    const late = await client.fetch('GET', `/files/${session.nodeId}/content`)
    expect(late.status).toBe(200)
    await expect(late.arrayBuffer()).rejects.toThrow()
  })

  it('resumes a frame that moves mid-stream at its next segment, sending none twice', async () => {
    const session = await storedFile('Moving', 1)
    const store = app.blobStore as DiscordBlobStore
    discord.holdNextBodyAt = 14 + 256 * 1024 + 28 + 1000
    try {
      const response = await client.fetch('GET', `/files/${session.nodeId}/content`)
      const body = response.body?.getReader()
      if (!body) throw new Error('No body.')
      const first = await receive(body, 256 * 1024)

      // Moved as compaction moves it: posted again, the chunk pointed there,
      // the old message deleted.
      const { rows } = await app.db.execute<{
        id: number
        channel: string
        message: string
        size: number
      }>(sql`
        SELECT blob.id::float8 AS id, channel.discord_channel_id AS channel,
          blob.message_id AS message, blob.size_bytes AS size
        FROM chunks chunk JOIN blobs blob ON blob.id = chunk.blob_id
        JOIN storage_channels channel ON channel.id = blob.channel_id
        WHERE chunk.version_id = ${session.versionId}`)
      const old = rows[0]
      if (!old) throw new Error('No blob.')
      const attachment = discord.messages.find((message) => message.id === old.message)
        ?.attachments[0]?.url
      const data = attachment ? discord.cdn.get(attachment) : undefined
      if (!data) throw new Error('The blob isn’t in Discord.')
      const { rows: created } = await app.db.execute<{ id: number }>(sql`
        INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count)
        VALUES ('solo', 'building', ${old.size}, 0, 1) RETURNING id::float8 AS id`)
      const moved = created[0]?.id ?? 0
      const { location } = await store.put({ id: moved, kind: 'solo', frameCount: 1 }, () =>
        Promise.resolve(data),
      )
      await app.db.execute(sql`
        UPDATE blobs SET state = 'stored', stored_at = now(), live_bytes = ${old.size},
          channel_id = ${location.channelId}, message_id = ${location.messageId},
          attachment_id = ${location.attachmentId}
        WHERE id = ${moved}`)
      await app.db.execute(sql`UPDATE chunks SET blob_id = ${moved} WHERE blob_id = ${old.id}`)
      await app.db.execute(
        sql`UPDATE blobs SET state = 'deleted', live_bytes = 0 WHERE id = ${old.id}`,
      )
      await discord.delete(`/channels/${old.channel}/messages/${old.message}`)

      discord.cdnRanges.length = 0
      // The old read breaks off; the rest comes from the new place.
      discord.releaseCdn(true)
      const rest = await receive(body, app.config.sizes.chunkSize, 10_000)
      expect(Buffer.concat([...first, ...rest]).equals(Buffer.from(contentOf(1)))).toBe(true)
      const layout = new ChunkFrameLayout(app.config.sizes.chunkSize)
      expect(discord.cdnRanges).toEqual([
        `bytes=${String(layout.segmentStart(1))}-${String(app.config.sizes.chunkSize + 14 + layout.segments * 28 - 1)}`,
      ])
    } finally {
      discord.releaseCdn()
    }
  })

  it('reads the same bytes from a CDN that ignores Range and sends whole files', async () => {
    const session = await storedFile('Whole', 1)
    const folder = await createFolder(client, (await workspace(client)).id, 'Whole small')
    const content = 'small and packed, '.repeat(100)
    const small = await uploadFile(client, folder.id, 'small.txt', text(content))
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    await app.frameCache?.clear()
    discord.ignoreRange = true
    try {
      const middle = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=300000-300099' },
      })
      expect(Buffer.from(await middle.arrayBuffer())).toEqual(
        Buffer.from(contentOf(1).subarray(300_000, 300_100)),
      )
      const packed = await client.fetch('GET', `/files/${small.nodeId}/content`)
      expect(await packed.text()).toBe(content)
    } finally {
      discord.ignoreRange = false
    }
  })

  it('answers HEAD with the length, reading nothing from Discord', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFile('Headed', 2)
    discord.cdnRequests = 0
    const file = await client.fetch('HEAD', `/files/${session.nodeId}/content`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-length')).toBe(String(2 * chunkSize))
    const folder = await client.fetch('HEAD', `/folders/${session.folderId}/archive`)
    expect(folder.status).toBe(200)
    expect(Number(folder.headers.get('content-length'))).toBeGreaterThan(2 * chunkSize)
    await setTimeout(200)
    expect(discord.cdnRequests).toBe(0)
  })

  it('reads a frame where it is now when its pack was compacted away mid-download', async () => {
    const { chunkSize } = app.config.sizes
    // Large chunks of their own, and a small end packed (§6.6).
    const bytes = new Uint8Array(12 * chunkSize + 1000).map((_, index) => index % 249)
    const folder = await createFolder(client, (await workspace(client)).id, 'Moved')
    const session = await uploadFile(client, folder.id, 'moved.bin', bytes)
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    const { rows } = await app.db.execute<{
      id: number
      channel: string
      message: string
      frames: number
      size: number
    }>(sql`
      SELECT blob.id::float8 AS id, channel.discord_channel_id AS channel,
        blob.message_id AS message, blob.frame_count AS frames, blob.size_bytes AS size
      FROM chunks chunk JOIN blobs blob ON blob.id = chunk.blob_id
      JOIN storage_channels channel ON channel.id = blob.channel_id
      WHERE chunk.version_id = ${session.versionId} AND blob.kind = 'pack'`)
    const old = rows[0]
    if (!old) throw new Error('The end of the file wasn’t packed.')

    const response = await client.fetch('GET', `/files/${session.nodeId}/content`)
    const body = response.body?.getReader()
    if (!body) throw new Error('No body.')
    const received: Uint8Array[] = []
    const first = await body.read()
    if (first.value) received.push(first.value as Uint8Array)
    // The server stalls with its client, every chunk looked up, the end not read.
    await setTimeout(500)

    // Compacted as the bot does it: the frames posted again as another pack,
    // the chunks moved there, and the old message deleted.
    const attachment = discord.messages.find((message) => message.id === old.message)
      ?.attachments[0]?.url
    const data = attachment ? discord.cdn.get(attachment) : undefined
    if (!data) throw new Error('The old pack isn’t in Discord.')
    const { rows: created } = await app.db.execute<{ id: number }>(sql`
      INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count)
      VALUES ('pack', 'building', ${old.size}, 0, ${old.frames}) RETURNING id::float8 AS id`)
    const moved = created[0]?.id ?? 0
    const { location } = await store.put({ id: moved, kind: 'pack', frameCount: old.frames }, () =>
      Promise.resolve(data),
    )
    await app.db.execute(sql`
      UPDATE blobs SET state = 'stored', stored_at = now(), live_bytes = ${old.size},
        channel_id = ${location.channelId}, message_id = ${location.messageId},
        attachment_id = ${location.attachmentId}
      WHERE id = ${moved}`)
    await app.db.execute(sql`UPDATE chunks SET blob_id = ${moved} WHERE blob_id = ${old.id}`)
    await app.db.execute(
      sql`UPDATE blobs SET state = 'deleted', live_bytes = 0 WHERE id = ${old.id}`,
    )
    await discord.delete(`/channels/${old.channel}/messages/${old.message}`)

    for (;;) {
      const next = await body.read()
      if (next.done) break
      received.push(next.value as Uint8Array)
    }
    expect(Buffer.concat(received).equals(bytes)).toBe(true)
  })
})
