import {
  metricSeriesSchema,
  parseSeriesId,
  type MetricRange,
  type MetricSeries,
  type MetricSeriesId,
} from '@dfs/shared'
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiGet } from '@/lib/api/client'
import type { ChartColor } from './charts/colors'
import type { ChartLine } from './charts/time-series-chart'
import { formatValue, totalFormat, type ValueFormat } from './charts/scales'

// The admin's graphs (§16): what each one shows, read from `GET /admin/metrics`.

export const RANGES: { value: MetricRange; label: string }[] = [
  { value: '1h', label: '1 h' },
  { value: '6h', label: '6 h' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
  { value: '1y', label: '1 y' },
]

/** Short ranges move while you watch; long ones change slowly. */
const REFRESH_MS: Record<MetricRange, number> = {
  '1h': 15_000,
  '6h': 30_000,
  '24h': 60_000,
  '7d': 5 * 60_000,
  '30d': 5 * 60_000,
  '1y': 15 * 60_000,
}

export function metricsQuery(range: MetricRange, series: readonly MetricSeriesId[]) {
  return queryOptions({
    queryKey: ['admin', 'metrics', range, series],
    queryFn: ({ signal }) =>
      apiGet('/admin/metrics', metricSeriesSchema, {
        query: { range, series: series.join(',') },
        signal,
      }),
    refetchInterval: REFRESH_MS[range],
    staleTime: REFRESH_MS[range] / 2,
    // A new range keeps the graphs on screen, faded, until it arrives.
    placeholderData: keepPreviousData,
  })
}

/** A line of a graph: one series, or the share one series is of others (a hit rate). */
export type LineSpec = { label: string; color: ChartColor } & (
  { series: MetricSeriesId } | { share: MetricSeriesId; of: MetricSeriesId[] }
)

export interface ChartSpec {
  title: string
  /** What the graph shows, in a few words. */
  description: string
  format: ValueFormat
  lines: LineSpec[]
}

/** Every series some of these graphs need, once each. */
export function seriesOf(...charts: ChartSpec[]): MetricSeriesId[] {
  const ids = new Set<MetricSeriesId>()
  for (const chart of charts) {
    for (const line of chart.lines) {
      if ('series' in line) ids.add(line.series)
      else for (const id of [line.share, ...line.of]) ids.add(id)
    }
  }
  return [...ids]
}

export interface ResolvedLine extends ChartLine {
  /**
   * The line in one figure, for its legend: a total for rates, the latest
   * value for levels, the peak or percentile over the range otherwise.
   */
  summary: string
}

/** A graph's lines from the series it was given. */
export function resolveLines(chart: ChartSpec, data: MetricSeries): ResolvedLine[] {
  const byId = new Map(data.series.map((series) => [series.id, series]))
  return chart.lines.map((line, index) => {
    const base = { key: String(index), label: line.label, color: line.color }
    if ('share' in line) {
      const part = byId.get(line.share)
      const wholes = line.of.map((id) => byId.get(id))
      const values = data.times.map((_, at) => {
        const whole = wholes.reduce((sum, series) => sum + (series?.values[at] ?? 0), 0)
        return whole > 0 ? (part?.values[at] ?? 0) / whole : null
      })
      const whole = wholes.reduce((sum, series) => sum + (series?.overall ?? 0), 0)
      const overall = whole > 0 ? (part?.overall ?? 0) / whole : null
      return { ...base, values, summary: overall === null ? '—' : formatValue(overall, 'percent') }
    }
    const series = byId.get(line.series)
    const values = series?.values ?? data.times.map(() => null)
    return { ...base, values, summary: summarize(line.series, series, values, chart.format) }
  })
}

function summarize(
  id: MetricSeriesId,
  series: MetricSeries['series'][number] | undefined,
  values: readonly (number | null)[],
  format: ValueFormat,
): string {
  const reading = parseSeriesId(id)?.reading
  if (reading === 'avg') {
    const latest = values.findLast((value) => value !== null)
    return latest === undefined ? '—' : formatValue(latest, format)
  }
  const overall = series?.overall
  if (overall === null || overall === undefined) return '—'
  if (reading === 'rate' || reading === 'events') return formatValue(overall, totalFormat(format))
  return formatValue(overall, format)
}
