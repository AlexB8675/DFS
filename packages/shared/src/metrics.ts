import { z } from 'zod'

// The figures behind the admin's graphs (DESIGN.md §16). Each process adds
// what it records to the `metrics` table, in buckets of a minute and of an
// hour (`@dfs/db`'s `Metrics`); `GET /admin/metrics` reads them back as series.

/**
 * - `counter`: events, each with an amount (bytes, or 1): read as a rate of
 *   the amounts (`rate`) or of the events (`events`).
 * - `gauge`: a level, sampled now and then: read as its average or peak.
 * - `timing`: durations in milliseconds, also counted in fixed buckets, so
 *   percentiles can be read over any range and across processes. A bucket
 *   with nothing timed has no data: what must always have a figure is timed
 *   on a schedule, as the API's checks are.
 */
export type MetricKind = 'counter' | 'gauge' | 'timing'
export type MetricUnit = 'bytes' | 'count' | 'ms' | 'ratio'

/** Which process records a metric: an API, a bot, or the leading bot's samples of the system. */
export type MetricSource = 'api' | 'bot' | 'leader'

interface MetricInfo {
  kind: MetricKind
  unit: MetricUnit
  label: string
  source: MetricSource
}

function byApi(kind: MetricKind, unit: MetricUnit, label: string): MetricInfo {
  return { kind, unit, label, source: 'api' }
}

function byBot(kind: MetricKind, unit: MetricUnit, label: string): MetricInfo {
  return { kind, unit, label, source: 'bot' }
}

function byLeader(kind: MetricKind, unit: MetricUnit, label: string): MetricInfo {
  return { kind, unit, label, source: 'leader' }
}

