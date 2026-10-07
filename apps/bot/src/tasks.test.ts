import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '@dfs/config'
import {
  appendJournal,
  createDatabase,
  createPool,
  purgeVersions,
  QUEUES,
  storageChannels,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordBlobStore, LocalJournalStore, Staging } from '@dfs/storage'
import { FakeDiscord, type FakeChannel } from '@dfs/storage/testing'
import { ChannelType } from '@discordjs/core'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { Compactor } from './compactor.ts'
import { Packer } from './packer.ts'
import { dataChannels } from './storage.ts'
import { runAdminTask, type TaskDeps } from './tasks.ts'
import { postJournal, settleBlobs, uploadedFiles } from './testing.ts'

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
    storage: { store, journal: new LocalJournalStore(directory), discord: discord as never },
    staging,
    packer: new Packer({ db, staging, sizes, maxWaitMs: 60_000 }),
    compactor: new Compactor({
      db,
      store,
      rule: { threshold: 0.3, packTargetBytes: sizes.packTargetBytes, minAgeDays: 7 },
    }),
    log: log as never,
    ...overrides,
  }
}

const task = (kind: string) => ({ kind, requestedBy: 'Admin' })

async function blobState(id: number): Promise<string> {
  const { rows } = await db.execute<{ state: string }>(
    sql`SELECT state FROM blobs WHERE id = ${id}`,
  )
  return rows[0]?.state ?? 'missing'
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

  it('seals what waits to be packed now', async () => {
    await uploadedFiles(db, staging, [100, 200])
    expect(await runAdminTask(deps(), task('packs.seal'))).toBe(
      'Sealed 1 pack; it goes to Discord next.',
    )
    expect(await runAdminTask(deps(), task('packs.seal'))).toBe('Nothing was waiting to be packed.')
  })

  it('merges packs that hold little now, whatever their age', async () => {
    const first = await uploadedFiles(db, staging, [100, 200])
    await settleBlobs({ db, staging, store, sizes })
    await uploadedFiles(db, staging, [100])
    await settleBlobs({ db, staging, store, sizes })
    await db.transaction(async (tx) => {
      const gone = first.files.slice(0, 1).map((file) => file.versionId)
      await appendJournal(tx, await purgeVersions(tx, first.ownerId, gone))
    })
    expect(await runAdminTask(deps(), task('packs.compact'))).toBe(
      'Merged 2 packs into 1, freeing 100 B; the old messages go within a minute or two.',
    )
    expect(await runAdminTask(deps(), task('packs.compact'))).toBe(
      'No packs held little enough to merge.',
    )
  })

  it('tries failing deletions again now', async () => {
    await uploadedFiles(db, staging, [100, 200])
    await settleBlobs({ db, staging, store, sizes })
    const { rows } = await db.execute<{ id: number }>(sql`
      UPDATE blobs SET state = 'deleting', released_at = now(), attempts = 3,
        last_error = 'Discord was down'
      WHERE state = 'stored' RETURNING id::float8 AS id`)
    const [blob] = rows
    if (!blob) throw new Error('Nothing was stored.')
    await postJournal(db)
    expect(await runAdminTask(deps(), task('deletions.retry'))).toBe('Deleted 1 blob.')
    expect(await blobState(blob.id)).toBe('deleted')
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
      runAdminTask(
        deps({ storage: { store, journal: new LocalJournalStore(directory), discord: null } }),
        task('channel.create'),
      ),
    ).rejects.toThrow('This needs Discord storage')
    for (const kind of ['everything.delete', 'blob.recover']) {
      await expect(runAdminTask(deps(), task(kind))).rejects.toThrow()
    }
  })
})
