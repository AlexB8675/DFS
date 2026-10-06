import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { auditLog, createDatabase, createPool, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { cleanUp, onTheClock } from './leader-work.ts'

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
    const left = await db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.id)
    expect(left.map((row) => row.action)).toEqual(['auth.login_failed', 'user.created'])
  })
})