/** Every metric DFS records. Names a process doesn't record simply have no data. */
export const METRICS = {
  // The API, per instance.
  'http.requests': byApi('counter', 'count', 'Requests'),
  'http.client_errors': byApi('counter', 'count', 'Refused requests (4xx)'),
  'http.server_errors': byApi('counter', 'count', 'Failed requests (5xx)'),
  /**
   * Requests that answer at once, health checks included: the API checks
   * itself every 10 s, so there is always one. Downloads, uploaded parts and
   * event streams aren't timed.
   */
  'http.ms': byApi('timing', 'ms', 'Response time'),
  /** The API's checks every 10 s (`apps/api/src/checks.ts`): a request on a new connection. */
  'check.discord.ms': byApi('timing', 'ms', 'Discord’s answer time'),
  'check.internet.ms': byApi('timing', 'ms', 'The internet’s answer time'),
  /** Checks with no answer in 5 s, or a server error. */
  'check.discord.failures': byApi('counter', 'count', 'Failed checks of Discord'),
  'check.internet.failures': byApi('counter', 'count', 'Failed checks of the internet'),
  'downloads.bytes': byApi('counter', 'bytes', 'Sent to browsers'),
  /** Files and ZIPs being sent to browsers: the most at once since the last sample. */
  'downloads.active': byApi('gauge', 'count', 'Downloads under way (peak)'),
  'uploads.bytes': byApi('counter', 'bytes', 'Received from browsers'),
  'cache.hits': byApi('counter', 'count', 'Frame cache hits'),
  'cache.misses': byApi('counter', 'count', 'Frame cache misses'),
  'cache.bytes': byApi('gauge', 'bytes', 'Frame cache size'),
  /** One event per CDN request, with the bytes it brought. */
  'cdn.reads': byApi('counter', 'bytes', 'Read from the CDN'),
  'cdn.failures': byApi('counter', 'count', 'Failed CDN reads'),
  /** The CDN answered 429: every read of the API waited as it asked (§6.2). */
  'cdn.429': byApi('counter', 'count', 'CDN asked to slow down (429)'),
  /** Reads that waited for the CDN to allow requests again, with the milliseconds waited. */
  'cdn.waits': byApi('counter', 'ms', 'Waits for the CDN'),
  /** Reads from the CDN under way: the most at once since the last sample. */
  'cdn.in_flight': byApi('gauge', 'count', 'CDN reads under way (peak)'),
  /** From sending a request to the CDN to its answer's headers: Discord's own time. */
  'cdn.first_byte_ms': byApi('timing', 'ms', 'CDN time to first byte'),
  /** From a video player starting to its first frame, as players report it (§10.4). */
  'player.first_frame_ms': byApi('timing', 'ms', 'Time to a video’s first frame'),
  /** Plays that waited for data after their first frame, with how long they waited. */
  'player.stall_ms': byApi('counter', 'ms', 'Videos stalled'),
  /** Plays that couldn't play: a codec, a damaged file, a failed read. */
  'player.failures': byApi('counter', 'count', 'Videos that couldn’t play'),
  'events.streams': byApi('gauge', 'count', 'Open event streams'),
  'auth.sign_ins': byApi('counter', 'count', 'Sign-ins'),
  'auth.failed_sign_ins': byApi('counter', 'count', 'Failed sign-ins'),
  'api.rss': byApi('gauge', 'bytes', 'API memory'),
  'api.heap': byApi('gauge', 'bytes', 'API heap'),
  'api.cpu': byApi('gauge', 'ratio', 'API CPU (of one core)'),
  'api.loop_ms': byApi('gauge', 'ms', 'API event loop delay (p99)'),

  // The bot, per instance.
  'discord.requests': byBot('counter', 'count', 'Discord requests'),
  /** Answers of 429: Discord refused a request for its rate limits. */
  'discord.429': byBot('counter', 'count', 'Rate limited (429)'),
  /** Waits the client chose to stay inside a rate limit, with the milliseconds waited. */
  'discord.waits': byBot('counter', 'ms', 'Waits for rate limits'),
  'discord.server_errors': byBot('counter', 'count', 'Discord errors (5xx)'),
  /** One event per stored blob, with its size. */
  'discord.posted': byBot('counter', 'bytes', 'Posted to Discord'),
  'discord.post_failures': byBot('counter', 'count', 'Failed posts'),
  'discord.deleted': byBot('counter', 'count', 'Deleted messages'),
  'discord.signed': byBot('counter', 'count', 'Signed CDN URLs'),
  'packs.sealed': byBot('counter', 'count', 'Packs sealed'),
  'packs.compacted': byBot('counter', 'count', 'Packs merged by compaction'),
  'compaction.freed_bytes': byBot('counter', 'bytes', 'Freed on Discord by compaction'),
  'compaction.failures': byBot('counter', 'count', 'Packs compaction found damaged'),
  'orphans.deleted': byBot('counter', 'count', 'Orphan messages deleted'),
  'bot.rss': byBot('gauge', 'bytes', 'Bot memory'),
  'bot.heap': byBot('gauge', 'bytes', 'Bot heap'),
  'bot.cpu': byBot('gauge', 'ratio', 'Bot CPU (of one core)'),
  'bot.loop_ms': byBot('gauge', 'ms', 'Bot event loop delay (p99)'),

  // The whole system, sampled by the leading bot once a minute.
  'sync.files': byLeader('gauge', 'count', 'Files waiting to sync'),
  'sync.bytes': byLeader('gauge', 'bytes', 'Bytes waiting to sync'),
  'staging.bytes': byLeader('gauge', 'bytes', 'Staging used'),
  'storage.bytes': byLeader('gauge', 'bytes', 'Stored on Discord'),
  'storage.live_bytes': byLeader('gauge', 'bytes', 'Live bytes on Discord'),
  'storage.blobs': byLeader('gauge', 'count', 'Stored blobs'),
  'storage.packs': byLeader('gauge', 'count', 'Stored packs'),
  'blobs.waiting': byLeader('gauge', 'count', 'Blobs waiting to be stored'),
  'blobs.deleting': byLeader('gauge', 'count', 'Blobs waiting to be deleted'),
  'queue.pending': byLeader('gauge', 'count', 'Pending jobs'),
  'queue.failed': byLeader('gauge', 'count', 'Failed jobs'),
  'db.bytes': byLeader('gauge', 'bytes', 'Database size'),
  'users.count': byLeader('gauge', 'count', 'Users'),
  'files.count': byLeader('gauge', 'count', 'Files'),
  'files.bytes': byLeader('gauge', 'bytes', 'Used by files'),
  'sessions.count': byLeader('gauge', 'count', 'Signed-in sessions'),

  // PostgreSQL's own statistics, sampled by the leading bot once a minute.
  'pg.connections': byLeader('gauge', 'count', 'Database connections'),
  'pg.active': byLeader('gauge', 'count', 'Queries running'),
  'pg.lock_waits': byLeader('gauge', 'count', 'Queries waiting for locks'),
  'pg.oldest_xact_ms': byLeader('gauge', 'ms', 'Longest transaction'),
  'pg.dead_rows': byLeader('gauge', 'count', 'Dead rows'),
  'pg.commits': byLeader('counter', 'count', 'Commits'),
  'pg.rollbacks': byLeader('counter', 'count', 'Rollbacks'),
  'pg.deadlocks': byLeader('counter', 'count', 'Deadlocks'),
  /** Blocks found in shared buffers, and those read from the disk (or the OS cache). */
  'pg.cache_hits': byLeader('counter', 'count', 'Blocks found in memory'),
  'pg.disk_reads': byLeader('counter', 'count', 'Blocks read from disk'),
  'pg.rows_read': byLeader('counter', 'count', 'Rows read'),
  'pg.rows_written': byLeader('counter', 'count', 'Rows written'),
  'pg.temp_bytes': byLeader('counter', 'bytes', 'Temporary files'),
  'pg.wal_bytes': byLeader('counter', 'bytes', 'WAL written'),
} as const satisfies Record<string, MetricInfo>

