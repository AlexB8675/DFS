import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ChannelType, Routes, type APIChannel, type APIMessage } from 'discord-api-types/v10'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blobFilename, readCdnRange } from './cdn.ts'
import { DiscordBlobStore, type StorageChannel } from './discord-blob-store.ts'
import { messagesAfter } from './discord-messages.ts'
import { createDiscordRest, type DiscordRest } from './discord.ts'

// The Discord contract (DESIGN.md §17): what DFS relies on, checked against
// the real Discord in development's #storage-03. Opt-in, since it needs the
// bot token from the root .env and `pnpm dfs setup` first:
//
//   pnpm --filter @dfs/storage check:discord
//
// Everything it posts is deleted again, by the test itself: its messages
// carry an instance ID no database has, so no reconciler would touch one.

const enabled = process.env.npm_lifecycle_event === 'check:discord'
const TEST_BLOB_ID = Number.MAX_SAFE_INTEGER - 1
const MiB = 1024 * 1024

describe.skipIf(!enabled)('Discord contract', () => {
  let rest: DiscordRest
  let channel: StorageChannel
  let store: DiscordBlobStore
  const posted: string[] = []

  beforeAll(async () => {
    try {
      process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'))
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    const token = process.env.DISCORD_BOT_TOKEN
    const guildId = process.env.DISCORD_GUILD_ID
    const categoryName = process.env.DISCORD_CATEGORY_NAME ?? 'DFS Dev'
    if (!token || !guildId) throw new Error('Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in .env.')
    if (categoryName === 'DFS') throw new Error('Never run this in production’s category.')
    rest = createDiscordRest(token, { timeoutMs: 120_000 })
    const channels = (await rest.get(Routes.guildChannels(guildId))) as APIChannel[]
    const category = channels.find(
      (found) => found.type === ChannelType.GuildCategory && found.name === categoryName,
    )
    const target = channels.find(
      (found) =>
        category &&
        'parent_id' in found &&
        found.parent_id === category.id &&
        found.name === 'storage-03',
    )
    if (!target) throw new Error(`No #storage-03 in “${categoryName}”: run \`pnpm dfs setup\`.`)
    channel = { id: 'contract', discordChannelId: target.id, enabled: true }
    store = new DiscordBlobStore({
      rest,
      channels: () => Promise.resolve([channel]),
      maxBytes: 10 * MiB - 64 * 1024,
      instanceId: () => Promise.resolve('c0ffee000000'),
      perChannel: 2,
    })
  })

  afterAll(async () => {
    for (const messageId of posted) {
      await rest
        .delete(Routes.channelMessage(channel.discordChannelId, messageId))
        .catch(() => undefined)
    }
  })

  it('stores a blob, reads ranges of it, signs its URL again and deletes it', async () => {
    const data = new Uint8Array(randomBytes(3 * MiB))
    const { location, url } = await store.put(
      { id: TEST_BLOB_ID, kind: 'solo', frameCount: 1 },
      () => Promise.resolve(data),
    )
    if (location.messageId) posted.push(location.messageId)
    expect(location).toMatchObject({ channelId: 'contract' })
    expect(url?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000)
    const blob = { id: TEST_BLOB_ID, ...location, url }

    // The CDN answers a Range request with only those bytes.
    const response = await fetch(url?.url ?? '', { headers: { Range: 'bytes=1000-5999' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 1000-5999/${String(data.length)}`)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data.subarray(1000, 6000))
    expect(await store.read(blob, 2 * MiB, 4096)).toEqual(data.subarray(2 * MiB, 2 * MiB + 4096))

    // Discord signs the bare attachment URL again, as the API asks it to.
    const signed = (await store.signUrls([blob])).get(TEST_BLOB_ID)
    expect(signed?.url).toContain(
      `/${String(location.attachmentId)}/${blobFilename(TEST_BLOB_ID)}?`,
    )
    expect(signed?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000)
    expect(await readCdnRange(fetch, signed?.url ?? '', 0, 16)).toEqual(data.subarray(0, 16))
    expect(await store.read({ ...blob, url: null }, data.length - 10, 10)).toEqual(
      data.subarray(data.length - 10),
    )

    await store.delete(blob)
    await store.delete(blob)
    // The message is gone, though Discord still signs and serves its
    // attachment for a while: a lost blob shows in its message, not its URL.
    await expect(
      rest.get(Routes.channelMessage(channel.discordChannelId, location.messageId ?? '')),
    ).rejects.toMatchObject({ code: 10008 })
  })

  it('answers a repeated nonce with the first message', async () => {
    const nonce = randomBytes(12).toString('base64url')
    const post = () =>
      rest.post(Routes.channelMessages(channel.discordChannelId), {
        body: { content: 'DFS contract test: nonce', nonce, enforce_nonce: true },
      }) as Promise<APIMessage>
    const first = await post()
    posted.push(first.id)
    const second = await post()
    posted.push(second.id)
    expect(second.id).toBe(first.id)
  })

  it('lists the first messages after an ID, which DFS reads oldest first', async () => {
    const ids: string[] = []
    for (const n of [1, 2, 3]) {
      const message = (await rest.post(Routes.channelMessages(channel.discordChannelId), {
        body: { content: `DFS contract test: order ${String(n)}` },
      })) as APIMessage
      ids.push(message.id)
      posted.push(message.id)
    }
    const before = String(BigInt(ids[0] ?? '1') - 1n)
    // Discord answers the oldest two after `before`, newest first; DFS sorts them.
    const raw = (await rest.get(Routes.channelMessages(channel.discordChannelId), {
      query: new URLSearchParams({ after: before, limit: '2' }),
    })) as APIMessage[]
    expect(raw.map((message) => message.id)).toEqual([ids[1], ids[0]])
    const page = await messagesAfter(rest, channel.discordChannelId, before, 2)
    expect(page.map((message) => message.id)).toEqual(ids.slice(0, 2))
  })
})
