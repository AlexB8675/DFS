import type { MetricRange } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { usePreferences } from '@/lib/preferences'
import { MetricChart } from './charts/metric-chart'
import { RangePicker } from './charts/range-picker'
import { MONITORING_SECTIONS, type DashboardSection } from './dashboards'
import { metricsQuery, seriesOf } from './metrics'

/** `/admin/monitoring`: every graph DFS keeps, by area, over one range (§16). */
export function MonitoringPage() {
  const range = usePreferences((state) => state.metricRange)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-8 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <RangePicker />
          <p className="text-sm text-muted-foreground">
            Point at a graph, or focus it and use the arrow keys, to read its values.
          </p>
        </div>
        {MONITORING_SECTIONS.map((section) => (
          <Section key={section.title} section={section} range={range} />
        ))}
      </div>
    </div>
  )
}

/** One area's graphs, read in one request. */
function Section({ section, range }: { section: DashboardSection; range: MetricRange }) {
  const metrics = useQuery(metricsQuery(range, seriesOf(...section.charts)))
  const id = `section-${section.title.toLowerCase().replaceAll(' ', '-')}`

  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div>
        <h2 id={id} className="text-base font-medium">
          {section.title}
        </h2>
        <p className="text-sm text-muted-foreground">{section.description}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {section.charts.map((chart) => (
          <MetricChart
            key={chart.title}
            chart={chart}
            data={metrics.data}
            stale={metrics.isPlaceholderData}
            failed={metrics.isError}
          />
        ))}
      </div>
    </section>
  )
}
