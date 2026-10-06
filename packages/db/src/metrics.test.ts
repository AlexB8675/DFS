import { TIMING_BOUNDS } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createDatabase, createPool, type Database } from './client.ts'
import { Metrics, percentile, pruneMetrics, readMetrics } from './metrics.ts'
import { PostgresSampler } from './postgres-stats.ts'
import { sampleSystem } from './system-figures.ts'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'

const NOON = Date.UTC(2026, 9, 5, 12)
const HALF_MINUTE = 30_000
const MINUTE = 60_000
const DAY = 86_400_000

describe('metrics (DESIGN §16)', () => {
  let database: TestDatabase
  let db: Database
  let close: () => Promise<void>

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    const pool = createPool(database.url, {
      applicationName: 'dfs-tests',
      onError: () => undefined,
    })
    db = createDatabase(pool)
    close = () => pool.end()
  })

  afterAll(async () => {
    await close()
    await database.drop()
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM metrics`)
  })

  async function rows() {
    const { rows: found } = await db.execute<{
      name: string
      step: number
      at: number
      sum: number
      count: number
      max: number
    }>(sql`
      SELECT name, step, (extract(epoch FROM at) * 1000)::float8 AS at, sum, count, max
      FROM metrics ORDER BY name, step, at`)
    return found
  }

  it('adds what each process recorded to buckets of half a minute, a minute and an hour', async () => {
    const api = new Metrics()
    const other = new Metrics()
    api.record('http.requests', 1, NOON + 5_000)
    api.record('http.requests', 1, NOON + 40_000)
    api.record('http.requests', 1, NOON + 65_000)
    other.record('http.requests', 1, NOON + 10_000)
    api.record('discord.posted', 100, NOON)
    api.record('discord.posted', 300, NOON + 1000)
    await Promise.all([api.flush(db, NOON + 70_000), other.flush(db, NOON + 70_000)])
    // A later flush adds only what is new.
    api.record('http.requests', 1, NOON + 66_000)
    await api.flush(db, NOON + 80_000)

    expect(await rows()).toEqual([
      { name: 'discord.posted', step: 30, at: NOON, sum: 400, count: 2, max: 300 },
      { name: 'discord.posted', step: 60, at: NOON, sum: 400, count: 2, max: 300 },
      { name: 'discord.posted', step: 3600, at: NOON, sum: 400, count: 2, max: 300 },
      { name: 'http.requests', step: 30, at: NOON, sum: 2, count: 2, max: 1 },
      { name: 'http.requests', step: 30, at: NOON + HALF_MINUTE, sum: 1, count: 1, max: 1 },
      { name: 'http.requests', step: 30, at: NOON + MINUTE, sum: 2, count: 2, max: 1 },
      { name: 'http.requests', step: 60, at: NOON, sum: 3, count: 3, max: 1 },
      { name: 'http.requests', step: 60, at: NOON + MINUTE, sum: 2, count: 2, max: 1 },
      { name: 'http.requests', step: 3600, at: NOON, sum: 5, count: 5, max: 1 },
    ])
  })

  it('samples gauges at each flush, and keeps figures it couldn’t save for the next', async () => {
    const metrics = new Metrics()
    let streams: number | null = 3
    metrics.gauge('events.streams', () => streams)
    metrics.record('http.requests', 1, NOON)
    const down = { execute: () => Promise.reject(new Error('down')) } as unknown as Database
    await expect(metrics.flush(down, NOON)).rejects.toThrow('down')
    streams = null
    metrics.record('http.requests', 1, NOON + 1000)
    await metrics.flush(db, NOON + 2000)

    expect((await rows()).filter((row) => row.step === 60)).toEqual([
      { name: 'events.streams', step: 60, at: NOON, sum: 3, count: 1, max: 3 },
      { name: 'http.requests', step: 60, at: NOON, sum: 2, count: 2, max: 1 },
    ])
  })

  it('reads rates, events, averages, peaks and percentiles, one point per bucket', async () => {
    const metrics = new Metrics()
    // Six posts of 10 bytes in the first half minute, one of 60 two minutes later.
    for (let index = 0; index < 6; index++) {
      metrics.record('discord.posted', 10, NOON + index * 1000)
    }
    metrics.record('discord.posted', 60, NOON + 2 * MINUTE)
    // The bot ran these three minutes, and not before.
    for (let index = 0; index < 6; index++) {
      metrics.record('bot.rss', 1, NOON + index * HALF_MINUTE)
    }
    // A gauge sampled twice, then no more.
    metrics.record('storage.bytes', 100, NOON)
    metrics.record('storage.bytes', 300, NOON + HALF_MINUTE)
    // Ninety quick answers and ten slow ones.
    for (let index = 0; index < 90; index++) metrics.time('http.ms', 4, NOON)
    for (let index = 0; index < 10; index++) metrics.time('http.ms', 400, NOON)
    // In the half minute under way, which isn't read yet.
    metrics.record('discord.posted', 1000, NOON + 3 * MINUTE + 5_000)
    await metrics.flush(db, NOON + 3 * MINUTE + 10_000)

    // 10 seconds into the seventh half minute: every process has added its
    // figures for the sixth, not yet all of them for the seventh.
    const now = NOON + 3 * MINUTE + 10_000
    const read = await readMetrics(
      db,
      '1h',
      [
        'discord.posted:rate',
        'discord.posted:events',
        'storage.bytes:avg',
        'storage.bytes:max',
        'http.ms:p50',
        'http.ms:p95',
        'http.ms:max',
      ],
      now,
    )
    expect(read.bucketSeconds).toBe(30)
    expect(read.times).toHaveLength(120)
    // The last point is the last half minute read, not the one under way.
    expect(read.until).toBe(NOON + 3 * MINUTE)
    expect(read.times.at(-1)).toBe(NOON + 5 * HALF_MINUTE)
    const series = new Map(read.series.map((entry) => [entry.id, entry]))
    const lastSix = (id: string) => series.get(id)?.values.slice(-6)

    expect(lastSix('discord.posted:rate')).toEqual([2, 0, 0, 0, 2, 0])
    expect(lastSix('discord.posted:events')).toEqual([0.2, 0, 0, 0, 1 / 30, 0])
    // Before the bot ran, nothing was counted: no data, not 0.
    expect(series.get('discord.posted:rate')?.values.at(-7)).toBeNull()
    expect(series.get('discord.posted:rate')?.overall).toBe(120)
    expect(series.get('discord.posted:events')?.overall).toBe(7)
    expect(lastSix('storage.bytes:avg')).toEqual([100, 300, null, null, null, null])
    expect(lastSix('storage.bytes:max')).toEqual([100, 300, null, null, null, null])
    expect(series.get('storage.bytes:avg')?.overall).toBe(200)
    // The median is among the quick ones, within 2.5–5 ms; the 95th
    // percentile halfway into 350–500 ms, but no more than the slowest seen.
    expect(series.get('http.ms:p50')?.values.at(-6)).toBeCloseTo(2.5 + (50 / 90) * 2.5)
    expect(series.get('http.ms:p95')?.values.at(-6)).toBe(400)
    expect(series.get('http.ms:p95')?.values.at(-5)).toBeNull()
    expect(series.get('http.ms:p95')?.overall).toBe(400)
    expect(series.get('http.ms:max')?.overall).toBe(400)
  })

  it('reads hour buckets for the longer ranges', async () => {
    const metrics = new Metrics()
    metrics.record('uploads.bytes', 3600, NOON + 10 * MINUTE)
    metrics.record('uploads.bytes', 7200, NOON - 2 * 3_600_000)
    // The API ran these three hours.
    for (const at of [NOON - 2 * 3_600_000, NOON - 3_600_000, NOON + 10 * MINUTE]) {
      metrics.record('api.rss', 1, at)
    }
    // In the minute under way: in this hour's row, but not read yet.
    metrics.record('uploads.bytes', 999, NOON + 30 * MINUTE + 5_000)
    await metrics.flush(db, NOON + 30 * MINUTE + 10_000)

    const week = await readMetrics(db, '7d', ['uploads.bytes:rate'], NOON + 30 * MINUTE + 15_000)
    expect(week.bucketSeconds).toBe(3600)
    expect(week.times).toHaveLength(168)
    expect(week.until).toBe(NOON + 30 * MINUTE)
    // This hour, half read, from its minutes: 3600 bytes over 1800 seconds.
    expect(week.series[0]?.values.slice(-3)).toEqual([2, 0, 2])
    expect(week.series[0]?.values.at(-4)).toBeNull()
    expect(week.series[0]?.overall).toBe(10_800)
  })

  it('samples the system’s figures, without pg-boss’s tables yet', async () => {
    const metrics = new Metrics()
    await sampleSystem(db, metrics)
    await metrics.flush(db, NOON)
    const sampled = (await rows()).filter((row) => row.step === 60)
    expect(sampled.map((row) => row.name).sort()).toEqual(
      [
        'blobs.deleting',
        'blobs.lost',
        'blobs.waiting',
        'db.bytes',
        'files.bytes',
        'files.count',
        'queue.failed',
        'queue.pending',
        'sessions.count',
        'staging.bytes',
        'storage.blobs',
        'storage.bytes',
        'storage.live_bytes',
        'storage.packs',
        'sync.bytes',
        'sync.files',
        'users.count',
      ].sort(),
    )
    expect(sampled.find((row) => row.name === 'db.bytes')?.sum).toBeGreaterThan(0)
  })

  it('samples PostgreSQL: levels each time, totals as what they grew by since the last', async () => {
    const metrics = new Metrics()
    const sampler = new PostgresSampler()
    await sampler.sample(db, metrics)
    await metrics.flush(db, NOON)
    const first = (await rows()).filter((row) => row.step === 60)
    expect(first.map((row) => row.name).sort()).toEqual([
      'pg.active',
      'pg.connections',
      'pg.dead_rows',
      'pg.lock_waits',
      'pg.oldest_xact_ms',
    ])
    expect(first.find((row) => row.name === 'pg.connections')?.sum).toBeGreaterThan(0)

    // Work on a connection of its own, which flushes its statistics as it closes.
    const worker = new pg.Client({ connectionString: database.url })
    await worker.connect()
    for (let index = 0; index < 3; index++) await worker.query('SELECT 1')
    await worker.end()
    await sampler.sample(db, metrics)
    await metrics.flush(db)
    const totals = (await rows()).filter(
      (row) => row.step === 60 && !first.some((level) => level.name === row.name),
    )
    expect(totals.map((row) => row.name)).toContain('pg.commits')
    for (const row of totals) expect(row.sum).toBeGreaterThan(0)
  })

  it('drops half minutes after three hours, minutes after two days and hours after 400', async () => {
    const metrics = new Metrics()
    metrics.record('http.requests', 1, NOON - 4 * 3_600_000)
    await metrics.flush(db, NOON - 4 * 3_600_000)
    await pruneMetrics(db, NOON)
    expect((await rows()).map((row) => row.step)).toEqual([60, 3600])
    await db.execute(sql`DELETE FROM metrics`)

    metrics.record('http.requests', 1, NOON - 3 * DAY)
    await metrics.flush(db, NOON - 3 * DAY)
    await pruneMetrics(db, NOON)
    expect((await rows()).map((row) => row.step)).toEqual([3600])
    await pruneMetrics(db, NOON + 400 * DAY)
    expect(await rows()).toEqual([])
  })
})

describe('percentile', () => {
  it('interpolates within the bucket it falls in, up to the largest value seen', () => {
    expect(percentile([0, 0, 0], 0.5, null)).toBeNull()
    // 10 within 2.5–5 ms: the median is halfway.
    expect(percentile([0, 0, 10], 0.5, null)).toBe(3.75)
    // Past the last bound, the largest value seen ends the bucket.
    const counts = new Array<number>(TIMING_BOUNDS.length + 1).fill(0)
    counts[TIMING_BOUNDS.length] = 4
    expect(percentile(counts, 0.5, 30_000)).toBe(20_000)
    // Never past the largest value seen.
    expect(percentile([0, 0, 10], 0.99, 3)).toBe(3)
  })
})
