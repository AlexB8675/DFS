import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { auditLog, createDatabase, createPool, shareLinks, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import {
  cleanUp,
  dropUnneededVersions,
  emptyOldTrash,
  giveUpIdleUploads,
  onTheClock,
} from './leader-work.ts'
import { uploadedFiles } from './testing.ts'

// The leader samples the system once in each half-minute bucket (DESIGN §16):
// on the clock, so a slow run never pushes a sample into the next bucket.

describe('onTheClock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a little past each mark, once in each bucket, however long runs take', async () => {
    const start = Date.UTC(2026, 9, 6, 12)
    vi.useFakeTimers({ now: start + 7_000 })
    const runs: number[] = []
    const ticking = onTheClock(30_000, 2_000, { warn: vi.fn() }, 'sampling', async () => {
      runs.push(Date.now())
      // Each run takes 4 s, which `repeat` would add to every interval.
      await new Promise((resolve) => setTimeout(resolve, 4_000))
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await ticking.stop()
    expect(runs.map((at) => (at - start) / 1000)).toEqual(
      Array.from({ length: 10 }, (_, index) => 32 + 30 * index),
    )
  })

  it('keeps to the clock after a run fails, and says so', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12) })
    const log = { warn: vi.fn() }
    let calls = 0
    const ticking = onTheClock(30_000, 2_000, log, 'sampling', () => {
      calls += 1
      return Promise.reject(new Error('down'))
    })
    await vi.advanceTimersByTimeAsync(61_000)
    await ticking.stop()
    expect(calls).toBe(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
})

