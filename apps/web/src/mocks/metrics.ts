import {
  METRIC_RANGES,
  metricsUntil,
  METRICS,
  parseSeriesId,
  type MetricName,
  type MetricReading,
  type MetricSeries,
  type MetricsQuery,
} from '@dfs/shared'

// Made-up metrics for the mock API (§16): smooth daily waves with a little
// noise, the same on every refetch, so the admin's graphs look like a server
// at work. Gauges end at the levels the mock's data has now.

const MB = 1024 ** 2
const GB = 1024 ** 3
const DAY_MS = 86_400_000

/** A typical level per metric: per second for counters, as is for gauges. */
const LEVELS: Partial<Record<MetricName, number>> = {
  'http.requests': 14,
  'http.client_errors': 0.4,
  'http.server_errors': 0.01,
  'downloads.bytes': 6 * MB,
  'uploads.bytes': 3 * MB,
  'cache.hits': 22,
  'cache.misses': 3,
  'cache.bytes': 3.4 * GB,
  'cdn.reads': 2 * MB,
  'cdn.failures': 0.005,
  'cdn.429': 0.001,
  'cdn.waits': 0.001,
  'cdn.in_flight': 3,
  'downloads.active': 4,
  'events.streams': 6,
  'auth.sign_ins': 0.004,
  'auth.failed_sign_ins': 0.001,
  'check.discord.failures': 0.002,
  'check.internet.failures': 0.001,
  'api.rss': 210 * MB,
  'api.heap': 96 * MB,
  'api.cpu': 0.12,
  'api.loop_ms': 1.6,
  'discord.requests': 4,
  'discord.429': 0.02,
  'discord.waits': 300,
  'discord.server_errors': 0.002,
  'discord.posted': 3 * MB,
  'discord.post_failures': 0.004,
  'discord.deleted': 0.05,
  'discord.signed': 1.5,
  'packs.sealed': 0.03,
  'packs.compacted': 0.002,
  'compaction.freed_bytes': 4 * 1024,
  'orphans.deleted': 0.0005,
  'bot.rss': 160 * MB,
  'bot.heap': 70 * MB,
  'bot.cpu': 0.08,
  'bot.loop_ms': 0.9,
  'blobs.waiting': 4,
  'blobs.deleting': 1,
  'queue.pending': 4,
  'db.bytes': 2.3 * GB,
  'sessions.count': 9,
}

/** A typical median per timing, in milliseconds: the API's answers, and its checks. */
const MEDIANS: Partial<Record<MetricName, number>> = {
  'http.ms': 9,
  'check.discord.ms': 95,
  'check.internet.ms': 14,
  'cdn.first_byte_ms': 120,
}

/** Average amount per event, for reading counters as `events`. */
const AMOUNTS: Partial<Record<MetricName, number>> = {
  'downloads.bytes': 512 * 1024,
  'uploads.bytes': 4 * MB,
  'cdn.reads': 4 * MB,
  'discord.posted': 9 * MB,
  'discord.waits': 250,
  'cdn.waits': 2000,
}

/** Gauges that grow over time, ending at today's level. */
const GROWING = new Set<MetricName>([
  'storage.bytes',
  'storage.live_bytes',
  'storage.blobs',
  'storage.packs',
  'files.count',
  'files.bytes',
  'users.count',
  'db.bytes',
])

export function mockMetrics(
  query: MetricsQuery,
  current: Partial<Record<MetricName, number>>,
  now = Date.now(),
): MetricSeries {
  const { seconds, bucketSeconds } = METRIC_RANGES[query.range]
  const bucketMs = bucketSeconds * 1000
  const points = Math.round(seconds / bucketSeconds)
  // As the API reads them: the last bucket may be under way.
  const until = metricsUntil(query.range, now)
  const last = until - 1 - ((until - 1) % bucketMs)
  const times = Array.from({ length: points }, (_, index) => last - (points - 1 - index) * bucketMs)

  return {
    range: query.range,
    bucketSeconds,
    times,
    until,
    series: query.series.flatMap((id) => {
      const parsed = parseSeriesId(id)
      if (!parsed) return []
      const values = times.map((time) => value(parsed.name, parsed.reading, time, now, current))
      return [{ id, values, overall: overall(parsed.name, parsed.reading, values, bucketSeconds) }]
    }),
  }
}

function value(
  name: MetricName,
  reading: MetricReading,
  time: number,
  now: number,
  current: Partial<Record<MetricName, number>>,
): number | null {
  const info = METRICS[name]
  const seed = hash(name) + time / 60_000
  // Busier in the evening, quieter at night.
  const daily = 1 + 0.45 * Math.sin(((time % DAY_MS) / DAY_MS) * 2 * Math.PI - 1.9)
  const wobble = 0.75 + 0.5 * noise(seed)

  if (info.kind === 'timing') {
    const median = (MEDIANS[name] ?? 9) * wobble
    switch (reading) {
      case 'p50':
        return median
      case 'p95':
        return median * (3.5 + noise(seed + 1))
      case 'p99':
        return median * (9 + 4 * noise(seed + 2))
      case 'avg':
        return median * 1.6
      case 'max':
        return median * (20 + 30 * noise(seed + 3))
      default:
        return 14 * daily * wobble
    }
  }

  if (info.kind === 'gauge') {
    const level = current[name] ?? LEVELS[name] ?? 0
    if (GROWING.has(name)) {
      // About 40% less a year ago, a little bumpy.
      const age = (now - time) / (365 * DAY_MS)
      return Math.max(0, level * (1 - 0.4 * age) * (1 - 0.01 * noise(seed)))
    }
    if (info.unit === 'count' && level < 50) {
      return Math.max(0, Math.round(level * daily * wobble))
    }
    const sampled = level * (info.unit === 'ratio' ? daily * wobble : 0.9 + 0.2 * noise(seed))
    return reading === 'max' ? sampled * 1.3 : sampled
  }

  // Rare events come in bursts rather than as a trickle.
  const level = LEVELS[name] ?? 0
  const rare = level < 0.05
  const rate = rare ? (noise(seed + 7) > 0.93 ? level * 14 : 0) : level * daily * wobble
  switch (reading) {
    case 'rate':
      return rate
    case 'events':
      return rate / (AMOUNTS[name] ?? 1)
    default:
      return rate > 0 ? (AMOUNTS[name] ?? 1) * (1.5 + noise(seed + 4)) : null
  }
}

function overall(
  name: MetricName,
  reading: MetricReading,
  values: (number | null)[],
  bucketSeconds: number,
): number | null {
  const present = values.filter((entry): entry is number => entry !== null)
  if (present.length === 0) return null
  if (reading === 'rate' || reading === 'events') {
    return present.reduce((total, entry) => total + entry * bucketSeconds, 0)
  }
  if (reading === 'max') return Math.max(...present)
  const average = present.reduce((total, entry) => total + entry, 0) / present.length
  return METRICS[name].kind === 'timing' && reading !== 'avg' ? Math.max(...present) * 0.8 : average
}

function hash(text: string): number {
  let result = 0
  for (const char of text) result = (result * 31 + char.charCodeAt(0)) % 100_000
  return result
}

/** A number in [0, 1) that is always the same for the same seed. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43_758.5453
  return x - Math.floor(x)
}
