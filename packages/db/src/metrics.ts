import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  METRIC_RANGES,
  METRIC_RETENTION_SECONDS,
  METRIC_STEPS,
  parseSeriesId,
  TIMING_BOUNDS,
  timingBucketName,
  type MetricName,
  type MetricRange,
  type MetricReading,
  type MetricSeries,
} from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { textArray } from './folder-stats.ts'

// Metrics (DESIGN.md §16). Each process records what it does in memory, by
// minute, and adds it to the `metrics` table every few seconds, in buckets of
// a minute and of an hour, where other processes' figures add up with its
// own. The admin's graphs read them back with `readMetrics`.

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** How often a process adds what it recorded to the table. */
const FLUSH_EVERY_MS = 10_000
/** While the database is out of reach, figures older than this are let go. */
const KEEP_UNSAVED_MS = 60 * MINUTE_MS

interface Bucket {
  name: string
  /** The minute's start, in milliseconds since 1970. */
  at: number
  sum: number
  count: number
  max: number
}

interface Log {
  warn: (details: object, message: string) => void
  info: (details: object | string, message?: string) => void
}

export class Metrics {
  /** Recorded since the last flush, by name and minute. */
  #pending = new Map<string, Bucket>()
  readonly #gauges = new Map<MetricName, () => number | null>()

  /** An event of a counter, with its amount; or a gauge's sample. */
  record(name: MetricName, value = 1, now = Date.now()): void {
    this.#add(name, value, now)
  }

  /** A duration of a `timing` metric, also counted in its bucket for percentiles. */
  time(name: MetricName, ms: number, now = Date.now()): void {
    this.#add(name, ms, now)
    const index = TIMING_BOUNDS.findIndex((bound) => ms <= bound)
    this.#add(timingBucketName(name, index < 0 ? TIMING_BOUNDS.length : index), 1, now)
  }

  /** A level read at every flush, such as memory or open streams. `null` skips a sample. */
  gauge(name: MetricName, read: () => number | null): void {
    this.#gauges.set(name, read)
  }

  /**
   * Samples the gauges and adds everything recorded to the table. Rows go in
   * one statement, in key order, so processes flushing together queue behind
   * each other instead of deadlocking. On failure, the figures wait for the
   * next flush.
   */
  async flush(db: Database, now = Date.now()): Promise<void> {
    for (const [name, read] of this.#gauges) {
      const value = read()
      if (value !== null && Number.isFinite(value)) this.#add(name, value, now)
    }
    if (this.#pending.size === 0) return
    const taken = this.#pending
    this.#pending = new Map()
    const rows = new Map<string, Bucket & { step: number }>()
    for (const bucket of taken.values()) {
      addRow(rows, bucket, METRIC_STEPS.minute, bucket.at)
      addRow(rows, bucket, METRIC_STEPS.hour, bucket.at - (bucket.at % HOUR_MS))
    }
    try {
      await db.execute(sql`
        INSERT INTO metrics (name, step, at, sum, count, max)
        SELECT name, step, to_timestamp(at / 1000), sum, count, max
        FROM jsonb_to_recordset(${JSON.stringify([...rows.values()])}::jsonb)
          AS row(name text, step int, at float8, sum float8, count float8, max float8)
        ORDER BY name, step, at
        ON CONFLICT (name, step, at) DO UPDATE SET
          sum = metrics.sum + excluded.sum,
          count = metrics.count + excluded.count,
          max = greatest(metrics.max, excluded.max)`)
    } catch (error) {
      for (const [key, bucket] of taken) {
        if (now - bucket.at > KEEP_UNSAVED_MS) continue
        const newer = this.#pending.get(key)
        if (newer) {
          newer.sum += bucket.sum
          newer.count += bucket.count
          newer.max = Math.max(newer.max, bucket.max)
        } else {
          this.#pending.set(key, bucket)
        }
      }
      throw error
    }
  }

  /** Flushes every few seconds until stopped; stopping flushes what is left. */
  start(db: Database, log?: Log): { stop: () => Promise<void> } {
    let timer: NodeJS.Timeout | null = null
    let running: Promise<void> = Promise.resolve()
    let stopped = false
    let failing = false
    const flush = () =>
      this.flush(db).then(
        () => {
          if (failing) log?.info('saving metrics works again')
          failing = false
        },
        (error: unknown) => {
          // Once per outage: a database that is down says so elsewhere.
          if (!failing) log?.warn({ err: error }, 'could not save metrics; keeping them for now')
          failing = true
        },
      )
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(() => {
        running = flush().finally(schedule)
      }, FLUSH_EVERY_MS)
      timer.unref()
    }
    schedule()
    return {
      stop: async () => {
        stopped = true
        if (timer) clearTimeout(timer)
        await running
        await flush()
      },
    }
  }

