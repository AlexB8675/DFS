import { auditLog, createDatabase, createPool, storageChannels, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { FakeDiscord } from '@dfs/storage/testing'
import { eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { setUpDiscord } from './discord-setup.ts'

describe('dfs setup (DESIGN.md §4)', () => {
  let database: TestDatabase
  let pool: Pool
  let db: Database

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    pool = createPool(database.url, { applicationName: 'dfs-test', onError: () => undefined })
    db = createDatabase(pool)
  })

  afterAll(async () => {
    await pool.end()
    await database.drop()
  })

  it('registers the channels it makes, once', async () => {
    const discord = new FakeDiscord()
    const settings = { guildId: discord.guildId, categoryName: 'DFS Dev' }

    const first = await setUpDiscord(db, discord, settings)
    expect(first.changes).toHaveLength(8)
    expect(first.registered).toEqual([
      'storage-00',
      'storage-01',
      'storage-02',
      'storage-03',
      'dfs-journal',
      'dfs-backups',
      'dfs-log',
    ])
    const rows = await db.select().from(storageChannels).orderBy(storageChannels.id)
    expect(rows.map(({ name, kind, enabled }) => [name, kind, enabled])).toEqual([
      ['storage-00', 'data', true],
      ['storage-01', 'data', true],
      ['storage-02', 'data', true],
      ['storage-03', 'data', true],
      ['dfs-journal', 'journal', true],
      ['dfs-backups', 'backup', true],
      ['dfs-log', 'log', true],
    ])
    for (const row of rows) {
      expect(discord.channel(row.discordChannelId).name).toBe(row.name)
    }

    expect(await setUpDiscord(db, discord, settings)).toEqual({ changes: [], registered: [] })
    expect(await db.select().from(storageChannels)).toHaveLength(7)
    const audited = await db
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.action, 'channel.created'))
      .orderBy(auditLog.id)
    expect(audited).toHaveLength(7)
    expect(audited[0]?.meta).toEqual({ target: 'storage-00', details: 'dfs setup' })
  })
})