describe('cleanUp', () => {
  let database: TestDatabase
  let pool: pg.Pool
  let db: Database
  let directory: string

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    pool = createPool(database.url, { applicationName: 'dfs-janitor-test', onError: vi.fn() })
    db = createDatabase(pool)
    directory = await mkdtemp(path.join(tmpdir(), 'dfs-janitor-'))
  })

  afterAll(async () => {
    await pool.end()
    await database.drop()
    await rm(directory, { recursive: true, force: true })
  })

  it('empties what has been in the trash past its days, as the system', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, files } = await uploadedFiles(db, staging, [100, 200])
    const [old, recent] = files
    if (!old || !recent) throw new Error('No test files.')
    // Ages by the database's clock, which the janitor goes by.
    await db.execute(
      sql`UPDATE nodes SET deleted_at = now() - interval '31 days' WHERE id = ${old.nodeId}`,
    )
    await db.execute(
      sql`UPDATE nodes SET deleted_at = now() - interval '29 days' WHERE id = ${recent.nodeId}`,
    )

    expect(await emptyOldTrash(db, staging, 30)).toBe(1)
    const { rows: left } = await db.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE id = ANY(ARRAY[${old.nodeId}, ${recent.nodeId}]::uuid[])`)
    expect(left.map((row) => row.id)).toEqual([recent.nodeId])
    // Its staged frame and its quota go with it; the other's stay.
    await expect(staging.read(staging.framePath(old.versionId, 0))).rejects.toThrow()
    expect((await staging.read(staging.framePath(recent.versionId, 0))).length).toBe(200)
    const { rows: used } = await db.execute<{ used: number }>(sql`
      SELECT used_bytes::float8 AS used FROM users WHERE id = ${ownerId}`)
    expect(used[0]?.used).toBe(200)

    const { rows: logged } = await db.execute<{ user_id: string | null; details: string }>(sql`
      SELECT user_id, meta->>'details' AS details FROM audit_log
      WHERE action = 'node.purged' AND node_id = ${old.nodeId}`)
    expect(logged).toEqual([{ user_id: null, details: 'after 30 days in the trash' }])
    const { rows: journaled } = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM journal
      WHERE kind = 'node.purge' AND record->>'id' = ${old.nodeId}`)
    expect(journaled[0]?.count).toBe(1)
    // Nothing else is due.
    expect(await emptyOldTrash(db, staging, 30)).toBe(0)
  })

  it('gives up uploads whose page went quiet for ten minutes, and keeps those it hears of', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, files } = await uploadedFiles(db, staging, [100, 200])
    const [quiet, heard] = files
    if (!quiet || !heard) throw new Error('No test files.')
    // As a first upload still receiving: no current version, its bytes reserved.
    for (const [file, age] of [
      [quiet, '11 minutes'],
      [heard, '2 minutes'],
    ] as const) {
      await db.execute(sql`UPDATE nodes SET current_version_id = NULL WHERE id = ${file.nodeId}`)
      await db.execute(
        sql`UPDATE file_versions SET state = 'uploading' WHERE id = ${file.versionId}`,
      )
      await db.execute(sql`
        INSERT INTO upload_sessions (user_id, node_id, version_id, reserved_bytes, expires_at, alive_at)
        VALUES (${ownerId}, ${file.nodeId}, ${file.versionId}, 1000, now() + interval '1 day',
          now() - ${age}::interval)`)
    }
    await db.execute(sql`UPDATE users SET reserved_bytes = 2000 WHERE id = ${ownerId}`)

    await giveUpIdleUploads(db, staging)
    const { rows: left } = await db.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE id = ANY(ARRAY[${quiet.nodeId}, ${heard.nodeId}]::uuid[])`)
    expect(left.map((row) => row.id)).toEqual([heard.nodeId])
    await expect(staging.read(staging.framePath(quiet.versionId, 0))).rejects.toThrow()
    const { rows: owner } = await db.execute<{ reserved: number }>(sql`
      SELECT reserved_bytes::float8 AS reserved FROM users WHERE id = ${ownerId}`)
    expect(owner[0]?.reserved).toBe(1000)
  })

  it('deletes an earlier version once the last link serving it stops working', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, files } = await uploadedFiles(db, staging, [100, 200])
    const [first, second] = files
    if (!first || !second) throw new Error('No test files.')
    // The second upload is the file's second version, its current one.
    await db.execute(sql`
      UPDATE file_versions SET node_id = ${first.nodeId}, version_no = 2 WHERE id = ${second.versionId}`)
    await db.execute(
      sql`UPDATE nodes SET current_version_id = ${second.versionId} WHERE id = ${first.nodeId}`,
    )
    const [link] = await db
      .insert(shareLinks)
      .values({
        nodeId: first.nodeId,
        versionId: first.versionId,
        tokenHash: randomBytes(32),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning()
    if (!link) throw new Error('No test link.')
    const used = async () => {
      const { rows } = await db.execute<{ used: number }>(sql`
        SELECT used_bytes::float8 AS used FROM users WHERE id = ${ownerId}`)
      return rows[0]?.used
    }

    await dropUnneededVersions(db, staging)
    expect(await used()).toBe(300)

    await db.execute(sql`
      UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = ${link.id}`)
    await dropUnneededVersions(db, staging)
    expect(await used()).toBe(200)
    const { rows } = await db.execute<{ version_id: string | null }>(sql`
      SELECT version_id FROM share_links WHERE id = ${link.id}`)
    // The link knows its version is gone, and works no more (§7.5).
    expect(rows).toEqual([{ version_id: null }])
    // Its staged frame went with it; the current version's stays.
    await expect(staging.read(staging.framePath(first.versionId, 0))).rejects.toThrow()
    await expect(staging.read(staging.framePath(second.versionId, 0))).resolves.toHaveLength(200)
    const { rows: versions } = await db.execute<{ id: string }>(sql`
      SELECT id FROM file_versions WHERE node_id = ${first.nodeId}`)
    expect(versions.map((row) => row.id)).toEqual([second.versionId])
  })

  it('keeps the audit log for a year', async () => {
    // Ages by the database's clock, which the janitor goes by.
    const entry = (action: string, age: string) => ({
      action,
      meta: { target: '', details: null },
      at: sql`now() - ${age}::interval`,
    })
    await db
      .insert(auditLog)
      .values([
        entry('auth.login', '1 year 1 hour'),
        entry('auth.login_failed', '364 days'),
        entry('user.created', '1 day'),
      ])

    await cleanUp(db, new Staging(path.join(directory, 'staging')))
    const left = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(sql`${auditLog.action} IN ('auth.login', 'auth.login_failed', 'user.created')`)
      .orderBy(auditLog.id)
    expect(left.map((row) => row.action)).toEqual(['auth.login_failed', 'user.created'])
  })
})