  #add(name: string, value: number, now: number): void {
    const at = now - (now % MINUTE_MS)
    const key = `${name}\n${String(at)}`
    const bucket = this.#pending.get(key)
    if (bucket) {
      bucket.sum += value
      bucket.count += 1
      bucket.max = Math.max(bucket.max, value)
    } else {
      this.#pending.set(key, { name, at, sum: value, count: 1, max: value })
    }
  }
}

function addRow(
  rows: Map<string, Bucket & { step: number }>,
  bucket: Bucket,
  step: number,
  at: number,
): void {
  const key = `${bucket.name}\n${String(step)}\n${String(at)}`
  const row = rows.get(key)
  if (row) {
    row.sum += bucket.sum
    row.count += bucket.count
    row.max = Math.max(row.max, bucket.max)
  } else {
    rows.set(key, { ...bucket, step, at })
  }
}

/**
 * This process's memory, CPU and event loop delay, as `api.rss` and so on,
 * sampled at each flush. Returns how to stop watching the event loop.
 */
export function recordProcess(metrics: Metrics, service: 'api' | 'bot'): () => void {
  const resolutionMs = 20
  const delay = monitorEventLoopDelay({ resolution: resolutionMs })
  delay.enable()
  let cpu = process.cpuUsage()
  let cpuAt = performance.now()
  metrics.gauge(`${service}.rss`, () => process.memoryUsage.rss())
  metrics.gauge(`${service}.heap`, () => process.memoryUsage().heapUsed)
  metrics.gauge(`${service}.cpu`, () => {
    const used = process.cpuUsage(cpu)
    const now = performance.now()
    const ratio = (used.user + used.system) / 1000 / Math.max(1, now - cpuAt)
    cpu = process.cpuUsage()
    cpuAt = now
    return ratio
  })
  metrics.gauge(`${service}.loop_ms`, () => {
    if (delay.count === 0) return null
    // Each sample includes the timer's own interval.
    const p99 = Math.max(0, delay.percentile(99) / 1e6 - resolutionMs)
    delay.reset()
    return p99
  })
  return () => {
    delay.disable()
  }
}

/** Drops what is older than each step keeps (DESIGN.md §16); the leading bot's janitor runs it. */
export async function pruneMetrics(db: Database, now = Date.now()): Promise<void> {
  const seconds = now / 1000
  await db.execute(sql`
    DELETE FROM metrics
    WHERE (step = ${METRIC_STEPS.minute}
        AND at < to_timestamp(${seconds - METRIC_RETENTION_SECONDS.minute}))
      OR (step = ${METRIC_STEPS.hour}
        AND at < to_timestamp(${seconds - METRIC_RETENTION_SECONDS.hour}))`)
}

interface Totals {
  sum: number
  count: number
  max: number
}

/**
 * Series over a range, one point per bucket of the range (DESIGN.md §16).
 * Series IDs must have been checked with `parseSeriesId`. The last point is
 * the bucket under way: its rates count only the time it has run.
 */
