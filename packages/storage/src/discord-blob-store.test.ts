import { randomBytes } from 'node:crypto'
import { ChannelType } from 'discord-api-types/v10'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BlobStoreError, type BlobToStore, type StoredBlob } from './blob-store.ts'
import { CdnGate } from './cdn.ts'
import { DiscordBlobStore, type StorageChannel } from './discord-blob-store.ts'
import { FakeDiscord } from './testing.ts'

let discord: FakeDiscord
let channels: StorageChannel[]
let loads: number
let store: DiscordBlobStore

beforeEach(() => {
  discord = new FakeDiscord()
  channels = ['storage-00', 'storage-01', 'storage-02'].map((name, index) => ({
    id: `channel-${String(index)}`,
    discordChannelId: discord.addChannel({ name, type: ChannelType.GuildText }).id,
    enabled: index !== 2,
  }))
  loads = 0
  store = new DiscordBlobStore({
    rest: discord,
    channels: () => {
      loads += 1
      return Promise.resolve(structuredClone(channels))
    },
    maxBytes: 1024,
    instanceId: () => Promise.resolve('0123456789ab'),
    perChannel: 2,
    fetch: discord.fetch,
  })
})

const solo = (id: number): BlobToStore => ({ id, kind: 'solo', frameCount: 1 })

const bytes = (data: Uint8Array) => () => Promise.resolve(data)

async function put(blob: BlobToStore, data: Uint8Array): Promise<StoredBlob> {
  const { location, url } = await store.put(blob, bytes(data))
  return { id: blob.id, ...location, url }
}

