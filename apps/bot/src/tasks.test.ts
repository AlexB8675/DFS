import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '@dfs/config'
import { createDatabase, createPool, QUEUES, storageChannels, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordBlobStore, Staging } from '@dfs/storage'
import { FakeDiscord, type FakeChannel } from '@dfs/storage/testing'
import { ChannelType } from '@discordjs/core'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { deleted } from './gateway.ts'
import { Packer } from './packer.ts'
import { dataChannels } from './storage.ts'
import { runAdminTask, type TaskDeps } from './tasks.ts'
import { settleBlobs, uploadedFiles } from './testing.ts'

// Admin → Storage's tasks (DESIGN.md §9), run as the leader runs them,
// against a fake Discord.

let database: TestDatabase
let pool: pg.Pool
let db: Database
let directory: string
let staging: Staging
let config: Config
let discord: FakeDiscord
let category: FakeChannel
let storage00: FakeChannel
let store: DiscordBlobStore
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const sizes = { blobMaxBytes: 4096, packTargetBytes: 4000 }

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-tasks-test', onError: vi.fn() })
  db = createDatabase(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-tasks-'))
  staging = new Staging(path.join(directory, 'staging'))
})

afterAll(async () => {
  await pool.end()
  await database.drop()
  await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  await db.execute(sql`DELETE FROM chunks`)
  await db.execute(sql`DELETE FROM blobs`)
  await db.execute(sql`DELETE FROM storage_channels`)
  discord = new FakeDiscord()
  category = discord.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
  storage00 = discord.addChannel({
    name: 'storage-00',
    type: ChannelType.GuildText,
    parent_id: category.id,
  })
  await db.insert(storageChannels).values({ discordChannelId: storage00.id, name: 'storage-00' })
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

function deps(overrides: Partial<TaskDeps> = {}): TaskDeps {
  return {
    config,
    db,
    boss: { retry: vi.fn() } as unknown as PgBoss,
    storage: { store, discord: discord as never },
    staging,
    packer: new Packer({ db, staging, sizes, maxWaitMs: 60_000 }),
    log: log as never,
    ...overrides,
  }
}

const task = (kind: string, blobId?: string) => ({ kind, blobId, requestedBy: 'Admin' })

async function stateOf(table: 'blobs' | 'file_versions', id: number | string): Promise<string> {
  const { rows } = await db.execute<{ state: string }>(
    table === 'blobs'
      ? sql`SELECT state FROM blobs WHERE id = ${id}`
      : sql`SELECT state FROM file_versions WHERE id = ${id}`,
  )
  return rows[0]?.state ?? 'missing'
}

/**
 * Two small files in one pack in Discord, whose message is then deleted by
 * hand: read through the CDN first (`read`), as a download would, or never.
 */
async function lostPack({ read }: { read: boolean }) {
  const uploaded = await uploadedFiles(db, staging, [100, 200])
  await settleBlobs({ db, staging, store, sizes })
  const { rows } = await db.execute<{
    id: number
    channel_id: string
    message_id: string
    attachment_id: string
    size_bytes: number
    cdn_url: string
    expires_ms: number
  }>(sql`
    SELECT DISTINCT blob.id::float8 AS id, blob.channel_id, blob.message_id, blob.attachment_id,
      blob.size_bytes, blob.cdn_url,
      (extract(epoch FROM blob.cdn_url_expires_at) * 1000)::float8 AS expires_ms
    FROM blobs blob JOIN chunks chunk ON chunk.blob_id = blob.id
    WHERE chunk.version_id = ${uploaded.files[0]?.versionId ?? ''}`)
  const blob = rows[0]
  if (!blob) throw new Error('Nothing was stored.')
  if (read) {
    await store.read(
      {
        id: blob.id,
        channelId: blob.channel_id,
        messageId: blob.message_id,
        attachmentId: blob.attachment_id,
        url: { url: blob.cdn_url, expiresAt: new Date(blob.expires_ms) },
      },
      0,
      blob.size_bytes,
    )
  }
  await discord.delete(`/channels/${storage00.id}/messages/${blob.message_id}`)
  await deleted({ config, db, rest: discord, log: log as never }, storage00.id, [blob.message_id])
  return { ...uploaded, blob }
}

describe('admin tasks (DESIGN.md §9)', () => {
  it('creates the next storage channel inside the category, private to the bot, and registers it', async () => {
    expect(await runAdminTask(deps(), task('channel.create'))).toBe(
      'Created #storage-01; it takes new blobs within a minute.',
    )
    const created = discord.channels.find((channel) => channel.name === 'storage-01')
    expect(created?.parent_id).toBe(category.id)
    expect(created?.permission_overwrites.map((overwrite) => overwrite.id).sort()).toEqual(
      [discord.botId, discord.guildId].sort(),
    )
    expect((await dataChannels(db)).map((channel) => channel.discordChannelId)).toContain(
      created?.id,
    )
  })

  it('refuses to create a channel outside this environment’s category', async () => {
    const elsewhere = loadConfig(
      { NODE_ENV: 'test', DISCORD_GUILD_ID: discord.guildId, DISCORD_CATEGORY_NAME: 'DFS Other' },
      { service: 'bot', rootDir: directory },
    )
    await expect(runAdminTask(deps({ config: elsewhere }), task('channel.create'))).rejects.toThrow(
      'There is no “DFS Other” category yet',
    )
  })

  it('recovers a lost blob read lately, from the CDN’s copy, and its files with it', async () => {
    const { files, blob } = await lostPack({ read: true })
    expect(await stateOf('blobs', blob.id)).toBe('lost')
    expect(await runAdminTask(deps(), task('blob.recover', String(blob.id)))).toBe(
      `Recovered blob ${String(blob.id)}: 2 versions are readable again.`,
    )
    expect(await stateOf('blobs', blob.id)).toBe('stored')
    for (const file of files) expect(await stateOf('file_versions', file.versionId)).toBe('stored')
    const { rows } = await db.execute<{ message_id: string; lost_at: string | null }>(sql`
      SELECT message_id, lost_at FROM blobs WHERE id = ${blob.id}`)
    expect(rows[0]?.message_id).not.toBe(blob.message_id)
    expect(rows[0]?.lost_at).toBeNull()
    expect(discord.messages.map((message) => message.id)).toContain(rows[0]?.message_id)
    const { rows: journal } = await db.execute<{ kind: string }>(sql`
      SELECT kind FROM journal ORDER BY id DESC LIMIT 1`)
    expect(journal[0]?.kind).toBe('blob.stored')
  })

  it('leaves a blob lost when no one had read it: Discord serves it no more', async () => {
    const { blob } = await lostPack({ read: false })
    const posts = discord.messages.length
    await expect(runAdminTask(deps(), task('blob.recover', String(blob.id)))).rejects.toThrow(
      `Discord no longer serves blob ${String(blob.id)}`,
    )
    expect(await stateOf('blobs', blob.id)).toBe('lost')
    expect(discord.messages).toHaveLength(posts)
  })

  it('seals what waits to be packed now', async () => {
    await uploadedFiles(db, staging, [100, 200])
    expect(await runAdminTask(deps(), task('packs.seal'))).toBe(
      'Sealed 1 pack; it goes to Discord next.',
    )
    expect(await runAdminTask(deps(), task('packs.seal'))).toBe('Nothing was waiting to be packed.')
  })

  it('tries failing deletions again now', async () => {
    const { blob } = await lostPack({ read: true })
    await runAdminTask(deps(), task('blob.recover', String(blob.id)))
    await db.execute(sql`
      UPDATE blobs SET state = 'deleting', attempts = 3, last_error = 'Discord was down'
      WHERE id = ${blob.id}`)
    expect(await runAdminTask(deps(), task('deletions.retry'))).toBe('Deleted 1 blob.')
    expect(await stateOf('blobs', blob.id)).toBe('deleted')
    expect(await runAdminTask(deps(), task('deletions.retry'))).toBe('No deletion was failing.')
  })

  it('gives an upload that gave up one more try, through pg-boss itself', async () => {
    const boss = new PgBoss({ connectionString: database.url, supervise: false, schedule: false })
    await boss.start()
    try {
      await boss.createQueue(QUEUES.blobUpload, { retryLimit: 0 })
      const id = await boss.send(QUEUES.blobUpload, { blobId: 1 })
      const [job] = await boss.fetch(QUEUES.blobUpload)
      expect(job?.id).toBe(id)
      await boss.fail(QUEUES.blobUpload, job?.id ?? '', new Error('Discord was down'))
      expect(await runAdminTask(deps({ boss }), task('uploads.retry'))).toBe(
        'Gave 1 upload one more try, now. The failed count catches up within a minute.',
      )
      const { rows } = await db.execute<{ state: string; retry_limit: number }>(sql`
        SELECT state::text AS state, retry_limit FROM pgboss.job WHERE id = ${id ?? ''}`)
      expect(rows[0]).toEqual({ state: 'retry', retry_limit: 1 })
      expect(await runAdminTask(deps({ boss }), task('uploads.retry'))).toBe(
        'No upload had given up.',
      )
    } finally {
      await boss.stop({ graceful: false })
    }
  })

  it('says a Discord task needs Discord storage, and refuses tasks it doesn’t know', async () => {
    await expect(
      runAdminTask(deps({ storage: { store, discord: null } }), task('channel.create')),
    ).rejects.toThrow('This needs Discord storage')
    await expect(runAdminTask(deps(), task('everything.delete'))).rejects.toThrow()
  })
})
