import { createDatabase, createPool, storageChannels, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { FakeDiscord } from '@dfs/storage/testing'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, inject, vi } from 'vitest'
import { reconcileOrphans } from './reconciler.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Database

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-reconciler-test', onError: vi.fn() })
  db = createDatabase(pool)
})

afterAll(async () => {
  await pool.end()
  await database.drop()
})

const ours = 'aaaaaaaaaaaa'
const theirs = 'bbbbbbbbbbbb'
const HOUR = 60 * 60_000

describe('reconcileOrphans (DESIGN.md §6.1)', () => {
  it('deletes only its own unrecorded data messages that have settled, and remembers where it stopped', async () => {
    const discord = new FakeDiscord()
    const channel = discord.addTextChannel('storage-00')
    await db.insert(storageChannels).values({ discordChannelId: channel.id, name: 'storage-00' })
    const start = Date.now()
    discord.clock = () => start - 2 * HOUR
    const say = (content: string, author?: string) =>
      discord.addMessage(channel.id, content, author)

    const { rows } = await db.execute<{ id: number }>(sql`
      INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count)
      VALUES ('solo', 'stored', 4, 4, 1) RETURNING id::float8 AS id`)
    const blobId = rows[0]?.id ?? 0
    const recorded = say(`dfs1 b=${String(blobId)} k=solo n=1 i=${ours}`)
    await db.execute(sql`UPDATE blobs SET message_id = ${recorded.id} WHERE id = ${blobId}`)
    const duplicate = say(`dfs1 b=${String(blobId)} k=solo n=1 i=${ours}`)
    const unknown = say(`dfs1 b=999999 k=pack n=3 i=${ours}`)
    const otherDatabase = say(`dfs1 b=999999 k=pack n=3 i=${theirs}`)
    const someoneElse = say(`dfs1 b=999999 k=pack n=3 i=${ours}`, '200000000000000002')
    // More than a page of orphans, before one that has only just been posted.
    const many = Array.from({ length: 120 }, () => say(`dfs1 b=888888 k=solo n=1 i=${ours}`))
    discord.clock = () => start - 10 * 60_000
    const recent = say(`dfs1 b=777777 k=solo n=1 i=${ours}`)

    const first = await reconcileOrphans({ db, rest: discord, instanceId: ours, now: start })
    expect(first).toEqual({ checked: 3 + many.length, deleted: 2 + many.length, failed: 0 })
    const left = discord.messages.map((message) => message.id)
    expect(left).toEqual([recorded.id, otherDatabase.id, someoneElse.id, recent.id])
    expect(left).not.toContain(duplicate.id)
    expect(left).not.toContain(unknown.id)
    const { rows: checkpoint } = await db.execute<{ reconciled_through: string }>(sql`
      SELECT reconciled_through FROM storage_channels WHERE discord_channel_id = ${channel.id}`)
    expect(checkpoint[0]?.reconciled_through).toBe(many.at(-1)?.id)

    // An hour on, the recent one has settled; nothing before the checkpoint is read again.
    discord.requests.length = 0
    const second = await reconcileOrphans({
      db,
      rest: discord,
      instanceId: ours,
      now: start + HOUR,
    })
    expect(second).toEqual({ checked: 1, deleted: 1, failed: 0 })
    expect(discord.messages.map((message) => message.id)).not.toContain(recent.id)
    expect(discord.requests.filter((request) => request.startsWith('GET /channels'))).toHaveLength(
      1,
    )
  })

  it('cleans the other channels when one can’t be read', async () => {
    await db.execute(sql`DELETE FROM storage_channels`)
    const discord = new FakeDiscord()
    const start = Date.now()
    discord.clock = () => start - 2 * HOUR
    const kept = discord.addTextChannel('storage-01')
    // Registered, but gone from Discord: the first in ID order.
    await db.insert(storageChannels).values([
      {
        id: '00000000-0000-7000-8000-000000000001',
        discordChannelId: '100000000000000055',
        name: 'gone',
      },
      { discordChannelId: kept.id, name: 'storage-01' },
    ])
    const orphan = discord.addMessage(kept.id, `dfs1 b=666666 k=solo n=1 i=${ours}`)
    const warn = vi.fn()
    const report = await reconcileOrphans({
      db,
      rest: discord,
      instanceId: ours,
      log: { warn },
      now: start,
    })
    expect(report).toMatchObject({ deleted: 1, failed: 1 })
    expect(discord.messages.map((message) => message.id)).not.toContain(orphan.id)
    expect(warn).toHaveBeenCalledOnce()
  })
})
