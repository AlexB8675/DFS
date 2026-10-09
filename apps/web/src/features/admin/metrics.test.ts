import { MAX_SERIES, parseSeriesId, type MetricSeries } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { DATABASE_CHARTS, MONITORING_SECTIONS, OVERVIEW_CHARTS } from './dashboards'
import { resolveLines, seriesOf, type ChartSpec } from './metrics'

const data: MetricSeries = {
  range: '1h',
  bucketSeconds: 60,
  times: [0, 60_000, 120_000],
  until: 180_000,
  series: [
    { id: 'cache.hits:rate', values: [3, 0, 1], overall: 240 },
    { id: 'cache.misses:rate', values: [1, 0, 1], overall: 120 },
    { id: 'storage.bytes:avg', values: [100, 2048, null], overall: 1074 },
    { id: 'uploads.bytes:rate', values: [1024, 0, 0], overall: 61_440 },
  ],
}

describe('graph lines (§16)', () => {
  it('asks for each series once', () => {
    const chart: ChartSpec = {
      title: 'Hit rate',
      description: '',
      format: 'percent',
      lines: [
        {
          label: 'Hits',
          color: 1,
          share: 'cache.hits:rate',
          of: ['cache.hits:rate', 'cache.misses:rate'],
        },
        { label: 'Misses', color: 2, series: 'cache.misses:rate' },
      ],
    }
    expect(seriesOf(chart, chart)).toEqual(['cache.hits:rate', 'cache.misses:rate'])
  })

  it('works out shares, and sums each line up for its legend', () => {
    const [hitRate, stored, received] = resolveLines(
      {
        title: '',
        description: '',
        format: 'bytes',
        lines: [
          {
            label: 'Hit rate',
            color: 1,
            share: 'cache.hits:rate',
            of: ['cache.hits:rate', 'cache.misses:rate'],
          },
          { label: 'Stored', color: 2, series: 'storage.bytes:avg' },
          { label: 'Received', color: 3, series: 'uploads.bytes:rate' },
        ],
      },
      data,
    )
    // No reads at all is no rate, not 0%.
    expect(hitRate?.values).toEqual([0.75, null, 0.5])
    expect(hitRate?.summary).toBe('67%')
    // A level shows its latest value; a rate the total it adds up to.
    expect(stored?.summary).toBe('2.0 KB')
    expect(received?.summary).toBe('60.0 KB')
  })

  it('draws a line of gaps for a series that didn’t come', () => {
    const [missing] = resolveLines(
      {
        title: '',
        description: '',
        format: 'count',
        lines: [{ label: 'Users', color: 1, series: 'users.count:avg' }],
      },
      data,
    )
    expect(missing?.values).toEqual([null, null, null])
    expect(missing?.summary).toBe('—')
  })
})

describe('the admin’s graphs (§16)', () => {
  // Each page, and each section of Monitoring, asks for its series in one request.
  const requests = [
    OVERVIEW_CHARTS,
    DATABASE_CHARTS,
    ...MONITORING_SECTIONS.map((section) => section.charts),
  ].map((charts) => seriesOf(...charts))

  it('ask only for series the API reads', () => {
    for (const id of requests.flat()) expect(parseSeriesId(id), id).not.toBeNull()
  })

  it('ask for no more series at once than the API takes', () => {
    for (const ids of requests) expect(ids.length).toBeLessThanOrEqual(MAX_SERIES)
  })
})