export async function readMetrics(
  db: Database,
  range: MetricRange,
  seriesIds: readonly string[],
  now = Date.now(),
): Promise<MetricSeries> {
  const { seconds, step, bucketSeconds } = METRIC_RANGES[range]
  const bucketMs = bucketSeconds * 1000
  const points = Math.round(seconds / bucketSeconds)
  const last = now - (now % bucketMs)
  const times = Array.from({ length: points }, (_, index) => last - (points - 1 - index) * bucketMs)
  const first = times[0] ?? last

  const wanted = seriesIds.flatMap((id) => {
    const parsed = parseSeriesId(id)
    return parsed ? [{ id, ...parsed }] : []
  })
  const names = new Set<string>()
  for (const { name, reading } of wanted) {
    names.add(name)
    if (isPercentile(reading)) {
      for (let index = 0; index <= TIMING_BOUNDS.length; index++) {
        names.add(timingBucketName(name, index))
      }
    }
  }
  const { rows } = await db.execute<{
    name: string
    t: number
    sum: number
    count: number
    max: number
  }>(sql`
    SELECT name,
      (extract(epoch FROM date_bin(${`${String(bucketSeconds)} seconds`}::interval, at,
        'epoch'::timestamptz)) * 1000)::float8 AS t,
      sum(sum)::float8 AS sum, sum(count)::float8 AS count, max(max)::float8 AS max
    FROM metrics
    WHERE step = ${step} AND name = ANY(${textArray([...names])})
      AND at >= to_timestamp(${first / 1000})
    GROUP BY name, t`)
  const found = new Map<string, Map<number, Totals>>()
  for (const row of rows) {
    const byTime = found.get(row.name) ?? new Map<number, Totals>()
    byTime.set(row.t, { sum: row.sum, count: row.count, max: row.max })
    found.set(row.name, byTime)
  }

  return {
    range,
    bucketSeconds,
    times,
    series: wanted.map(({ id, name, reading }) => {
      const byTime = found.get(name)
      if (isPercentile(reading)) {
        const quantile = Number(reading.slice(1)) / 100
        const buckets = Array.from(
          { length: TIMING_BOUNDS.length + 1 },
          (_, index) => found.get(timingBucketName(name, index)) ?? new Map<number, Totals>(),
        )
        const at = (time: number | null) =>
          percentile(
            buckets.map((bucket) => countAt(bucket, time)),
            quantile,
            maxAt(byTime, time),
          )
        return { id, values: times.map((time) => at(time)), overall: at(null) }
      }
      const values = times.map((time) => {
        const totals = byTime?.get(time)
        // The bucket under way has only run since its start.
        const elapsed = Math.min(bucketSeconds, Math.max(1, (now - time) / 1000))
        return reduce(reading, totals, elapsed)
      })
      return { id, values, overall: overall(reading, byTime) }
    }),
  }
}

function isPercentile(reading: MetricReading): reading is 'p50' | 'p95' | 'p99' {
  return reading === 'p50' || reading === 'p95' || reading === 'p99'
}

function reduce(reading: MetricReading, totals: Totals | undefined, seconds: number) {
  switch (reading) {
    case 'rate':
      return (totals?.sum ?? 0) / seconds
    case 'events':
      return (totals?.count ?? 0) / seconds
    case 'avg':
      return totals && totals.count > 0 ? totals.sum / totals.count : null
    default:
      return totals && totals.count > 0 ? totals.max : null
  }
}

/** The whole range: the total amount or events, the average, or the peak. */
function overall(reading: MetricReading, byTime: Map<number, Totals> | undefined) {
  let sum = 0
  let count = 0
  let max: number | null = null
  for (const totals of byTime?.values() ?? []) {
    sum += totals.sum
    count += totals.count
    if (totals.count > 0) max = Math.max(max ?? totals.max, totals.max)
  }
  switch (reading) {
    case 'rate':
      return sum
    case 'events':
      return count
    case 'avg':
      return count > 0 ? sum / count : null
    default:
      return max
  }
}

function countAt(bucket: Map<number, Totals>, time: number | null): number {
  if (time !== null) return bucket.get(time)?.sum ?? 0
  let total = 0
  for (const totals of bucket.values()) total += totals.sum
  return total
}

function maxAt(byTime: Map<number, Totals> | undefined, time: number | null): number | null {
  if (!byTime) return null
  if (time !== null) return byTime.get(time)?.max ?? null
  let max: number | null = null
  for (const totals of byTime.values()) max = Math.max(max ?? totals.max, totals.max)
  return max
}

/**
 * A percentile from counts per bucket, interpolated inside the bucket it
 * falls in; the last bucket ends at the largest value seen.
 */
export function percentile(counts: number[], quantile: number, max: number | null): number | null {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total === 0) return null
  const rank = quantile * total
  let below = 0
  for (const [index, count] of counts.entries()) {
    if (count > 0 && below + count >= rank) {
      const lower = index === 0 ? 0 : (TIMING_BOUNDS[index - 1] ?? 0)
      const upper = TIMING_BOUNDS[index] ?? Math.max(lower, max ?? lower)
      const value = lower + (upper - lower) * ((rank - below) / count)
      return max === null ? value : Math.min(value, max)
    }
    below += count
  }
  return max
}
