import { z } from 'zod'

// The figures behind the admin's graphs (DESIGN.md §16). Each process adds
// what it records to the `metrics` table, in buckets of a minute and of an
// hour (`@dfs/db`'s `Metrics`); `GET /admin/metrics` reads them back as series.

/**
 * - `counter`: events, each with an amount (bytes, or 1): read as a rate of
 *   the amounts (`rate`) or of the events (`events`).
 * - `gauge`: a level, sampled now and then: read as its average or peak.
 * - `timing`: durations in milliseconds, also counted in fixed buckets, so
 *   percentiles can be read over any range and across processes.
 */
export type MetricKind = 'counter' | 'gauge' | 'timing'
export type MetricUnit = 'bytes' | 'count' | 'ms' | 'ratio'

interface MetricInfo {
  kind: MetricKind
  unit: MetricUnit
  label: string
}

function metric(kind: MetricKind, unit: MetricUnit, label: string): MetricInfo {
  return { kind, unit, label }
}

/** Every metric DFS records. Names a process doesn't record simply have no data. */
export const METRICS = {
  // The API, per instance.
  'http.requests': metric('counter', 'count', 'Requests'),
  'http.client_errors': metric('counter', 'count', 'Refused requests (4xx)'),
  'http.server_errors': metric('counter', 'count', 'Failed requests (5xx)'),
  /** Requests that answer at once; downloads, uploaded parts and event streams aren't timed. */
  'http.ms': metric('timing', 'ms', 'Response time'),
  'downloads.bytes': metric('counter', 'bytes', 'Sent to browsers'),
  'uploads.bytes': metric('counter', 'bytes', 'Received from browsers'),
  'cache.hits': metric('counter', 'count', 'Frame cache hits'),
  'cache.misses': metric('counter', 'count', 'Frame cache misses'),
  'cache.bytes': metric('gauge', 'bytes', 'Frame cache size'),
  /** One event per CDN request, with the bytes it brought. */
  'cdn.reads': metric('counter', 'bytes', 'Read from the CDN'),
  'cdn.failures': metric('counter', 'count', 'Failed CDN reads'),
  'events.streams': metric('gauge', 'count', 'Open event streams'),
  'auth.sign_ins': metric('counter', 'count', 'Sign-ins'),
  'auth.failed_sign_ins': metric('counter', 'count', 'Failed sign-ins'),
  'api.rss': metric('gauge', 'bytes', 'API memory'),
  'api.heap': metric('gauge', 'bytes', 'API heap'),
  'api.cpu': metric('gauge', 'ratio', 'API CPU (of one core)'),
  'api.loop_ms': metric('gauge', 'ms', 'API event loop delay (p99)'),

  // The bot, per instance.
  'discord.requests': metric('counter', 'count', 'Discord requests'),
  /** Answers of 429: Discord refused a request for its rate limits. */
  'discord.429': metric('counter', 'count', 'Rate limited (429)'),
  /** Waits the client chose to stay inside a rate limit, with the milliseconds waited. */
  'discord.waits': metric('counter', 'ms', 'Waits for rate limits'),
  'discord.server_errors': metric('counter', 'count', 'Discord errors (5xx)'),
  /** One event per stored blob, with its size. */
  'discord.posted': metric('counter', 'bytes', 'Posted to Discord'),
  'discord.post_failures': metric('counter', 'count', 'Failed posts'),
  'discord.deleted': metric('counter', 'count', 'Deleted messages'),
  'discord.signed': metric('counter', 'count', 'Signed CDN URLs'),
  'packs.sealed': metric('counter', 'count', 'Packs sealed'),
  'orphans.deleted': metric('counter', 'count', 'Orphan messages deleted'),
  'bot.rss': metric('gauge', 'bytes', 'Bot memory'),
  'bot.heap': metric('gauge', 'bytes', 'Bot heap'),
  'bot.cpu': metric('gauge', 'ratio', 'Bot CPU (of one core)'),
  'bot.loop_ms': metric('gauge', 'ms', 'Bot event loop delay (p99)'),

  // The whole system, sampled by the leading bot once a minute.
  'sync.files': metric('gauge', 'count', 'Files waiting to sync'),
  'sync.bytes': metric('gauge', 'bytes', 'Bytes waiting to sync'),
  'staging.bytes': metric('gauge', 'bytes', 'Staging used'),
  'storage.bytes': metric('gauge', 'bytes', 'Stored on Discord'),
  'storage.live_bytes': metric('gauge', 'bytes', 'Live bytes on Discord'),
  'storage.blobs': metric('gauge', 'count', 'Stored blobs'),
  'storage.packs': metric('gauge', 'count', 'Stored packs'),
  'blobs.waiting': metric('gauge', 'count', 'Blobs waiting to be stored'),
  'blobs.deleting': metric('gauge', 'count', 'Blobs waiting to be deleted'),
  'blobs.lost': metric('gauge', 'count', 'Lost blobs'),
  'queue.pending': metric('gauge', 'count', 'Pending jobs'),
  'queue.failed': metric('gauge', 'count', 'Failed jobs'),
  'db.bytes': metric('gauge', 'bytes', 'Database size'),
  'users.count': metric('gauge', 'count', 'Users'),
  'files.count': metric('gauge', 'count', 'Files'),
  'files.bytes': metric('gauge', 'bytes', 'Used by files'),
  'sessions.count': metric('gauge', 'count', 'Signed-in sessions'),

  // PostgreSQL's own statistics, sampled by the leading bot once a minute.
  'pg.connections': metric('gauge', 'count', 'Database connections'),
  'pg.active': metric('gauge', 'count', 'Queries running'),
  'pg.lock_waits': metric('gauge', 'count', 'Queries waiting for locks'),
  'pg.oldest_xact_ms': metric('gauge', 'ms', 'Longest transaction'),
  'pg.dead_rows': metric('gauge', 'count', 'Dead rows'),
  'pg.commits': metric('counter', 'count', 'Commits'),
  'pg.rollbacks': metric('counter', 'count', 'Rollbacks'),
  'pg.deadlocks': metric('counter', 'count', 'Deadlocks'),
  /** Blocks found in shared buffers, and those read from the disk (or the OS cache). */
  'pg.cache_hits': metric('counter', 'count', 'Blocks found in memory'),
  'pg.disk_reads': metric('counter', 'count', 'Blocks read from disk'),
  'pg.rows_read': metric('counter', 'count', 'Rows read'),
  'pg.rows_written': metric('counter', 'count', 'Rows written'),
  'pg.temp_bytes': metric('counter', 'bytes', 'Temporary files'),
  'pg.wal_bytes': metric('counter', 'bytes', 'WAL written'),
} as const satisfies Record<string, MetricInfo>