describe('DiscordBlobStore (DESIGN.md §4, §6.1, §6.2)', () => {
  it('posts each blob as one message, spread over the enabled channels', async () => {
    const data = new Uint8Array(randomBytes(600))
    const first = await put({ id: 7, kind: 'pack', frameCount: 12 }, data)
    const second = await put(solo(8), data)

    expect([first.channelId, second.channelId].sort()).toEqual(['channel-0', 'channel-1'])
    expect(discord.messages.map((message) => message.content)).toEqual([
      'dfs1 b=7 k=pack n=12 i=0123456789ab',
      'dfs1 b=8 k=solo n=1 i=0123456789ab',
    ])
    expect(discord.messages[0]?.attachments).toMatchObject([{ filename: '7.bin', size: 600 }])
    expect(first).toMatchObject({
      messageId: discord.messages[0]?.id,
      attachmentId: discord.messages[0]?.attachments[0]?.id,
    })
    expect(first.url?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000)

    expect(await store.read(first, 100, 50)).toEqual(data.subarray(100, 150))
    expect(await streamed(first, 100, 50)).toEqual(data.subarray(100, 150))
    // A body cut short fails a stream, rather than ending it.
    discord.cutNextBodyAt = 20
    await expect(streamed(first, 100, 50)).rejects.toMatchObject({ retryable: true })
    discord.ignoreRange = true
    expect(await store.read(first, 590, 10)).toEqual(data.subarray(590))
    // A CDN that sends the whole file has the bytes before the offset skipped.
    expect(await streamed(first, 100, 50)).toEqual(data.subarray(100, 150))
    expect(await streamed(first, 590, 10)).toEqual(data.subarray(590))
  })

  async function streamed(blob: StoredBlob, offset: number, length: number): Promise<Uint8Array> {
    const pieces: Uint8Array[] = []
    for await (const piece of store.stream(blob, offset, length)) pieces.push(piece)
    return new Uint8Array(Buffer.concat(pieces))
  }

  it('posts a blob once when a retry follows a lost answer', async () => {
    discord.loseNextAnswer = true
    await expect(store.put(solo(9), bytes(new Uint8Array(10)))).rejects.toMatchObject({
      retryable: true,
    })
    const blob = await put(solo(9), new Uint8Array(10))
    expect(discord.messages).toHaveLength(1)
    expect(blob.messageId).toBe(discord.messages[0]?.id)
  })

  it('posts again when Discord kept less than was sent', async () => {
    discord.truncateNextAttachment = true
    await expect(store.put(solo(10), bytes(new Uint8Array(10)))).rejects.toMatchObject({
      retryable: true,
    })
    expect(discord.messages).toHaveLength(0)
    await put(solo(10), new Uint8Array(10))
    expect(discord.messages[0]?.attachments[0]?.size).toBe(10)
  })

  it('keeps every enabled channel busy, but each to its own limit, reading a blob only on its turn', async () => {
    const release = Promise.withResolvers<undefined>()
    let posting = 0
    let most = 0
    const post = discord.post
    discord.post = async (route, options) => {
      posting += 1
      most = Math.max(most, posting)
      await release.promise
      posting -= 1
      return post(route, options)
    }
    let read = 0
    const reading = (id: number) => () => {
      read += 1
      return Promise.resolve(new Uint8Array([id]))
    }
    const puts = Array.from({ length: 7 }, (_, index) =>
      store.put(solo(100 + index), reading(100 + index)),
    )
    await vi.waitFor(() => {
      expect(posting).toBe(4)
    })
    // Two enabled channels, two posts each; the other three wait unread.
    expect(read).toBe(4)
    release.resolve(undefined)
    const stored = await Promise.all(puts)
    expect(most).toBe(4)
    expect(read).toBe(7)
    const used = new Set(stored.map((result) => result.location.channelId))
    expect([...used].sort()).toEqual(['channel-0', 'channel-1'])
  })

  it('refuses a blob larger than an attachment may be, and waits for a channel', async () => {
    await expect(store.put(solo(1), bytes(new Uint8Array(1025)))).rejects.toMatchObject({
      retryable: false,
    })
    channels = channels.map((channel) => ({ ...channel, enabled: false }))
    const fresh = new DiscordBlobStore({
      rest: discord,
      channels: () => Promise.resolve(channels),
      maxBytes: 1024,
      instanceId: () => Promise.resolve('0123456789ab'),
      perChannel: 2,
    })
    await expect(fresh.put(solo(1), bytes(new Uint8Array(1)))).rejects.toThrow(/No storage channel/)
    expect(discord.messages).toHaveLength(0)
  })

  it('signs URLs again when they have expired or are missing', async () => {
    const data = new Uint8Array(randomBytes(64))
    const blob = await put(solo(11), data)
    discord.revokeUrls()
    expect(await store.read(blob, 0, 8)).toEqual(data.subarray(0, 8))
    expect(await store.read({ ...blob, url: null }, 8, 8)).toEqual(data.subarray(8, 16))

    const signed = await store.signUrls([blob, { ...blob, id: 12, attachmentId: '1' }])
    expect([...signed.keys()]).toEqual([11])
  })

  it('waits out a 429 from the CDN and reads on, every read waiting together', async () => {
    const data = new Uint8Array(randomBytes(600))
    const blob = await put(solo(11), data)
    discord.slowDownNext = 1
    discord.slowDownRetryAfter = '0.3'
    const started = Date.now()
    const [first, second] = await Promise.all([
      store.read(blob, 0, 100),
      // Sent while the gate is closed: it waits rather than adding a refusal.
      new Promise((resolve) => setTimeout(resolve, 50)).then(() => store.read(blob, 100, 100)),
    ])
    expect(first).toEqual(data.subarray(0, 100))
    expect(second).toEqual(data.subarray(100, 200))
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    expect(discord.cdnRequests).toBe(3)

    discord.slowDownNext = 1
    discord.slowDownRetryAfter = '0.05'
    expect(await streamed(blob, 590, 10)).toEqual(data.subarray(590))
  })

  it('gives up on a CDN that keeps asking, and never waits over a minute', async () => {
    const blob = await put(solo(12), new Uint8Array(100))
    discord.slowDownNext = 4
    discord.slowDownRetryAfter = '0.01'
    await expect(store.read(blob, 0, 10)).rejects.toMatchObject({ retryable: true })
    const gate = new CdnGate()
    gate.slowDown('3600')
    expect(gate.closedForMs).toBeLessThanOrEqual(60_000)
    // Without a Retry-After, the pause doubles: 1 s, then 2 s.
    const doubling = new CdnGate()
    doubling.slowDown(null)
    doubling.slowDown(null)
    expect(doubling.closedForMs).toBeGreaterThan(1500)
  })

  it('lets a read given up on leave a closed gate at once', async () => {
    const gate = new CdnGate()
    gate.slowDown('30')
    const controller = new AbortController()
    const waiting = gate.open(controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('says a blob is gone when the CDN no longer has it', async () => {
    const blob = await put(solo(13), new Uint8Array(8))
    for (const url of discord.cdn.keys()) discord.cdn.delete(url)
    const error = await store.read(blob, 0, 8).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BlobStoreError)
    expect(error).toMatchObject({ retryable: false, message: 'Blob 13 is gone from Discord.' })
  })

  it('deletes a message, and takes one already gone as deleted', async () => {
    const blob = await put(solo(14), new Uint8Array(8))
    await store.delete(blob)
    await store.delete(blob)
    expect(discord.messages).toHaveLength(0)
  })

  it('finds a channel registered after it last looked', async () => {
    const blob = await put(solo(15), new Uint8Array(8))
    const before = loads
    const added = discord.addChannel({ name: 'storage-04', type: ChannelType.GuildText })
    channels.push({ id: 'channel-new', discordChannelId: added.id, enabled: true })
    const [posted] = discord.messages
    if (!posted) throw new Error('Nothing was posted.')
    discord.messages.push({ ...structuredClone(posted), channel_id: added.id })
    await store.delete({ ...blob, channelId: 'channel-new' })
    expect(loads).toBe(before + 1)
    await expect(store.delete({ ...blob, channelId: 'nowhere' })).rejects.toThrow(
      /isn't registered/,
    )
  })
})
