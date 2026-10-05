import type { MetricSeries } from '@dfs/shared'
import { ChartLine as ChartIcon, Table2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { resolveLines, type ChartSpec } from '../metrics'
import { formatBucket, formatValue } from './scales'
import { chartColor } from './colors'
import { TimeSeriesChart } from './time-series-chart'

const HEIGHT = 168

/**
 * A graph in a card, with its legend (each line's figure for the range) and
 * a table of the same values for reading without pointing at the graph.
 */
export function MetricChart({
  chart,
  data,
  stale = false,
  failed = false,
}: {
  chart: ChartSpec
  data: MetricSeries | undefined
  /** Still showing the previous range while the new one loads. */
  stale?: boolean
  /** The figures couldn't be loaded, and there are none to show instead. */
  failed?: boolean
}) {
  const [asTable, setAsTable] = useState(false)
  const lines = data ? resolveLines(chart, data) : []
  const single = lines.length === 1 ? lines[0] : undefined

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          {chart.title}
          {single && (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {single.summary}
            </span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{chart.description}</p>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-pressed={asTable}
            aria-label={asTable ? 'Show as a graph' : 'Show as a table'}
            title={asTable ? 'Show as a graph' : 'Show as a table'}
            onClick={() => {
              setAsTable(!asTable)
            }}
          >
            {asTable ? <ChartIcon /> : <Table2 />}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent
        className={cn('grid gap-3 transition-opacity motion-glide', stale && 'opacity-50')}
      >
        {lines.length > 1 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
            {lines.map((line) => (
              <li key={line.key} className="flex items-center gap-1.5">
                <span
                  className="h-0.5 w-3 rounded-full"
                  style={{ background: chartColor(line.color) }}
                  aria-hidden
                />
                <span className="text-muted-foreground">{line.label}</span>
                <span className="font-medium tabular-nums">{line.summary}</span>
              </li>
            ))}
          </ul>
        )}
        {!data && failed ? (
          <p
            className="grid place-items-center text-xs text-muted-foreground"
            style={{ height: HEIGHT }}
          >
            The figures couldn’t be loaded.
          </p>
        ) : !data ? (
          <Skeleton className="w-full" style={{ height: HEIGHT }} />
        ) : asTable ? (
          <div className="overflow-y-auto rounded-md border" style={{ height: HEIGHT }}>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  {lines.map((line) => (
                    <th key={line.key} className="px-2 py-1.5 text-right font-medium">
                      {line.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.times
                  .map((time, index) => ({ time, index }))
                  .reverse()
                  .map(({ time, index }) => (
                    <tr key={time} className="border-t border-border/60">
                      <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                        {formatBucket(time, data.bucketSeconds)}
                      </td>
                      {lines.map((line) => {
                        const value = line.values[index]
                        return (
                          <td key={line.key} className="px-2 py-1 text-right tabular-nums">
                            {value === null || value === undefined
                              ? '—'
                              : formatValue(value, chart.format)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <TimeSeriesChart
            times={data.times}
            bucketSeconds={data.bucketSeconds}
            lines={lines}
            format={chart.format}
            label={chart.title}
            height={HEIGHT}
          />
        )}
      </CardContent>
    </Card>
  )
}