export type MetricName = keyof typeof METRICS

export function isMetricName(name: string): name is MetricName {
  return Object.hasOwn(METRICS, name)
}

/**
 * Upper bounds of the buckets timings are counted in, in milliseconds; the
 * last one takes the rest. Stored as `<name>.le<bound>` (`.leInf` for the last).
 */
export const TIMING_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const

export function timingBucketName(name: MetricName, index: number): string {
  const bound = TIMING_BOUNDS[index]
  return `${name}.le${bound === undefined ? 'Inf' : String(bound)}`
}

/** The buckets metrics are stored in: a minute, and an hour (DESIGN.md §16). */
export const METRIC_STEPS = { minute: 60, hour: 3600 } as const

/** How long each step is kept. */
export const METRIC_RETENTION_SECONDS = { minute: 2 * 86_400, hour: 400 * 86_400 } as const

export const metricRangeSchema = z.enum(['1h', '6h', '24h', '7d', '30d', '1y'])
export type MetricRange = z.infer<typeof metricRangeSchema>

/**
 * What each range covers, which step it reads, and the bucket each point of
 * the graph sums: a few hundred points at most.
 */
export const METRIC_RANGES: Record<
  MetricRange,
  { seconds: number; step: number; bucketSeconds: number }
> = {
  '1h': { seconds: 3600, step: METRIC_STEPS.minute, bucketSeconds: 60 },
  '6h': { seconds: 6 * 3600, step: METRIC_STEPS.minute, bucketSeconds: 120 },
  '24h': { seconds: 86_400, step: METRIC_STEPS.minute, bucketSeconds: 300 },
  '7d': { seconds: 7 * 86_400, step: METRIC_STEPS.hour, bucketSeconds: 3600 },
  '30d': { seconds: 30 * 86_400, step: METRIC_STEPS.hour, bucketSeconds: 4 * 3600 },
  '1y': { seconds: 365 * 86_400, step: METRIC_STEPS.hour, bucketSeconds: 86_400 },
}

/**
 * How a series reads its metric:
 * - `rate`: amount per second (bytes/s, or events/s for amounts of 1);
 * - `events`: events per second, whatever their amounts;
 * - `avg`, `max`: of a gauge's samples, or of the amounts and timings recorded;
 * - `p50`, `p95`, `p99`: percentiles of a timing.
 */
export const metricReadingSchema = z.enum(['rate', 'events', 'avg', 'max', 'p50', 'p95', 'p99'])
export type MetricReading = z.infer<typeof metricReadingSchema>

const READINGS: Record<MetricKind, readonly MetricReading[]> = {
  counter: ['rate', 'events', 'max'],
  gauge: ['avg', 'max'],
  timing: ['events', 'avg', 'max', 'p50', 'p95', 'p99'],
}

/** A series to read, as `<metric>:<reading>`, for example `http.ms:p95`. */
export type MetricSeriesId = `${MetricName}:${MetricReading}`

/** Parses a series ID, or returns `null` if the metric doesn't offer that reading. */
export function parseSeriesId(
  seriesId: string,
): { name: MetricName; reading: MetricReading } | null {
  const [name = '', reading = '', ...rest] = seriesId.split(':')
  const parsed = metricReadingSchema.safeParse(reading)
  if (rest.length > 0 || !isMetricName(name) || !parsed.success) return null
  return READINGS[METRICS[name].kind].includes(parsed.data) ? { name, reading: parsed.data } : null
}

/** Series per request: enough for a page of graphs, few enough to stay quick. */
export const MAX_SERIES = 24

/** `GET /admin/metrics?range&series=a:rate,b:p95`. */
export const metricsQuerySchema = z.object({
  range: metricRangeSchema.default('1h'),
  series: z
    .string()
    .transform((value) => [...new Set(value.split(',').filter(Boolean))])
    .pipe(
      z
        .array(z.string().refine((id) => parseSeriesId(id) !== null, 'Unknown metric or reading.'))
        .min(1)
        .max(MAX_SERIES),
    ),
})
export type MetricsQuery = z.infer<typeof metricsQuerySchema>

export const metricSeriesSchema = z.object({
  range: metricRangeSchema,
  bucketSeconds: z.number().int().positive(),
  /** Each point's start, in milliseconds since 1970, oldest first; the last one is under way. */
  times: z.array(z.number()),
  series: z.array(
    z.object({
      id: z.string(),
      /** One per time; `null` where a gauge or timing had no samples. */
      values: z.array(z.number().nullable()),
      /**
       * The whole range in one figure: the total amount (`rate`) or events
       * (`events`), the average, the peak, or the percentile.
       */
      overall: z.number().nullable(),
    }),
  ),
})
export type MetricSeries = z.infer<typeof metricSeriesSchema>
