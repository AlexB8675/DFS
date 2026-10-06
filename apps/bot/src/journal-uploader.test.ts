import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createDatabase,
  createPool,
  journalBatches,
  pruneJournal,
  storageChannels,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordJournalStore, LocalJournalStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { ChannelType } from '@discordjs/core'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { JournalUploader } from './journal-uploader.ts'
import { instanceId, journalChannel } from './storage.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Database
let directory: string
let discord: FakeDiscord
let journalId: string

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-journal-test', onError: vi.fn() })
  db = createDatabase(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-journal-'))
  discord = new FakeDiscord()
  const category = discord.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
  const channel = discord.addChannel({
    name: 'dfs-journal',
    type: ChannelType.GuildText,
    parent_id: category.id,
  })
  journalId = channel.id
  await db
    .insert(storageChannels)
    .values({ discordChannelId: channel.id, name: 'dfs-journal', kind: 'journal' })
})

afterAll(async () => {
  await pool.end()
  await database.drop()
  await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  await db.execute(sql`DELETE FROM journal_batches`)
  await db.execute(sql`DELETE FROM journal`)
})

function store() {
  return new DiscordJournalStore({
    rest: discord,
    channel: () => journalChannel(db, discord, discord.guildId, 'DFS Dev'),
    instanceId: () => instanceId(db),
  })
}

/** Batches as the API leaves them, sealed bytes and all. */
async function staged(...numbers: number[]) {
  await db.insert(journalBatches).values(
    numbers.map((batchNo) => ({
      batchNo,
      firstId: batchNo * 10,
      lastId: batchNo * 10 + 9,
      recordCount: 10,
      sealed: Buffer.from(`sealed ${String(batchNo)}`),
      sizeBytes: 8,
      sha256: Buffer.alloc(32),
    })),
  )
}

describe('posting the journal (§8)', () => {
  it('posts staged batches to #dfs-journal in order, and forgets their bytes', async () => {
    await staged(2, 1)
    expect(await new JournalUploader({ db, journal: store() }).run()).toBe(2)

    const instance = await instanceId(db)
    const posted = discord.messages.filter((message) => message.channel_id === journalId)
    expect(posted.map((message) => message.content)).toEqual([
      `dfs1 j=1 ids=10-19 i=${instance}`,
      `dfs1 j=2 ids=20-29 i=${instance}`,
    ])
    expect(posted.map((message) => message.attachments[0]?.filename)).toEqual(['j1.bin', 'j2.bin'])
    const { rows } = await db.execute<{ state: string; sealed: Buffer | null; message_id: string }>(
      sql`SELECT state::text AS state, sealed, message_id FROM journal_batches ORDER BY batch_no`,
    )
    expect(rows).toEqual(
      posted.map((message) => ({ state: 'stored', sealed: null, message_id: message.id })),
    )
  })

  it('keeps a batch that fails first in line, and waits longer before trying again', async () => {
    await staged(3, 4)
    let fails = true
    const uploader = new JournalUploader({
      db,
      journal: {
        put: (batch, data) =>
          fails ? Promise.reject(new Error('Discord is down')) : store().put(batch, data),
      },
    })
    await expect(uploader.run()).rejects.toThrow('Discord is down')
    const { rows: failed } = await db.execute<{ attempts: number; last_error: string }>(sql`
      SELECT attempts, last_error FROM journal_batches WHERE batch_no = 3`)
    expect(failed).toEqual([{ attempts: 1, last_error: 'Discord is down' }])

    fails = false
    // Not yet: the wait after a failure.
    expect(await uploader.run(Date.now())).toBe(0)
    expect(await uploader.run(Date.now() + 10_000)).toBe(2)
  })

  it('says no journal channel is registered, and posts nothing elsewhere', async () => {
    await staged(5)
    const elsewhere = new DiscordJournalStore({
      rest: discord,
      channel: () => journalChannel(db, discord, discord.guildId, 'Another category'),
      instanceId: () => instanceId(db),
    })
    await expect(new JournalUploader({ db, journal: elsewhere }).run()).rejects.toThrow(
      'no #dfs-journal channel',
    )
  })

  it('writes batches to a folder with the local blob store', async () => {
    await staged(6)
    expect(await new JournalUploader({ db, journal: new LocalJournalStore(directory) }).run()).toBe(
      1,
    )
    expect((await readFile(path.join(directory, 'journal', 'j6.bin'))).toString()).toBe('sealed 6')
  })

  it('drops records a week after their batch is posted, below the first batch not posted', async () => {
    await db.execute(sql`
      INSERT INTO journal (id, kind, record, batch_no)
      OVERRIDING SYSTEM VALUE
      SELECT n, 'node.upsert', '{}'::jsonb, (n - 1) / 10 + 1 FROM generate_series(1, 30) n`)
    await staged(1, 2, 3)
    await db.execute(sql`
      UPDATE journal_batches SET first_id = (batch_no - 1) * 10 + 1, last_id = batch_no * 10`)
    await db.execute(sql`
      UPDATE journal_batches SET state = 'stored', sealed = NULL, stored_at = now() - interval '8 days'
      WHERE batch_no IN (1, 3)`)
    // Batch 2 isn't posted yet: nothing past it goes, batch 3 included.
    expect(await pruneJournal(db)).toBe(10)
    await db.execute(sql`
      UPDATE journal_batches SET state = 'stored', sealed = NULL, stored_at = now() - interval '1 day'
      WHERE batch_no = 2`)
    // Posted now, batch 2 no longer holds back batch 3, a week on Discord: both go.
    expect(await pruneJournal(db)).toBe(20)
    expect(await pruneJournal(db)).toBe(0)
  })
})
