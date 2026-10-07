import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendJournal, createDatabase, createPool, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { LocalBlobStore, Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { collectGarbage, uploadsWaiting } from './collector.ts'
import { postJournal } from './testing.ts'
import { storeBlobs } from './uploader.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Database
let directory: string
let staging: Staging
let store: LocalBlobStore

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-collector-test', onError: vi.fn() })
  db = createDatabase(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-collector-'))
  staging = new Staging(path.join(directory, 'staging'))
  store = new LocalBlobStore(path.join(directory, 'stored'))
})

afterAll(async () => {
  await pool.end()
  await database.drop()
  await rm(directory, { recursive: true, force: true })
})

const where = (id: number) => ({ id, channelId: null, messageId: null, attachmentId: null })

async function staged(): Promise<number> {
  const stagedPath = staging.framePath(crypto.randomUUID(), 0)
  await staging.write(stagedPath, new Uint8Array([1, 2, 3, 4]))
  const { rows } = await db.execute<{ id: number }>(sql`
    INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, staged_path)
    VALUES ('solo', 'staged', 4, 4, 1, ${stagedPath}) RETURNING id::float8 AS id`)
  return rows[0]?.id ?? 0
}

async function stateOf(id: number): Promise<string | undefined> {
  const { rows } = await db.execute<{ state: string }>(
    sql`SELECT state FROM blobs WHERE id = ${id}`,
  )
  return rows[0]?.state
}

describe('collectGarbage (DESIGN.md §6.4)', () => {
  it('sends a blob purged while it was being stored to the GC, which deletes it', async () => {
    const id = await staged()
    expect(await uploadsWaiting(db)).toBe(true)
    const put = store.put.bind(store)
    const spy = vi.spyOn(store, 'put').mockImplementation(async (blob, read) => {
      const stored = await put(blob, read)
      // A purge lands while the post is under way.
      await db.execute(sql`UPDATE blobs SET live_bytes = 0 WHERE id = ${id}`)
      return stored
    })
    try {
      expect(await storeBlobs({ db, staging, store }, [id])).toEqual(new Map())
    } finally {
      spy.mockRestore()
    }
    expect(await stateOf(id)).toBe('deleting')
    expect(await uploadsWaiting(db)).toBe(false)

    await postJournal(db)
    expect(await collectGarbage({ db, staging, store }, 10)).toBe(1)
    expect(await stateOf(id)).toBe('deleted')
    await expect(store.read(where(id), 0, 4)).rejects.toThrow()
    const { rows } = await db.execute<{ record: unknown }>(sql`
      SELECT record FROM journal WHERE kind = 'blob.deleted' ORDER BY id DESC LIMIT 1`)
    expect(rows[0]?.record).toEqual({ id })
  })

  it('keeps a blob it could not delete, to try again', async () => {
    const id = await staged()
    await storeBlobs({ db, staging, store }, [id])
    await db.execute(sql`UPDATE blobs SET state = 'deleting', released_at = now() WHERE id = ${id}`)
    await postJournal(db)
    const failing = vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('rate limited'))
    const log = { warn: vi.fn() }
    try {
      expect(await collectGarbage({ db, staging, store, log }, 10)).toBe(0)
    } finally {
      failing.mockRestore()
    }
    expect(await stateOf(id)).toBe('deleting')
    expect(log.warn).toHaveBeenCalledOnce()
    expect(await collectGarbage({ db, staging, store }, 10)).toBe(1)
    expect(await stateOf(id)).toBe('deleted')
  })

  it('tries a blob that keeps failing after the others', async () => {
    const stuck = await staged()
    const next = await staged()
    await storeBlobs({ db, staging, store }, [stuck, next])
    await db.execute(sql`
      UPDATE blobs SET state = 'deleting', released_at = now() WHERE id IN (${stuck}, ${next})`)
    await postJournal(db)
    const remove = store.delete.bind(store)
    const failing = vi.spyOn(store, 'delete').mockImplementation(async (blob) => {
      if (blob.id === stuck) throw new Error('Missing Permissions')
      await remove(blob)
    })
    try {
      // One per round, as while uploads wait: the stuck blob mustn't hold up the next.
      expect(await collectGarbage({ db, staging, store }, 1)).toBe(0)
      expect(await collectGarbage({ db, staging, store }, 1)).toBe(1)
    } finally {
      failing.mockRestore()
    }
    expect(await stateOf(next)).toBe('deleted')
    const { rows } = await db.execute<{ attempts: number; last_error: string }>(sql`
      SELECT attempts, last_error FROM blobs WHERE id = ${stuck}`)
    expect(rows[0]).toEqual({ attempts: 1, last_error: 'Missing Permissions' })
  })

  it('deletes a message only once the journal saying why is on Discord', async () => {
    const id = await staged()
    await storeBlobs({ db, staging, store }, [id])
    await postJournal(db)
    // Released by a purge, journaled in the same transaction.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE blobs SET state = 'deleting', live_bytes = 0, released_at = now()
        WHERE id = ${id}`)
      await appendJournal(tx, [{ kind: 'version.purged', record: { id: crypto.randomUUID() } }])
    })
    // Not sealed yet, then sealed but not posted.
    await collectGarbage({ db, staging, store }, 10)
    expect(await stateOf(id)).toBe('deleting')
    await db.execute(sql`
      WITH batch AS (
        INSERT INTO journal_batches
          (batch_no, first_id, last_id, record_count, state, size_bytes, sha256)
        SELECT (SELECT max(batch_no) FROM journal_batches) + 1, min(id), max(id), count(*),
          'staged', 0, decode('00', 'hex')
        FROM journal WHERE batch_no IS NULL
        RETURNING batch_no
      )
      UPDATE journal SET batch_no = batch.batch_no FROM batch WHERE journal.batch_no IS NULL`)
    await collectGarbage({ db, staging, store }, 10)
    expect(await stateOf(id)).toBe('deleting')

    await db.execute(sql`UPDATE journal_batches SET state = 'stored' WHERE state = 'staged'`)
    await collectGarbage({ db, staging, store }, 10)
    expect(await stateOf(id)).toBe('deleted')
  })
})
