import { dataChannels } from '@dfs/bot/storage'
import { settleBlobs } from '@dfs/bot/testing'
import { ApiClient, createFolder, text, uploadFile, workspace } from '@dfs/contract'
import { storageChannels } from '@dfs/db'
import { playbackSchema } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { ChunkFrameLayout, chunkFrameLength } from '@dfs/crypto'
import { DiscordBlobStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { downloadableFile } from '../routes/content.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { ReadAheads } from './read-ahead.ts'
import { prefetchChunk, readSources, readVersion } from './reader.ts'

// Reading back from Discord (DESIGN.md §6.2), over real HTTP: a ZIP of a
// folder of small files costs one CDN request per pack, not one per file, and
// nothing the second time; a download stalls with its client instead of
// fetching the whole file, stops fetching for one its client cancels, and
// finds a frame whose pack was compacted away mid-download; a video's start and
// end are fetched as its player opens; and what a read waited on is counted by where
// its bytes came from: staging, the frame cache or Discord. Attachments of
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
      // Nothing is read ahead until the client has taken some of the chunk.
      expect(discord.cdnRequests).toBe(1)
      expect(app.downloads.now).toBe(1)
      discord.releaseCdn()
      const rest = await receive(body, 2 * app.config.sizes.chunkSize, 10_000)
      expect(Buffer.concat([...first, ...rest]).equals(Buffer.from(contentOf(2)))).toBe(true)
      // Counted as under way until its response closed.
      await vi.waitFor(() => {
        expect(app.downloads.now).toBe(0)
      })
    } finally {
      discord.releaseCdn()
    }
  })

  /** Bytes `from` to `to` of a file, as the browser gets them. */
  async function bytesOf(nodeId: string, from: number, to: number): Promise<Buffer> {
    const response = await client.fetch('GET', `/files/${nodeId}/content`, {
      headers: { Range: `bytes=${String(from)}-${String(to)}` },
    })
    return Buffer.from(await response.arrayBuffer())
  }

  it('reads a small range with the next segments, so the reads that follow find them kept', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Sought', 1)
    const content = Buffer.from(contentOf(1))
    discord.cdnRanges.length = 0
    expect(await bytesOf(session.nodeId, 300_000, 300_099)).toEqual(
      content.subarray(300_000, 300_100),
    )
    // Its segment, 1, and the three after it, in one request.
    expect(discord.cdnRanges).toEqual([
      `bytes=${String(layout.segmentStart(1))}-${String(layout.segmentStart(4) + layout.segmentLength(4) - 1)}`,
    ])
    await app.frameCache?.idle()
    const hits = app.frameCache?.stats.hits ?? 0
    // A PDF's next pages, and the same one again: from the cache.
    for (const at of [600_000, 1_000_000, 300_000]) {
      expect(await bytesOf(session.nodeId, at, at + 99)).toEqual(content.subarray(at, at + 100))
    }
    expect(discord.cdnRanges).toHaveLength(1)
    expect((app.frameCache?.stats.hits ?? 0) - hits).toBe(3)
  })

  it('reads nothing past its chunk for a seek left before its client took much of it', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Played', 2)
    discord.cdnRanges.length = 0
    const from = Math.floor(chunkSize / 2)
    // Two segments come, less than half of what the seek wants of its chunk.
    discord.holdNextBodyAt = 2 * layout.segmentLength(0)
    try {
      const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: `bytes=${String(from)}-` },
      })
      const body = response.body?.getReader()
      if (!body) throw new Error('No body.')
      await receive(body, 100_000)
      await body.cancel()
    } finally {
      discord.releaseCdn()
    }
    await setTimeout(200)
    // From the seek's segment to the end of the first chunk, and no further.
    expect(discord.cdnRanges).toEqual([
      `bytes=${String(layout.segmentStart(layout.segmentOf(from)))}-${String(chunkFrameLength(chunkSize) - 1)}`,
    ])
  })

  it('reads the next chunk once its client has taken half of what a seek wants of the first', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Played on', 3)
    discord.cdnRanges.length = 0
    const from = Math.floor(chunkSize / 2)
    const first = layout.segmentOf(from)
    // Five segments come, more than half of what the seek wants of its chunk, then it holds.
    discord.holdNextBodyAt = 5 * layout.segmentLength(0)
    try {
      const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: `bytes=${String(from)}-` },
      })
      const body = response.body?.getReader()
      if (!body) throw new Error('No body.')
      const taken = await receive(body, layout.plaintextStart(first + 5) - from)
      // The next chunk is under way while the first still waits on Discord.
      await vi.waitFor(() => {
        expect(discord.cdnRanges).toHaveLength(2)
      })
      expect(discord.cdnRanges[1]).toBe(`bytes=0-${String(chunkFrameLength(chunkSize) - 1)}`)
      discord.releaseCdn()
      const rest = await receive(body, 3 * chunkSize - from, 10_000)
      expect(
        Buffer.concat([...taken, ...rest]).equals(Buffer.from(contentOf(3).subarray(from))),
      ).toBe(true)
    } finally {
      discord.releaseCdn()
    }
  })

  it('shares a segment two readers want at once, fetching it once', async () => {
    const session = await storedFile('Shared', 1)
    const content = Buffer.from(contentOf(1))
    discord.cdnRequests = 0
    // The first reader's request is held, so the second asks while it is under way.
    discord.holdNextBodyAt = 1000
    try {
      const first = bytesOf(session.nodeId, 300_000, 300_099)
      await vi.waitFor(() => {
        expect(discord.cdnRequests).toBe(1)
      })
      const second = bytesOf(session.nodeId, 300_200, 300_299)
      await setTimeout(100)
      discord.releaseCdn()
      expect(await first).toEqual(content.subarray(300_000, 300_100))
      expect(await second).toEqual(content.subarray(300_200, 300_300))
      expect(discord.cdnRequests).toBe(1)
    } finally {
      discord.releaseCdn()
    }
  })

  it('doesn’t wait behind a fetch far from the segment it wants, and shares one close to it', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Far and near', 1)
    const content = Buffer.from(contentOf(1))
    discord.cdnRanges.length = 0
    // A whole-chunk read, its CDN body held after the header and the first segment.
    discord.holdNextBodyAt = 14 + layout.segmentLength(0)
    try {
      const whole = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
      })
      const body = whole.body?.getReader()
      if (!body) throw new Error('No body.')
      await receive(body, layout.plaintextSize(0))
      // Far ahead of where that fetch has got to: a request of its own, answered now.
      const far = layout.plaintextStart(10)
      expect(await bytesOf(session.nodeId, far, far + 99)).toEqual(content.subarray(far, far + 100))
      expect(discord.cdnRanges[1]).toMatch(new RegExp(`^bytes=${String(layout.segmentStart(10))}-`))
      // Close to it: shared, no request of its own; it comes once the fetch goes on.
      const near = layout.plaintextStart(2)
      const shared = bytesOf(session.nodeId, near, near + 99)
      await setTimeout(200)
      expect(discord.cdnRanges).toHaveLength(2)
      discord.releaseCdn()
      expect(await shared).toEqual(content.subarray(near, near + 100))
      await body.cancel()
    } finally {
      discord.releaseCdn()
    }
  })

  it('shares the whole of a fetch under way from where a read starts close to it', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Whole and near', 1)
    const content = Buffer.from(contentOf(1))
    discord.cdnRanges.length = 0
    // A whole-chunk read, its CDN body held after the header and the first segment.
    discord.holdNextBodyAt = 14 + layout.segmentLength(0)
    try {
      const whole = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
      })
      const body = whole.body?.getReader()
      if (!body) throw new Error('No body.')
      await receive(body, layout.plaintextSize(0))
      // Starting where that fetch has got to, to the chunk's end: all of it is shared.
      const from = layout.plaintextStart(1)
      const onward = bytesOf(session.nodeId, from, chunkSize - 1)
      await setTimeout(200)
      expect(discord.cdnRanges).toHaveLength(1)
      discord.releaseCdn()
      expect(await onward).toEqual(content.subarray(from, chunkSize))
      expect(discord.cdnRanges).toHaveLength(1)
      await body.cancel()
    } finally {
      discord.releaseCdn()
    }
  })

  it('doesn’t share a far fetch through segments the cache holds', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Kept then far', 1)
    const content = Buffer.from(contentOf(1))
    // The first twelve segments kept on their own, by a read that ends before the chunk does.
    await bytesOf(session.nodeId, 0, layout.plaintextStart(12) - 1)
    await app.frameCache?.idle()
    const [chunk] = (
      await app.db.execute<{ frame_sha256: Buffer }>(sql`
        SELECT frame_sha256 FROM chunks WHERE version_id = ${session.versionId}`)
    ).rows
    if (!chunk) throw new Error('No chunk.')
    let kept = 0
    while (app.frameCache?.hasSegment(chunk.frame_sha256, kept)) kept += 1
    expect(kept).toBeGreaterThanOrEqual(10)
    // A chunk mostly kept isn't fetched whole, so to have a whole-chunk fetch under way with
    // these kept too, they go from the cache now and come back once it has started.
    const cache = app.frameCache
    if (!cache) throw new Error('No frame cache.')
    const segments = await Promise.all(
      Array.from({ length: kept }, (_, index) => cache.segment(chunk.frame_sha256, index)),
    )
    await cache.clear()
    discord.cdnRanges.length = 0
    // A whole-chunk read, its CDN body held after the header and the first segment.
    discord.holdNextBodyAt = 14 + layout.segmentLength(0)
    try {
      const whole = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
      })
      const held = whole.body?.getReader()
      if (!held) throw new Error('No body.')
      await receive(held, layout.plaintextSize(0))
      segments.forEach((bytes, index) => {
        if (bytes) cache.putSegment(chunk.frame_sha256, index, bytes)
      })
      await cache.idle()
      expect(cache.hasSegment(chunk.frame_sha256, kept - 1)).toBe(true)
      // The same chunk from its start to its end: the kept segments from the cache, and the
      // first that isn't kept is far from the fetch under way, so it is fetched on its own.
      const all = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: `bytes=0-${String(chunkSize - 1)}` },
      })
      const body = all.body?.getReader()
      if (!body) throw new Error('No body.')
      const received = await receive(body, chunkSize)
      expect(Buffer.concat(received).equals(content)).toBe(true)
      expect(discord.cdnRanges).toHaveLength(2)
      expect(discord.cdnRanges[1]).toMatch(
        new RegExp(`^bytes=${String(layout.segmentStart(kept))}-`),
      )
      await held.cancel()
    } finally {
      discord.releaseCdn()
    }
  })

  it('keeps a far fetch shared after a read that fetched over part of it is cancelled', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Far then cancelled', 1)
    const content = Buffer.from(contentOf(1))
    discord.cdnRequests = 0
    discord.cdnAborted = 0
    // The second request, the far read's own, is held; the first is a whole-chunk read's,
    // its CDN body held after the header and the first segment.
    discord.holdCdnFrom = 2
    discord.holdNextBodyAt = 14 + layout.segmentLength(0)
    try {
      const whole = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
      })
      const held = whole.body?.getReader()
      if (!held) throw new Error('No body.')
      await receive(held, layout.plaintextSize(0))
      const controller = new AbortController()
      const far = client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: `bytes=${String(layout.plaintextStart(10))}-` },
        signal: controller.signal,
      })
      await vi.waitFor(() => {
        expect(discord.cdnRequests).toBe(2)
      })
      // Cancelled, as a scrub leaves a seek: its fetch ends, the one it fetched over goes on.
      controller.abort()
      await expect(far).rejects.toThrow()
      await vi.waitFor(() => {
        expect(discord.cdnAborted).toBe(1)
      })
      await setTimeout(100)
      const from = layout.plaintextStart(2)
      const onward = bytesOf(session.nodeId, from, chunkSize - 1)
      await setTimeout(200)
      // Everything of it is shared with the fetch under way: no request of its own.
      expect(discord.cdnRequests).toBe(2)
      discord.releaseCdn()
      expect(await onward).toEqual(content.subarray(from, chunkSize))
      await held.cancel()
    } finally {
      discord.holdCdnFrom = Infinity
      discord.releaseCdn()
    }
  })

  it('fetches again a kept segment that fails its tag', async () => {
    const session = await storedFile('Spoiled', 1)
    const content = Buffer.from(contentOf(1))
    expect(await bytesOf(session.nodeId, 300_000, 300_099)).toEqual(
      content.subarray(300_000, 300_100),
    )
    await app.frameCache?.idle()
    // Spoil the kept segment on disk.
    const [chunk] = (
      await app.db.execute<{ frame_sha256: Buffer }>(sql`
        SELECT frame_sha256 FROM chunks WHERE version_id = ${session.versionId}`)
    ).rows
    if (!chunk) throw new Error('No chunk.')
    const hex = chunk.frame_sha256.toString('hex')
    const file = path.join(app.config.cacheDir, hex.slice(0, 2), `${hex}-1.frame`)
    const kept = await readFile(file)
    kept[100] = (kept[100] ?? 0) ^ 1
    await writeFile(file, kept)
    discord.cdnRequests = 0
    expect(await bytesOf(session.nodeId, 300_000, 300_099)).toEqual(
      content.subarray(300_000, 300_100),
    )
    expect(discord.cdnRequests).toBe(1)
  })

  it('keeps a frame read whole in place of its segments', async () => {
    const session = await storedFile('Replaced', 1)
    const content = Buffer.from(contentOf(1))
    await bytesOf(session.nodeId, 300_000, 300_099)
    await app.frameCache?.idle()
    const [chunk] = (
      await app.db.execute<{ frame_sha256: Buffer }>(sql`
        SELECT frame_sha256 FROM chunks WHERE version_id = ${session.versionId}`)
    ).rows
    if (!chunk) throw new Error('No chunk.')
    const hex = chunk.frame_sha256.toString('hex')
    const shard = path.join(app.config.cacheDir, hex.slice(0, 2))
    expect((await readdir(shard)).filter((name) => name.startsWith(`${hex}-`))).toHaveLength(4)
    const whole = await client.fetch('GET', `/files/${session.nodeId}/content`)
    expect(Buffer.from(await whole.arrayBuffer()).equals(content)).toBe(true)
    await app.frameCache?.idle()
    await vi.waitFor(async () => {
      expect((await readdir(shard)).filter((name) => name.startsWith(hex))).toEqual([
        `${hex}.frame`,
      ])
    })
  })

  it('reads a chunk whose segments are all kept from the cache, fetching nothing', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('All kept', 1)
    const content = Buffer.from(contentOf(1))
    const sha = await frameOf(session.versionId, 0)
    // Two reads, neither of the whole chunk, keep every segment on its own: the first
    // its first eight, the second the rest.
    await bytesOf(session.nodeId, 0, layout.plaintextStart(8) - 1)
    await app.frameCache?.idle()
    let first = 0
    while (app.frameCache?.hasSegment(sha, first)) first += 1
    expect(first).toBeLessThan(layout.segments)
    await bytesOf(session.nodeId, layout.plaintextStart(first), chunkSize - 1)
    await app.frameCache?.idle()
    for (let index = 0; index < layout.segments; index += 1) {
      expect(app.frameCache?.hasSegment(sha, index)).toBe(true)
    }
    expect(app.frameCache?.has(sha)).toBe(false)
    // The whole chunk read, as a stream reading ahead does: nothing is fetched to keep it as one frame.
    discord.cdnRequests = 0
    expect(await bytesOf(session.nodeId, 0, chunkSize - 1)).toEqual(content)
    expect(discord.cdnRequests).toBe(0)
  })

  it('fetches only the missing segments of a chunk mostly kept', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Mostly kept', 1)
    const content = Buffer.from(contentOf(1))
    const sha = await frameOf(session.versionId, 0)
    const kept = 10
    expect(kept * 2).toBeGreaterThanOrEqual(layout.segments)
    expect(kept).toBeLessThan(layout.segments)
    await bytesOf(session.nodeId, 0, layout.plaintextStart(kept) - 1)
    await app.frameCache?.idle()
    for (let index = 0; index < layout.segments; index += 1) {
      expect(app.frameCache?.hasSegment(sha, index)).toBe(index < kept)
    }
    discord.cdnRanges.length = 0
    expect(await bytesOf(session.nodeId, 0, chunkSize - 1)).toEqual(content)
    // One request, from the first segment that wasn't kept: not the whole chunk again.
    expect(discord.cdnRanges).toHaveLength(1)
    expect(discord.cdnRanges[0]).toMatch(new RegExp(`^bytes=${String(layout.segmentStart(kept))}-`))
    // Those it fetched are kept too, so the chunk is read from the cache after.
    await app.frameCache?.idle()
    for (let index = 0; index < layout.segments; index += 1) {
      expect(app.frameCache?.hasSegment(sha, index)).toBe(true)
    }
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

  it('fetches a video’s start and end into the cache as its player opens, once', async () => {
    const { chunkSize } = app.config.sizes
    const bytes = new Uint8Array(Math.floor(2.5 * chunkSize)).map((_, i) => i % 239)
    const folder = await createFolder(client, (await workspace(client)).id, 'Film')
    const session = await uploadFile(client, folder.id, 'film.mp4', bytes)
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })

    discord.cdnRanges.length = 0
    await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
    // The first chunk, whole; the last 4 MiB: the end of the second chunk, and
    // the third, its last megabyte on a request of its own.
    await vi.waitFor(() => {
      expect(discord.cdnRanges).toHaveLength(4)
    })
    expect(discord.cdnRanges).toContain(`bytes=0-${String(chunkFrameLength(chunkSize) - 1)}`)
    const middle = new ChunkFrameLayout(chunkSize)
    const endOfMiddle = middle.segmentOf(bytes.length - 4 * 1024 * 1024 - chunkSize)
    expect(discord.cdnRanges).toContain(
      `bytes=${String(middle.segmentStart(endOfMiddle))}-${String(chunkFrameLength(chunkSize) - 1)}`,
    )
    const lastChunk = bytes.length - 2 * chunkSize
    const layout = new ChunkFrameLayout(lastChunk)
    expect(discord.cdnRanges).toContain(
      `bytes=${String(layout.segmentStart(0))}-${String(layout.segmentStart(layout.segments - 4) - 1)}`,
    )
    // The index, the last megabyte, is asked for first.
    expect(discord.cdnRanges[0]).toBe(
      `bytes=${String(layout.segmentStart(layout.segments - 4))}-${String(chunkFrameLength(lastChunk) - 1)}`,
    )
    // Fetched, and kept once written.
    await setTimeout(300)
    await app.frameCache?.idle()
    // Opened again: it is kept, so nothing more is fetched.
    await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
    await setTimeout(200)
    expect(discord.cdnRanges).toHaveLength(4)

    // The browser's first read comes from the cache, as does its look at the end for the index.
    discord.cdnRanges.length = 0
    const size = bytes.length
    expect(await bytesOf(session.nodeId, 0, 65_535)).toEqual(Buffer.from(bytes.subarray(0, 65_536)))
    expect(await bytesOf(session.nodeId, size - 100_000, size - 1)).toEqual(
      Buffer.from(bytes.subarray(size - 100_000)),
    )
    expect(await bytesOf(session.nodeId, size - 3_000_000, size - 2_900_000)).toEqual(
      Buffer.from(bytes.subarray(size - 3_000_000, size - 2_900_000 + 1)),
    )
    expect(discord.cdnRanges).toEqual([])
  })

  it('warms a one-chunk video’s index first, then the rest of it', async () => {
    const { chunkSize } = app.config.sizes
    const size = Math.floor(0.8 * chunkSize)
    const bytes = new Uint8Array(size).map((_, i) => i % 233)
    const folder = await createFolder(client, (await workspace(client)).id, 'Short film')
    const session = await uploadFile(client, folder.id, 'short.mp4', bytes)
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    const layout = new ChunkFrameLayout(size)

    discord.cdnRanges.length = 0
    await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
    await vi.waitFor(() => {
      expect(discord.cdnRanges).toHaveLength(2)
    })
    // The index on a request of its own (planned first), and the rest on another: never whole.
    expect(discord.cdnRanges[0]).toBe(
      `bytes=${String(layout.segmentStart(layout.segments - 4))}-${String(chunkFrameLength(size) - 1)}`,
    )
    expect(discord.cdnRanges[1]).toBe(
      `bytes=${String(layout.segmentStart(0))}-${String(layout.segmentStart(layout.segments - 4) - 1)}`,
    )
    expect(discord.cdnRanges).not.toContain(`bytes=0-${String(chunkFrameLength(size) - 1)}`)
    await setTimeout(300)
    await app.frameCache?.idle()

    // Its head and its end both come from the cache, with no request.
    discord.cdnRanges.length = 0
    expect(await bytesOf(session.nodeId, 0, 65_535)).toEqual(Buffer.from(bytes.subarray(0, 65_536)))
    expect(await bytesOf(session.nodeId, size - 100_000, size - 1)).toEqual(
      Buffer.from(bytes.subarray(size - 100_000)),
    )
    expect(discord.cdnRanges).toEqual([])
  })

  /** A stored video of `size` bytes, never read yet, and its bytes. */
  async function storedFilm(name: string, size: number) {
    const bytes = new Uint8Array(size).map((_, i) => i % 229)
    const folder = await createFolder(client, (await workspace(client)).id, name)
    const session = await uploadFile(client, folder.id, `${name}.mp4`, bytes)
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    return { ...session, bytes }
  }

  it('warms nothing of a video the cache wouldn’t keep', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFilm('Film unkept', Math.floor(2.5 * chunkSize))
    if (!app.frameCache) throw new Error('No frame cache.')
    discord.cdnRanges.length = 0
    const canKeep = vi.spyOn(app.frameCache, 'canKeep').mockReturnValue(false)
    try {
      await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
      // Neither its end nor its first chunk: nothing is fetched to be thrown away.
      await setTimeout(400)
      expect(discord.cdnRanges).toEqual([])
    } finally {
      canKeep.mockRestore()
    }
    // Room again: opened once more, it is fetched.
    await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
    await vi.waitFor(() => {
      expect(discord.cdnRanges).toHaveLength(4)
    })
  })

  it('takes from the read budget only what a warm of the end holds', async () => {
    const { chunkSize } = app.config.sizes
    const size = Math.floor(2.5 * chunkSize)
    const session = await storedFilm('Film budget', size)
    // What the end's runs keep: the segments of chunk 1 from the last 4 MiB's start,
    // and all of chunk 2's. Chunk 0's whole frame would need more than is left.
    const heldFrom = (layout: ChunkFrameLayout, first: number) =>
      Array.from({ length: layout.segments - first }, (_, i) =>
        layout.segmentLength(first + i),
      ).reduce((total, length) => total + length, 0)
    const middle = new ChunkFrameLayout(chunkSize)
    const lastChunk = size - 2 * chunkSize
    const last = new ChunkFrameLayout(lastChunk)
    const held =
      heldFrom(middle, middle.segmentOf(size - 4 * 1024 * 1024 - chunkSize)) + heldFrom(last, 0)
    // The old claim, a whole frame for each end chunk, wouldn't fit in this.
    const room = held + 1024
    expect(room).toBeLessThan(chunkFrameLength(chunkSize) + chunkFrameLength(lastChunk))
    const taken = app.readBudget?.tryTake(256 * 1024 * 1024 - room)
    if (!taken) throw new Error('The read budget is in use.')
    discord.cdnRanges.length = 0
    try {
      await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
      // The end of chunk 1, and chunk 2's index and the rest; chunk 0 has no room.
      await vi.waitFor(() => {
        expect(discord.cdnRanges).toHaveLength(3)
      })
      await setTimeout(300)
      expect(discord.cdnRanges).toHaveLength(3)
      expect(discord.cdnRanges).not.toContain(`bytes=0-${String(chunkFrameLength(chunkSize) - 1)}`)
      // Given back once its fetches are over.
      await app.frameCache?.idle()
      const again = app.readBudget?.tryTake(room)
      expect(again).toBeTruthy()
      again?.()
    } finally {
      taken()
    }
  })

  it('warms a chunk it fetches whole only with room for twice its frame', async () => {
    // Under a megabyte, four segments or fewer: its one chunk is fetched whole, not by parts.
    const size = 700_000
    const frame = chunkFrameLength(size)
    const session = await storedFilm('Film tiny', size)
    const taken = app.readBudget?.tryTake(256 * 1024 * 1024 - Math.ceil(1.5 * frame))
    if (!taken) throw new Error('The read budget is in use.')
    discord.cdnRanges.length = 0
    try {
      await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
      await setTimeout(400)
      expect(discord.cdnRanges).toEqual([])
    } finally {
      taken()
    }
    // Room again: opened once more, it is fetched.
    await client.call('GET', `/files/${session.nodeId}/playback`, playbackSchema)
    await vi.waitFor(() => {
      expect(discord.cdnRanges).toEqual([`bytes=0-${String(frame - 1)}`])
    })
  })

  /** The SHA-256 of the frame of chunk `idx` of a version, which is what the cache keeps it under. */
  async function frameOf(versionId: string, idx: number): Promise<Buffer> {
    const [chunk] = (
      await app.db.execute<{ frame_sha256: Buffer }>(sql`
        SELECT frame_sha256 FROM chunks WHERE version_id = ${versionId} AND idx = ${idx}`)
    ).rows
    if (!chunk) throw new Error('No chunk.')
    return chunk.frame_sha256
  }

  it('fetches a chunk ahead whole into the cache, once', async () => {
    const session = await storedFile('Ahead', 2)
    const file = await downloadableFile(app.db, session.nodeId)
    discord.cdnRanges.length = 0
    expect(await prefetchChunk(app, file, 1, new AbortController().signal)).toBe('fetched')
    expect(discord.cdnRanges).toHaveLength(1)
    await app.frameCache?.idle()
    expect(app.frameCache?.has(await frameOf(session.versionId, 1))).toBe(true)
    expect(await prefetchChunk(app, file, 1, new AbortController().signal)).toBe('kept')
    expect(discord.cdnRanges).toHaveLength(1)
  })

  it('two fetches ahead of one chunk at once fetch it once', async () => {
    const session = await storedFile('Ahead twice', 1)
    const file = await downloadableFile(app.db, session.nodeId)
    discord.cdnRanges.length = 0
    const signal = new AbortController().signal
    const [first, second] = await Promise.all([
      prefetchChunk(app, file, 0, signal),
      prefetchChunk(app, file, 0, signal),
    ])
    expect([first, second].sort()).toEqual(['fetched', 'kept'])
    expect(discord.cdnRanges).toHaveLength(1)
  })

  it('shares a client’s fetch under way with a fetch ahead of the same chunk', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Ahead beside a read', 1)
    const file = await downloadableFile(app.db, session.nodeId)
    discord.cdnRequests = 0
    // The client's read comes through the content routes, the fetch ahead (a window's, or a
    // video's warm start) through the API's own: they still share what is under way, as
    // every read of the API does, whichever of its routes made it.
    discord.holdNextBodyAt = 14 + layout.segmentLength(0)
    let body: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const whole = await client.fetch('GET', `/files/${session.nodeId}/content`, {
        headers: { Range: 'bytes=0-' },
      })
      body = whole.body?.getReader()
      if (!body) throw new Error('No body.')
      const first = await receive(body, layout.plaintextSize(0))
      await prefetchChunk(app, file, 0, new AbortController().signal)
      expect(discord.cdnRequests).toBe(1)
      discord.releaseCdn()
      const rest = await receive(body, chunkSize, 10_000)
      expect(Buffer.concat([...first, ...rest]).equals(Buffer.from(contentOf(1)))).toBe(true)
    } finally {
      discord.releaseCdn()
      await body?.cancel().catch(() => undefined)
    }
  })

  it('fetches nothing ahead for a chunk still syncing, or without room in the read budget', async () => {
    const signal = new AbortController().signal
    const session = await storedFile('Ahead without room', 1)
    const stored = await downloadableFile(app.db, session.nodeId)
    // An upload not settled, which `storedFile` would do: its chunk is in staging.
    const folder = await createFolder(client, (await workspace(client)).id, 'Ahead syncing')
    const syncing = await uploadFile(
      client,
      folder.id,
      'syncing.bin',
      new Uint8Array(300_000).map((_, i) => i % 233),
    )
    const staged = await downloadableFile(app.db, syncing.nodeId)
    discord.cdnRanges.length = 0
    expect(await prefetchChunk(app, staged, 0, signal)).toBe('skipped')
    const giveBack = app.readBudget?.tryTake(256 * 1024 * 1024)
    try {
      expect(await prefetchChunk(app, stored, 0, signal)).toBe('busy')
    } finally {
      giveBack?.()
    }
    expect(discord.cdnRanges).toHaveLength(0)
    // Room again, the same chunk is fetched.
    expect(await prefetchChunk(app, stored, 0, signal)).toBe('fetched')
  })

  it('counts a chunk fetched ahead whole at twice its frame in the read budget', async () => {
    const { chunkSize } = app.config.sizes
    const frame = chunkFrameLength(chunkSize)
    const budget = 256 * 1024 * 1024
    const session = await storedFile('Ahead counted twice', 1)
    const file = await downloadableFile(app.db, session.nodeId)
    const signal = new AbortController().signal
    discord.cdnRequests = 0
    // While it runs it holds the frame it fetches and, until that is the cache's, every
    // segment it has opened: about two frames, which is what it takes.
    let taken = app.readBudget?.tryTake(budget - Math.ceil(1.5 * frame))
    if (!taken) throw new Error('The read budget is in use.')
    try {
      expect(await prefetchChunk(app, file, 0, signal)).toBe('busy')
      expect(discord.cdnRequests).toBe(0)
      taken()
      taken = app.readBudget?.tryTake(budget - 2 * frame)
      if (!taken) throw new Error('The read budget is in use.')
      expect(await prefetchChunk(app, file, 0, signal)).toBe('fetched')
      expect(discord.cdnRequests).toBe(1)
    } finally {
      taken?.()
    }
  })

  it('reads the next chunk ahead of a download only with room for twice its frame', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const frame = chunkFrameLength(chunkSize)
    const budget = 256 * 1024 * 1024
    // Ten segments of the first chunk come, more than the client needs to take to start the
    // next chunk's read, then its CDN body holds.
    const ahead = async (name: string, left: number) => {
      const session = await storedFile(name, 3)
      const taken = app.readBudget?.tryTake(budget - left)
      if (!taken) throw new Error('The read budget is in use.')
      discord.cdnRequests = 0
      discord.holdNextBodyAt = 14 + 10 * layout.segmentLength(0)
      try {
        const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
          headers: { Range: 'bytes=0-' },
        })
        const body = response.body?.getReader()
        if (!body) throw new Error('No body.')
        const first = await receive(body, 2.5 * 1024 * 1024)
        await setTimeout(300)
        const requests = discord.cdnRequests
        // Read to its end, whole: nothing is left held or cancelled.
        discord.releaseCdn()
        const rest = await receive(body, 3 * chunkSize, 10_000)
        const bytes = [...first, ...rest].reduce((total, piece) => total + piece.length, 0)
        expect(bytes).toBe(3 * chunkSize)
        return requests
      } finally {
        discord.releaseCdn()
        taken()
      }
    }
    // Room for 1.5 frames: the chunk after is read once the first has been sent.
    expect(await ahead('Read ahead short', Math.ceil(1.5 * frame))).toBe(1)
    // For two, it is read at once.
    expect(await ahead('Read ahead roomy', 2 * frame)).toBe(2)
  })

  it('fetches nothing ahead the cache wouldn’t keep', async () => {
    const session = await storedFile('Ahead unkept', 1)
    const stored = await downloadableFile(app.db, session.nodeId)
    discord.cdnRanges.length = 0
    if (!app.frameCache) throw new Error('No frame cache.')
    const canKeep = vi.spyOn(app.frameCache, 'canKeep').mockReturnValue(false)
    try {
      expect(await prefetchChunk(app, stored, 0, new AbortController().signal)).toBe('busy')
    } finally {
      canKeep.mockRestore()
    }
    expect(discord.cdnRanges).toHaveLength(0)
  })

  it('gives up a chunk fetched ahead when its signal aborts, caching nothing', async () => {
    const session = await storedFile('Ahead aborted', 1)
    const file = await downloadableFile(app.db, session.nodeId)
    discord.cdnRequests = 0
    discord.cdnAborted = 0
    discord.holdCdnFrom = 1
    try {
      const controller = new AbortController()
      const fetching = prefetchChunk(app, file, 0, controller.signal)
      await vi.waitFor(() => {
        expect(discord.cdnRequests).toBe(1)
      })
      controller.abort()
      expect(await fetching).toBe('failed')
      await vi.waitFor(() => {
        expect(discord.cdnAborted).toBe(1)
      })
    } finally {
      discord.holdCdnFrom = Infinity
      discord.releaseCdn()
    }
    await app.frameCache?.idle()
    expect(app.frameCache?.has(await frameOf(session.versionId, 0))).toBe(false)
    // Its read budget came back: the chunk is fetched ahead again.
    expect(await prefetchChunk(app, file, 0, new AbortController().signal)).toBe('fetched')
  })

  it('reads ahead of a stream across its requests, into the cache', async () => {
    const { chunkSize } = app.config.sizes
    const chunks = 8
    const session = await storedFilm('Film ahead', chunks * chunkSize)
    const play = crypto.randomUUID()
    // 2.5 MiB, read whole: a run the window follows, and a read that never reaches past its range.
    const sent = 2.5 * 1024 * 1024
    // Four times what the run sent, in whole chunks, after the one it is in.
    const n = Math.ceil((4 * sent) / chunkSize)
    expect(n + 1).toBeLessThan(chunks)

    discord.cdnRequests = 0
    const first = await client.fetch('GET', `/files/${session.nodeId}/content?play=${play}`, {
      headers: { Range: `bytes=0-${String(sent - 1)}` },
    })
    expect(Buffer.from(await first.arrayBuffer())).toEqual(
      Buffer.from(session.bytes.subarray(0, sent)),
    )
    await vi.waitFor(
      async () => {
        await app.frameCache?.idle()
        for (let index = 1; index <= n; index++) {
          expect(app.frameCache?.has(await frameOf(session.versionId, index))).toBe(true)
        }
      },
      { timeout: 5000 },
    )
    // Nothing past the window. The read made one request, for its chunk; the window made one
    // for each chunk it holds, whole.
    await setTimeout(500)
    expect(discord.cdnRequests).toBe(1 + n)
    const past = await frameOf(session.versionId, n + 1)
    expect(app.frameCache?.has(past)).toBe(false)
    expect(app.frameCache?.hasSegment(past, 0)).toBe(false)

    // The play reads on at chunk 2, where the cache holds it: the right bytes, nothing from Discord.
    const from = 2 * chunkSize
    const next = await client.fetch('GET', `/files/${session.nodeId}/content?play=${play}`, {
      headers: { Range: `bytes=${String(from)}-${String(from + 99_999)}` },
    })
    expect(Buffer.from(await next.arrayBuffer())).toEqual(
      Buffer.from(session.bytes.subarray(from, from + 100_000)),
    )
    expect(discord.cdnRequests).toBe(1 + n)

    // The stream session's timeline says what was read ahead: each chunk the window fetched, once.
    let ahead: { type: string; from: number; bytes: number; ms: number; outcome: string }[] = []
    await vi.waitFor(async () => {
      await app.streamSessions.flush()
      const { rows } = await app.db.execute<{
        events: { type: string; from: number; bytes: number; ms: number; outcome: string }[]
      }>(sql`
        SELECT b.events FROM timeline_batches b JOIN timelines t ON t.id = b.timeline_id
        WHERE t.kind = 'stream' AND t.play_id = ${play} ORDER BY b.seq`)
      ahead = rows.flatMap((row) => row.events).filter((event) => event.type === 'ahead')
      expect(ahead).toHaveLength(n)
    })
    expect(ahead.map((event) => event.from).sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, at) => (at + 1) * chunkSize),
    )
    for (const event of ahead) {
      expect(event).toMatchObject({ bytes: chunkSize, outcome: 'fetched' })
      expect(event.ms).toBeGreaterThanOrEqual(0)
    }
  })

  it('reads nothing ahead of a download that isn’t audio or video', async () => {
    const session = await storedFile('Download ahead', 8)
    discord.cdnRequests = 0
    const sent = 2.5 * 1024 * 1024
    const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
      headers: { Range: `bytes=0-${String(sent - 1)}` },
    })
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(contentOf(8).subarray(0, sent)),
    )
    // The one request for its own chunk, and nothing after it.
    await setTimeout(500)
    expect(discord.cdnRequests).toBe(1)
  })

  it('stops reading ahead as the API closes', async () => {
    const session = await storedFile('Closing ahead', 4)
    const file = await downloadableFile(app.db, session.nodeId)
    // Built as app.ts builds it, so the app's own keeps working for the other tests.
    const reads = new ReadAheads({
      prefetch: (version, index, signal) => prefetchChunk(app, version, index, signal),
    })
    discord.cdnRequests = 0
    discord.cdnAborted = 0
    // The first fetch ahead is under way, and held.
    discord.holdCdnFrom = 1
    try {
      reads.follow('a session made up', file).ahead.reached(0, 2.5 * 1024 * 1024)
      await vi.waitFor(() => {
        expect(discord.cdnRequests).toBe(2)
      })
      reads.stop()
      await vi.waitFor(() => {
        expect(discord.cdnAborted).toBe(2)
      })
    } finally {
      reads.stop()
      discord.holdCdnFrom = Infinity
      discord.releaseCdn()
    }
    // Neither chunk it held is the cache's, and nothing more is fetched.
    await app.frameCache?.idle()
    await setTimeout(200)
    expect(discord.cdnRequests).toBe(2)
    for (const index of [1, 2]) {
      const frame = await frameOf(session.versionId, index)
      expect(app.frameCache?.has(frame)).toBe(false)
      expect(app.frameCache?.hasSegment(frame, 0)).toBe(false)
    }
  })

  it('ends a read’s hold on its window as its response closes, finished or cancelled', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFilm('Film hold', 4 * chunkSize)
    const follow = app.readAheads.follow.bind(app.readAheads)
    let opened = 0
    let ended = 0
    const spy = vi.spyOn(app.readAheads, 'follow').mockImplementation((sessionId, version) => {
      opened += 1
      const followed = follow(sessionId, version)
      return {
        ahead: followed.ahead,
        done: () => {
          ended += 1
          followed.done()
        },
      }
    })
    const path = `/files/${session.nodeId}/content?play=${crypto.randomUUID()}`
    discord.cdnRequests = 0
    discord.cdnAborted = 0
    discord.holdCdnFrom = 1
    try {
      // A read held on Discord and cancelled before its first byte.
      const controller = new AbortController()
      const held = client.fetch('GET', path, {
        headers: { Range: 'bytes=0-' },
        signal: controller.signal,
      })
      await vi.waitFor(() => {
        expect(discord.cdnRequests).toBe(1)
      })
      expect([opened, ended]).toEqual([1, 0])
      controller.abort()
      await expect(held).rejects.toThrow()
      await vi.waitFor(() => {
        expect(discord.cdnAborted).toBe(1)
      })
      await vi.waitFor(() => {
        expect(ended).toBe(1)
      })
    } finally {
      discord.holdCdnFrom = Infinity
      discord.releaseCdn()
    }
    try {
      // One that finishes.
      const whole = await client.fetch('GET', path, { headers: { Range: 'bytes=0-99' } })
      expect((await whole.arrayBuffer()).byteLength).toBe(100)
      await vi.waitFor(() => {
        expect([opened, ended]).toEqual([2, 2])
      })
    } finally {
      spy.mockRestore()
    }
  })

  /** Reads bytes `from` to `to` of a file straight from the reader, with what it counted by source. */
  async function readCounted(nodeId: string, from: number, to: number, clientMs = 0) {
    const file = await downloadableFile(app.db, nodeId)
    const sources = readSources()
    const pieces: Uint8Array[] = []
    for await (const piece of readVersion(
      app,
      file,
      from,
      to,
      undefined,
      'downloads.bytes',
      sources,
    )) {
      pieces.push(piece)
      if (clientMs > 0) await setTimeout(clientMs)
    }
    return { sources, bytes: Buffer.concat(pieces) }
  }

  it('counts a cold read as Discord’s', async () => {
    const session = await storedFile('Counted cold', 1)
    const content = Buffer.from(contentOf(1))
    const { sources, bytes } = await readCounted(session.nodeId, 300_000, 300_099)
    expect(bytes).toEqual(content.subarray(300_000, 300_100))
    expect(sources.discord.bytes).toBe(100)
    expect(sources.discord.waitMs).toBeGreaterThan(0)
    expect(sources.staging).toEqual({ bytes: 0, waitMs: 0 })
    expect(sources.cache).toEqual({ bytes: 0, waitMs: 0 })
  })

  it('counts a read the cache holds as the cache’s', async () => {
    const session = await storedFile('Counted kept', 1)
    await readCounted(session.nodeId, 300_000, 300_099)
    await app.frameCache?.idle()
    const { sources, bytes } = await readCounted(session.nodeId, 300_000, 300_099)
    expect(bytes).toEqual(Buffer.from(contentOf(1).subarray(300_000, 300_100)))
    expect(sources.cache.bytes).toBe(100)
    expect(sources.discord).toEqual({ bytes: 0, waitMs: 0 })
    expect(sources.staging).toEqual({ bytes: 0, waitMs: 0 })
  })

  it('counts a frame the cache holds whole as the cache’s too', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFile('Counted whole', 1)
    // The whole chunk read once, so it is kept as one frame.
    await readCounted(session.nodeId, 0, chunkSize - 1)
    await app.frameCache?.idle()
    const { sources, bytes } = await readCounted(session.nodeId, 1000, 1999)
    expect(bytes).toEqual(Buffer.from(contentOf(1).subarray(1000, 2000)))
    expect(sources.cache.bytes).toBe(1000)
    expect(sources.discord.bytes).toBe(0)
  })

  /**
   * Waits until the cache holds the frame of `versionId`'s only chunk whole,
   * on its disk: the read that kept it has ended before the frame is put.
   */
  async function keptWhole(versionId: string) {
    const [chunk] = (
      await app.db.execute<{ frame_sha256: Buffer }>(sql`
        SELECT frame_sha256 FROM chunks WHERE version_id = ${versionId}`)
    ).rows
    if (!chunk) throw new Error('No chunk.')
    await vi.waitFor(() => {
      expect(app.frameCache?.has(chunk.frame_sha256)).toBe(true)
    })
    await app.frameCache?.idle()
    const hex = chunk.frame_sha256.toString('hex')
    return {
      sha: chunk.frame_sha256,
      file: path.join(app.config.cacheDir, hex.slice(0, 2), `${hex}.frame`),
    }
  }

  it('reads a seek into a frame kept whole by its segments alone', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Kept whole', 1)
    await readCounted(session.nodeId, 0, chunkSize - 1) // kept whole
    await keptWhole(session.versionId)
    discord.cdnRequests = 0
    const before = app.frameCache?.stats.bytesRead ?? 0
    const at = layout.plaintextStart(5) + 1000 // inside segment 5
    const { sources, bytes } = await readCounted(session.nodeId, at, at + 999)
    expect(bytes).toEqual(Buffer.from(contentOf(1).subarray(at, at + 1000)))
    expect(discord.cdnRequests).toBe(0)
    expect(sources.cache.bytes).toBe(1000)
    expect((app.frameCache?.stats.bytesRead ?? 0) - before).toBe(layout.segmentLength(5))
  })

  it('fetches the rest of a range from where a frame kept whole fails its tag', async () => {
    const { chunkSize } = app.config.sizes
    const layout = new ChunkFrameLayout(chunkSize)
    const session = await storedFile('Spoiled whole', 1)
    await readCounted(session.nodeId, 0, chunkSize - 1)
    const { sha, file } = await keptWhole(session.versionId)
    // Segment 7 is spoiled; segments 6 to 8 are wanted.
    const kept = await readFile(file)
    const spoiled = layout.segmentStart(7) + 100
    kept[spoiled] = (kept[spoiled] ?? 0) ^ 1
    await writeFile(file, kept)
    // The cache holds the frame, so the lookup signed nothing: the refetch signs its own URL.
    await app.db.execute(sql`
      UPDATE blobs SET cdn_url_expires_at = now() - interval '1 hour'
      WHERE id = (SELECT blob_id FROM chunks WHERE version_id = ${session.versionId})`)
    const signs = () =>
      discord.requests.filter((request) => request === 'POST /attachments/refresh-urls').length
    const signed = signs()
    discord.cdnRequests = 0
    const from = layout.plaintextStart(6) + 1000
    const to = layout.plaintextStart(8) + 999
    const { sources, bytes } = await readCounted(session.nodeId, from, to)
    expect(bytes).toEqual(Buffer.from(contentOf(1).subarray(from, to + 1)))
    expect(signs() - signed).toBe(1)
    // Segment 6 came from the frame; the rest from one request, from segment 7 on.
    expect(sources.cache.bytes).toBe(layout.plaintextSize(6) - 1000)
    expect(sources.discord.bytes).toBe(layout.plaintextSize(7) + 1000)
    expect(discord.cdnRequests).toBe(1)
    expect(app.frameCache?.has(sha)).toBe(false)
  })

  it('splits a read across the cache and Discord', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFile('Counted split', 2)
    // Only the first chunk was read, whole, and is kept.
    await readCounted(session.nodeId, 0, chunkSize - 1)
    await app.frameCache?.idle()
    const { sources, bytes } = await readCounted(session.nodeId, chunkSize - 100, chunkSize + 99)
    expect(bytes).toEqual(Buffer.from(contentOf(2).subarray(chunkSize - 100, chunkSize + 100)))
    expect(sources.cache.bytes).toBe(100)
    expect(sources.discord.bytes).toBe(100)
    expect(sources.cache.bytes + sources.discord.bytes).toBe(200)
    expect(sources.staging.bytes).toBe(0)
  })

  it('counts a version still syncing as staging’s', async () => {
    // One chunk of several segments: small, so the upload stays quick.
    const bytes = new Uint8Array(300_000).map((_, i) => i % 233)
    const folder = await createFolder(client, (await workspace(client)).id, 'Counted staged')
    const session = await uploadFile(client, folder.id, 'staged.bin', bytes)
    // Not settled to Discord: its frames are still in staging.
    const read = await readCounted(session.nodeId, 10, bytes.length - 11)
    expect(read.bytes).toEqual(Buffer.from(bytes.subarray(10, bytes.length - 10)))
    expect(read.sources.staging.bytes).toBe(bytes.length - 20)
    expect(read.sources.discord).toEqual({ bytes: 0, waitMs: 0 })
    expect(read.sources.cache).toEqual({ bytes: 0, waitMs: 0 })
  })

  it('counts a kept segment that fails its tag, fetched again, as Discord’s', async () => {
    const session = await storedFile('Counted spoiled', 1)
    await readCounted(session.nodeId, 300_000, 300_099)
    await app.frameCache?.idle()
    const [chunk] = (
      await app.db.execute<{ frame_sha256: Buffer }>(sql`
        SELECT frame_sha256 FROM chunks WHERE version_id = ${session.versionId}`)
    ).rows
    if (!chunk) throw new Error('No chunk.')
    const hex = chunk.frame_sha256.toString('hex')
    const file = path.join(app.config.cacheDir, hex.slice(0, 2), `${hex}-1.frame`)
    const kept = await readFile(file)
    kept[100] = (kept[100] ?? 0) ^ 1
    await writeFile(file, kept)
    // The kept copy is planned as the cache's, fails its tag, and is fetched
    // afresh: what was emitted came from Discord.
    const { sources, bytes } = await readCounted(session.nodeId, 300_000, 300_099)
    expect(bytes).toEqual(Buffer.from(contentOf(1).subarray(300_000, 300_100)))
    expect(sources.discord.bytes).toBe(100)
    expect(sources.cache).toEqual({ bytes: 0, waitMs: 0 })
  })

  it('counts a frame refetched over a bad cached copy as Discord’s', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFile('Counted refetched', 1)
    const content = Buffer.from(contentOf(1))
    // The whole chunk read once: kept as one frame, in place of its segments.
    await readCounted(session.nodeId, 0, chunkSize - 1)
    await app.frameCache?.idle()
    const [chunk] = (
      await app.db.execute<{ frame_sha256: Buffer }>(sql`
        SELECT frame_sha256 FROM chunks WHERE version_id = ${session.versionId}`)
    ).rows
    if (!chunk) throw new Error('No chunk.')
    const hex = chunk.frame_sha256.toString('hex')
    const file = path.join(app.config.cacheDir, hex.slice(0, 2), `${hex}.frame`)
    // Kept once the read has ended, on its way to the disk.
    await vi.waitFor(async () => {
      await app.frameCache?.idle()
      await readFile(file)
    })
    const kept = await readFile(file)
    kept[100] = (kept[100] ?? 0) ^ 1
    await writeFile(file, kept)
    // The cache holds the frame as far as it knows, but its segment fails its
    // tag: it is read from Discord again, and those bytes are Discord's.
    discord.cdnRequests = 0
    const spoiled = await readCounted(session.nodeId, 1000, 1999)
    expect(spoiled.bytes).toEqual(content.subarray(1000, 2000))
    expect(discord.cdnRequests).toBe(1)
    expect(spoiled.sources.discord.bytes).toBe(1000)
    expect(spoiled.sources.discord.waitMs).toBeGreaterThan(0)
    expect(spoiled.sources.cache).toEqual({ bytes: 0, waitMs: 0 })
    // The bad frame is let go; the refetch is by segment, as any partial read is.
    expect(app.frameCache?.has(chunk.frame_sha256)).toBe(false)

    // Kept whole again (once the segments read around have been kept, so the
    // whole chunk is read in one request), and then gone from the disk: the same.
    await vi.waitFor(() => {
      expect(app.frameCache?.hasSegment(chunk.frame_sha256, 3)).toBe(true)
    })
    await readCounted(session.nodeId, 0, chunkSize - 1)
    await vi.waitFor(() => {
      expect(app.frameCache?.has(chunk.frame_sha256)).toBe(true)
    })
    await app.frameCache?.idle()
    const again = await readCounted(session.nodeId, 1000, 1999)
    expect(again.sources.cache.bytes).toBe(1000)
    expect(again.sources.discord.bytes).toBe(0)
    await rm(file)
    discord.cdnRequests = 0
    const gone = await readCounted(session.nodeId, 1000, 1999)
    expect(gone.bytes).toEqual(content.subarray(1000, 2000))
    expect(discord.cdnRequests).toBe(1)
    expect(gone.sources.discord.bytes).toBe(1000)
    expect(gone.sources.cache.bytes).toBe(0)
  })

  it('charges a read only for the time it took to arrive, not the client’s', async () => {
    const { chunkSize } = app.config.sizes
    const session = await storedFile('Counted slow client', 1)
    await readCounted(session.nodeId, 0, chunkSize - 1)
    await app.frameCache?.idle()
    // Every piece ready at once, and a client that takes 40 ms over each.
    const { sources } = await readCounted(session.nodeId, 0, chunkSize - 1, 40)
    expect(sources.cache.bytes).toBe(chunkSize)
    expect(sources.cache.waitMs).toBeLessThan(150)
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
