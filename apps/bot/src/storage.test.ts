import { createDatabase, createPool, storageChannels, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordBlobStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { dataChannels, refreshBlobUrls } from './storage.ts'

describe('refreshBlobUrls (DESIGN.md §6.2)', () => {
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

  it('signs stored blobs, saves their URLs, and skips any not stored', async () => {
    const discord = new FakeDiscord()
    const channel = discord.addTextChannel('storage-00')
    await db.insert(storageChannels).values({ discordChannelId: channel.id, name: 'storage-00' })
    const store = new DiscordBlobStore({
      rest: discord,
      channels: () => dataChannels(db),
      maxBytes: 1024,
      instanceId: () => Promise.resolve('0123456789ab'),
      perChannel: 2,
      fetch: discord.fetch,
    })
    const ids: number[] = []
    for (const state of ['stored', 'deleting'] as const) {
      const { rows } = await db.execute<{ id: number }>(sql`
        INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, released_at)
        VALUES ('solo', ${state}, 4, 4, 1, ${state === 'deleting' ? new Date() : null})
        RETURNING id::float8 AS id`)
      const id = rows[0]?.id ?? 0
      const { location } = await store.put({ id, kind: 'solo', frameCount: 1 }, () =>
        Promise.resolve(new Uint8Array(4)),
      )
      await db.execute(sql`
        UPDATE blobs SET channel_id = ${location.channelId}, message_id = ${location.messageId},
          attachment_id = ${location.attachmentId}
        WHERE id = ${id}`)
      ids.push(id)
    }

    const signed = await refreshBlobUrls(db, store, [...ids, 999])
    expect([...signed.keys()]).toEqual([ids[0]])
    const { rows } = await db.execute<{
      id: number
      cdn_url: string | null
      expires: number | null
    }>(
      sql`SELECT id::float8 AS id, cdn_url,
        (extract(epoch FROM cdn_url_expires_at) * 1000)::float8 AS expires
      FROM blobs ORDER BY id`,
    )
    const url = signed.get(ids[0] ?? 0)
    expect(rows).toEqual([
      { id: ids[0], cdn_url: url?.url, expires: url?.expiresAt.getTime() },
      { id: ids[1], cdn_url: null, expires: null },
    ])
  })
})