export type MetricName = keyof typeof METRICS

export function isMetricName(name: string): name is MetricName {
  return Object.hasOwn(METRICS, name)
}

/**
 * A level each source records at every turn, whichever else it records: a
 * count is 0 in a bucket only if its process ran then, and no data if not.
 */
const HEARTBEATS: Record<MetricSource, MetricName> = {
  api: 'api.rss',
  bot: 'bot.rss',
  leader: 'pg.connections',
}

export function heartbeatOf(name: MetricName): MetricName {
  return HEARTBEATS[METRICS[name].source]
}

/**
 * Upper bounds of the buckets timings are counted in, in milliseconds; the
 * last one takes the rest. Stored as `<name>.le<bound>` (`.leInf` for the
 * last). Fine where most answers are, a few milliseconds, so percentiles are
 * read to within a millisecond or two there; each bound of the first, coarser
 * list is still one, so older figures keep their meaning.
 */
export const TIMING_BOUNDS = [
  1, 2.5, 5, 7.5, 10, 15, 25, 35, 50, 75, 100, 150, 250, 350, 500, 750, 1000, 2500, 5000, 10_000,
] as const

export function timingBucketName(name: MetricName, index: number): string {
  const bound = TIMING_BOUNDS[index]
  return `${name}.le${bound === undefined ? 'Inf' : String(bound)}`
}

/** The buckets metrics are stored in: half a minute, a minute, and an hour (DESIGN.md §16). */
export const METRIC_STEPS = { halfMinute: 30, minute: 60, hour: 3600 } as const

/** How long each step is kept: half minutes only for the last hour's graphs. */
export const METRIC_RETENTION_SECONDS = {
  halfMinute: 3 * 3600,
  minute: 2 * 86_400,
  hour: 400 * 86_400,
} as const

/** How often each process adds what it recorded to the table. */
export const METRIC_FLUSH_MS = 5_000

/**
 * A bucket is read once this long has passed since it ended: by then every
 * process has added its figures for it. One read sooner would read low.
 */
export const METRIC_SETTLE_MS = METRIC_FLUSH_MS + 3_000

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
  '1h': { seconds: 3600, step: METRIC_STEPS.halfMinute, bucketSeconds: 30 },
  '6h': { seconds: 6 * 3600, step: METRIC_STEPS.minute, bucketSeconds: 120 },
  '24h': { seconds: 86_400, step: METRIC_STEPS.minute, bucketSeconds: 300 },
  '7d': { seconds: 7 * 86_400, step: METRIC_STEPS.hour, bucketSeconds: 3600 },
  '30d': { seconds: 30 * 86_400, step: METRIC_STEPS.hour, bucketSeconds: 4 * 3600 },
  '1y': { seconds: 365 * 86_400, step: METRIC_STEPS.hour, bucketSeconds: 86_400 },
}

/**
 * Where a range's figures end at `now` (`until`): at the end of the last
 * bucket, of the finest step it reads, that every process has added its
 * figures for. Ranges read by the hour fill their last bucket from minutes.
 */
export function metricsUntil(range: MetricRange, now: number): number {
  const { step } = METRIC_RANGES[range]
  const finestMs = (step === METRIC_STEPS.hour ? METRIC_STEPS.minute : step) * 1000
  const settled = now - METRIC_SETTLE_MS
  return settled - (settled % finestMs)
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
  /** Each point's start, in milliseconds since 1970, oldest first. */
  times: z.array(z.number()),
  /**
   * Where the figures end (`metricsUntil`): every process has added its
   * figures up to here. The last point's bucket may run past it, still under way.
   */
  until: z.number(),
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
