import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createDatabase, createPool, type Database } from './client.ts'
import { Metrics, percentile, pruneMetrics, readMetrics } from './metrics.ts'
import { sampleSystem } from './system-figures.ts'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'

const NOON = Date.UTC(2026, 9, 5, 12)
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

  it('adds what each process recorded to buckets of a minute and of an hour', async () => {
    const api = new Metrics()
    const other = new Metrics()
    api.record('http.requests', 1, NOON + 5_000)
    api.record('http.requests', 1, NOON + 65_000)
    other.record('http.requests', 1, NOON + 10_000)
    api.record('discord.posted', 100, NOON)
    api.record('discord.posted', 300, NOON + 1000)
    await Promise.all([api.flush(db, NOON + 70_000), other.flush(db, NOON + 70_000)])
    // A later flush adds only what is new.
    api.record('http.requests', 1, NOON + 66_000)
    await api.flush(db, NOON + 80_000)

    expect(await rows()).toEqual([
      { name: 'discord.posted', step: 60, at: NOON, sum: 400, count: 2, max: 300 },
      { name: 'discord.posted', step: 3600, at: NOON, sum: 400, count: 2, max: 300 },
      { name: 'http.requests', step: 60, at: NOON, sum: 2, count: 2, max: 1 },
      { name: 'http.requests', step: 60, at: NOON + MINUTE, sum: 2, count: 2, max: 1 },
      { name: 'http.requests', step: 3600, at: NOON, sum: 4, count: 4, max: 1 },
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
    // Six posts of 10 bytes in the first minute, one of 60 two minutes later.
    for (let index = 0; index < 6; index++) {
      metrics.record('discord.posted', 10, NOON + index * 1000)
    }
    metrics.record('discord.posted', 60, NOON + 2 * MINUTE)
    // A gauge sampled twice, then no more.
    metrics.record('storage.bytes', 100, NOON)
    metrics.record('storage.bytes', 300, NOON + 30_000)
    // Ninety quick answers and ten slow ones.
    for (let index = 0; index < 90; index++) metrics.time('http.ms', 4, NOON)
    for (let index = 0; index < 10; index++) metrics.time('http.ms', 400, NOON)
    await metrics.flush(db, NOON + 2 * MINUTE)

    // Half a minute into the third minute.
    const now = NOON + 2 * MINUTE + 30_000
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
    expect(read.bucketSeconds).toBe(60)
    expect(read.times).toHaveLength(60)
    expect(read.times.at(-1)).toBe(NOON + 2 * MINUTE)
    const series = new Map(read.series.map((entry) => [entry.id, entry]))
    const lastThree = (id: string) => series.get(id)?.values.slice(-3)

    // The minute under way counts only the 30 seconds it has run.
    expect(lastThree('discord.posted:rate')).toEqual([1, 0, 2])
    expect(lastThree('discord.posted:events')).toEqual([0.1, 0, 1 / 30])
    expect(series.get('discord.posted:rate')?.overall).toBe(120)
    expect(series.get('discord.posted:events')?.overall).toBe(7)
    expect(lastThree('storage.bytes:avg')).toEqual([200, null, null])
    expect(lastThree('storage.bytes:max')).toEqual([300, null, null])
    expect(series.get('storage.bytes:avg')?.overall).toBe(200)
    // The median is among the quick ones; the 95th percentile halfway into 250–500 ms.
    expect(series.get('http.ms:p50')?.values.at(-3)).toBeCloseTo((50 / 90) * 5)
    expect(series.get('http.ms:p95')?.values.at(-3)).toBeCloseTo(375)
    expect(series.get('http.ms:p95')?.values.at(-2)).toBeNull()
    expect(series.get('http.ms:p95')?.overall).toBeCloseTo(375)
    expect(series.get('http.ms:max')?.overall).toBe(400)
  })

  it('reads hour buckets for the longer ranges', async () => {
    const metrics = new Metrics()
    metrics.record('uploads.bytes', 3600, NOON + 10 * MINUTE)
    metrics.record('uploads.bytes', 7200, NOON - 2 * 3_600_000)
    await metrics.flush(db, NOON + 10 * MINUTE)

    const week = await readMetrics(db, '7d', ['uploads.bytes:rate'], NOON + 30 * MINUTE)
    expect(week.bucketSeconds).toBe(3600)
    expect(week.times).toHaveLength(168)
    // Half an hour into this hour: 3600 bytes over 1800 seconds.
    expect(week.series[0]?.values.slice(-3)).toEqual([2, 0, 2])
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

  it('drops minutes after two days and hours after 400', async () => {
    const metrics = new Metrics()
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
    // 10 between 0 and 5 ms: the median is halfway.
    expect(percentile([10], 0.5, null)).toBe(2.5)
    // Past the last bound, the largest value seen ends the bucket.
    const counts = new Array<number>(12).fill(0)
    counts[11] = 4
    expect(percentile(counts, 0.5, 30_000)).toBe(20_000)
    expect(percentile([10], 0.99, 3)).toBe(3)
  })
})
