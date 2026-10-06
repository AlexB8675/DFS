import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '@dfs/config'
import {
  createDatabase,
  createPool,
  liveBytesDrift,
  purgeVersions,
  storageChannels,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordBlobStore, Staging } from '@dfs/storage'
import { FakeDiscord, type FakeChannel } from '@dfs/storage/testing'
import { ChannelType, InteractionType, type APIInteraction } from '@discordjs/core'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { deleted, runCommand, type GatewayDeps } from './gateway.ts'
import { dataChannels } from './storage.ts'
import { settleBlobs, uploadedFiles } from './testing.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Database
let directory: string
let staging: Staging
let config: Config
let discord: FakeDiscord
let storage00: FakeChannel
let logChannel: FakeChannel
let store: DiscordBlobStore
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-lost-test', onError: vi.fn() })
  db = createDatabase(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-lost-'))
  staging = new Staging(path.join(directory, 'staging'))
})

afterAll(async () => {
  await pool.end()
  await database.drop()
  await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  // Each test has a Discord of its own.
  await db.execute(sql`DELETE FROM chunks`)
  await db.execute(sql`DELETE FROM blobs`)
  await db.execute(sql`DELETE FROM storage_channels`)
  discord = new FakeDiscord()
  const category = discord.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
  storage00 = discord.addChannel({
    name: 'storage-00',
    type: ChannelType.GuildText,
    parent_id: category.id,
  })
  logChannel = discord.addChannel({
    name: 'dfs-log',
    type: ChannelType.GuildText,
    parent_id: category.id,
  })
  await db.insert(storageChannels).values([
    { discordChannelId: storage00.id, name: 'storage-00' },
    { discordChannelId: logChannel.id, name: 'dfs-log', kind: 'log' },
  ])
  config = loadConfig(
    { NODE_ENV: 'test', DISCORD_GUILD_ID: discord.guildId, DISCORD_CATEGORY_NAME: 'DFS Dev' },
    { service: 'bot', rootDir: directory },
  )
  store = new DiscordBlobStore({
    rest: discord,
    channels: () => dataChannels(db),
    maxBytes: 4096,
    instanceId: () => Promise.resolve('0123456789ab'),
    perChannel: 2,
    fetch: discord.fetch,
  })
})

const deps = (): GatewayDeps => ({ config, db, rest: discord, log: log as never })
const sizes = { blobMaxBytes: 4096, packTargetBytes: 4000 }

async function stateOf(table: 'blobs' | 'file_versions', id: number | string): Promise<string> {
  const { rows } = await db.execute<{ state: string }>(
    table === 'blobs'
      ? sql`SELECT state FROM blobs WHERE id = ${id}`
      : sql`SELECT state FROM file_versions WHERE id = ${id}`,
  )
  return rows[0]?.state ?? 'missing'
}

/** Two small files stored in one pack in Discord: the pack's blob and message. */
async function storedPack() {
  const uploaded = await uploadedFiles(db, staging, [100, 200])
  await settleBlobs({ db, staging, store, sizes })
  const { rows } = await db.execute<{ id: number; message_id: string }>(sql`
    SELECT DISTINCT blob.id::float8 AS id, blob.message_id FROM blobs blob
    JOIN chunks chunk ON chunk.blob_id = blob.id
    WHERE chunk.version_id = ${uploaded.files[0]?.versionId ?? ''}`)
  const blob = rows[0]
  if (!blob) throw new Error('Nothing was stored.')
  return { ...uploaded, blob }
}

describe('messages deleted in Discord (DESIGN.md §6.5)', () => {
  it('make their blob lost, with its files, and say so in #dfs-log without naming them', async () => {
    const { files, blob } = await storedPack()
    await deleted(deps(), storage00.id, [blob.message_id])
    expect(await stateOf('blobs', blob.id)).toBe('lost')
    for (const file of files) expect(await stateOf('file_versions', file.versionId)).toBe('lost')
    const alerts = discord.messages.filter((message) => message.channel_id === logChannel.id)
    expect(alerts.map((message) => message.content)).toEqual([
      '⚠️ 1 storage message was deleted in #storage-00. 2 files are lost; the admin overview lists them.',
    ])
  })

  it('leave alone what the bot deletes itself, unknown messages and other channels', async () => {
    const { blob } = await storedPack()
    // Messages no blob records: the reconciler's and the uploader's.
    await deleted(deps(), storage00.id, ['100000000000000077'])
    // A recorded message, but reported in a channel of another environment.
    await deleted(deps(), '100000000000000078', [blob.message_id])
    expect(await stateOf('blobs', blob.id)).toBe('stored')
    // The GC's: the blob is `deleting` by the time its message goes.
    await db.execute(sql`UPDATE blobs SET state = 'deleting' WHERE id = ${blob.id}`)
    await deleted(deps(), storage00.id, [blob.message_id])
    expect(await stateOf('blobs', blob.id)).toBe('deleting')
    expect(discord.messages.filter((message) => message.channel_id === logChannel.id)).toEqual([])
  })

  it('stop listing a lost blob once its files are purged, and give their quota back', async () => {
    const { ownerId, files, blob } = await storedPack()
    await deleted(deps(), storage00.id, [blob.message_id])
    await db.transaction((tx) =>
      purgeVersions(
        tx,
        ownerId,
        files.map((file) => file.versionId),
      ),
    )
    expect(await stateOf('blobs', blob.id)).toBe('deleted')
    expect(await liveBytesDrift(db)).toEqual([])
    const { rows } = await db.execute<{ used: number }>(sql`
      SELECT used_bytes::float8 AS used FROM users WHERE id = ${ownerId}`)
    expect(rows[0]?.used).toBe(0)
  })
})

describe('/dfs setup', () => {
  function interaction(permissions: string, guildId = discord.guildId): APIInteraction {
    return {
      id: '100000000000000090',
      application_id: '100000000000000091',
      token: 'interaction-token',
      type: InteractionType.ApplicationCommand,
      guild_id: guildId,
      member: { permissions },
      data: { name: 'dfs', options: [{ name: 'setup', type: 1 }] },
    } as unknown as APIInteraction
  }
  const api = () => ({
    interactions: {
      reply: vi.fn(() => Promise.resolve(undefined)),
      defer: vi.fn(() => Promise.resolve(undefined)),
      editReply: vi.fn(() => Promise.resolve({})),
    },
  })

  it('sets up the category and registers its channels, for an administrator', async () => {
    const answer = api()
    await runCommand(deps(), interaction('8'), answer as never)
    expect(answer.interactions.defer).toHaveBeenCalledOnce()
    const [, , reply] = answer.interactions.editReply.mock.calls[0] as unknown as [
      string,
      string,
      { content: string },
    ]
    // The category existed; its other channels were made, and all registered.
    expect(reply.content).toContain('• Created #storage-01.')
    expect(reply.content).toContain('• Registered storage-01, storage-02')
    const { rows } = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM storage_channels`,
    )
    expect(rows[0]?.count).toBe(7)
  })

  it('refuses anyone else, and ignores other servers', async () => {
    const refused = api()
    await runCommand(deps(), interaction('0'), refused as never)
    expect(refused.interactions.reply).toHaveBeenCalledWith(
      '100000000000000090',
      'interaction-token',
      expect.objectContaining({ content: 'Only server administrators can run /dfs.' }),
    )
    const elsewhere = api()
    await runCommand(deps(), interaction('8', '100000000000000099'), elsewhere as never)
    expect(elsewhere.interactions.defer).not.toHaveBeenCalled()
    expect(discord.requests.filter((request) => request.startsWith('POST'))).toEqual([])
  })
})
