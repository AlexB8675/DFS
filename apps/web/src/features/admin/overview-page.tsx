import type { MetricSeries, ServiceStatus, SystemAlert, SystemHealth } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import {
  Archive,
  ArrowRight,
  CircleCheck,
  CloudUpload,
  Database,
  HardDrive,
  ListTodo,
  OctagonAlert,
  ScanSearch,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes, formatDate, formatDuration, formatFullDate } from '@/lib/format'
import { usePreferences } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { healthQuery } from './api'
import { MetricChart } from './charts/metric-chart'
import { RangePicker } from './charts/range-picker'
import { formatValue } from './charts/scales'
import { Sparkline } from './charts/sparkline'
import { OVERVIEW_CHARTS } from './dashboards'
import { metricsQuery, RANGES, seriesOf } from './metrics'

const STATUS_DOTS: Record<ServiceStatus, string> = {
  ok: 'bg-status-good',
  degraded: 'bg-status-warning',
  down: 'bg-status-critical',
}

/** The figures of the tiles above the graphs, read alongside them. */
const FIGURES = [
  'storage.bytes:avg',
  'uploads.bytes:rate',
  'downloads.bytes:rate',
  'http.requests:rate',
  'http.ms:p95',
] as const

const HISTORY_SERIES = [...new Set([...FIGURES, ...seriesOf(...OVERVIEW_CHARTS)])]

/**
 * `/admin`: what needs attention and the state of things now, refreshed
 * every few seconds, then how it went over a chosen range (§16).
 */
export function OverviewPage() {
  const health = useQuery(healthQuery)
  const range = usePreferences((state) => state.metricRange)
  const history = useQuery(metricsQuery(range, HISTORY_SERIES))
  const rangeLabel = RANGES.find((option) => option.value === range)?.label ?? range

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-8 p-4 sm:p-6">
        <section aria-label="Now" className="grid gap-4">
          {health.data ? (
            <HealthView health={health.data} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-36 rounded-xl" />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="history-title" className="grid gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h2 id="history-title" className="text-base font-medium">
              History
            </h2>
            <RangePicker />
            <Link
              to="/admin/monitoring"
              className="ml-auto flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Every graph <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <Figures data={history.data} rangeLabel={rangeLabel} stale={history.isPlaceholderData} />
          <div className="grid gap-4 lg:grid-cols-2">
            {OVERVIEW_CHARTS.map((chart) => (
              <MetricChart
                key={chart.title}
                chart={chart}
                data={history.data}
                stale={history.isPlaceholderData}
                failed={history.isError}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function HealthView({ health }: { health: SystemHealth }) {
  const { sync, queue, staging, cache, storage, scrubber, backups } = health
  const stagingRatio = staging.maxBytes === 0 ? 0 : staging.usedBytes / staging.maxBytes
  const backlogSeconds = sync.bytesPerSecond > 0 ? sync.backlogBytes / sync.bytesPerSecond : 0

  return (
    <>
      {health.alerts.length > 0 && <Alerts alerts={health.alerts} />}

      <ul className="flex flex-wrap gap-2" aria-label="Services">
        {health.services.map((service) => (
          <li
            key={service.name}
            className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm"
            title={service.detail}
          >
            <span className={cn('size-2 rounded-full', STATUS_DOTS[service.status])} />
            <span className="font-medium">{service.name}</span>
            <span className="text-muted-foreground">{service.detail}</span>
          </li>
        ))}
        <li className="ml-auto flex items-center gap-1.5 self-center text-xs text-muted-foreground">
          {health.alerts.length === 0 && (
            <>
              <CircleCheck className="size-3.5 text-status-good" aria-hidden />
              Nothing needs attention ·
            </>
          )}{' '}
          Updated {formatDate(health.checkedAt)}
        </li>
      </ul>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={CloudUpload} title="Sync to Discord">
          <Figure value={sync.backlogFiles.toLocaleString()} unit="files waiting" />
          <Detail>
            {formatBytes(sync.backlogBytes)} to go
            {sync.bytesPerSecond > 0 &&
              sync.backlogBytes > 0 &&
              ` · ${formatBytes(sync.bytesPerSecond)}/s · about ${formatDuration(backlogSeconds)}`}
          </Detail>
        </StatCard>

        <StatCard icon={ListTodo} title="Job queue">
          <Figure value={queue.pendingJobs.toLocaleString()} unit="pending" />
          <Detail>
            <span className={cn(queue.failedJobs > 0 && 'text-destructive')}>
              {queue.failedJobs} failed
            </span>
            {queue.oldestPendingSeconds > 0 &&
              ` · oldest waiting ${formatDuration(queue.oldestPendingSeconds)}`}
          </Detail>
        </StatCard>

        <StatCard icon={HardDrive} title="Staging">
          <Figure
            value={formatBytes(staging.usedBytes)}
            unit={`of ${formatBytes(staging.maxBytes)}`}
          />
          <Meter ratio={stagingRatio} label="Staging used" warnAbove={0.8} />
          <Detail>Uploads pause with 503 when it is full.</Detail>
        </StatCard>

        <StatCard icon={Database} title="Storage">
          <Figure value={formatBytes(storage.storedBytes)} unit="on Discord" />
          <Detail>
            {storage.blobCount.toLocaleString()} blobs, {storage.packCount.toLocaleString()} packs ·{' '}
            {Math.round((storage.liveBytes / Math.max(1, storage.storedBytes)) * 100)}% live
          </Detail>
        </StatCard>

        <StatCard icon={Archive} title="Frame cache">
          <Figure value={`${Math.round(cache.hitRate * 100)}%`} unit="hit rate, last hour" />
          <Meter ratio={cache.usedBytes / Math.max(1, cache.maxBytes)} label="Cache used" />
          <Detail>
            {formatBytes(cache.usedBytes)} of {formatBytes(cache.maxBytes)}
          </Detail>
        </StatCard>

        <StatCard icon={ScanSearch} title="Integrity">
          <Figure
            value={`${Math.round((scrubber.checkedBlobs / Math.max(1, scrubber.totalBlobs)) * 100)}%`}
            unit="scrubbed this cycle"
          />
          <Meter
            ratio={scrubber.checkedBlobs / Math.max(1, scrubber.totalBlobs)}
            label="Scrubbed"
          />
          <Detail>
            <span className={cn(scrubber.problems > 0 && 'text-destructive')}>
              {scrubber.problems} problem{scrubber.problems === 1 ? '' : 's'}
            </span>
            {' · '}last backup {backups.lastBackupAt ? formatDate(backups.lastBackupAt) : 'never'}
          </Detail>
        </StatCard>
      </div>

      {health.lostBlobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-destructive" /> Lost blobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Blob</th>
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 font-medium">Detected</th>
                  <th className="pb-2 text-right font-medium">Files</th>
                </tr>
              </thead>
              <tbody>
                {health.lostBlobs.map((blob) => (
                  <tr key={blob.blobId} className="border-t border-border/60">
                    <td className="py-2 font-mono text-xs">{blob.blobId.slice(0, 8)}</td>
                    <td className="py-2">#{blob.channelName}</td>
                    <td
                      className="py-2 text-muted-foreground"
                      title={formatFullDate(blob.detectedAt)}
                    >
                      {formatDate(blob.detectedAt)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{blob.affectedFiles}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </>
  )
}

const ALERT_LOOKS = {
  critical: {
    icon: OctagonAlert,
    label: 'Critical',
    tone: 'text-status-critical',
    border: 'border-status-critical/50',
  },
  warning: {
    icon: TriangleAlert,
    label: 'Warning',
    tone: 'text-status-warning',
    border: 'border-status-warning/60',
  },
} as const

/** What needs attention, worst first; each with an icon and its level, never colour alone. */
function Alerts({ alerts }: { alerts: SystemAlert[] }) {
  return (
    <ul aria-label="Needs attention" className="grid gap-2">
      {alerts.map((alert) => {
        const look = ALERT_LOOKS[alert.level]
        return (
          <li
            key={alert.code}
            className={cn(
              'flex animate-in items-start gap-3 rounded-xl border bg-card px-4 py-3 fade-in-0 motion-glide',
              look.border,
            )}
          >
            <look.icon className={cn('mt-0.5 size-4 shrink-0', look.tone)} aria-hidden />
            <div className="grid gap-0.5 text-sm">
              <p className="font-medium">
                <span className="sr-only">{look.label}: </span>
                {alert.title}
              </p>
              <p className="text-muted-foreground">{alert.detail}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** The range in four figures, each with its trend. */
function Figures({
  data,
  rangeLabel,
  stale,
}: {
  data: MetricSeries | undefined
  rangeLabel: string
  stale: boolean
}) {
  const series = (id: (typeof FIGURES)[number]) => data?.series.find((entry) => entry.id === id)
  const peak = (id: (typeof FIGURES)[number]) => {
    let max: number | null = null
    for (const value of series(id)?.values ?? [])
      if (value !== null) max = Math.max(max ?? 0, value)
    return max
  }
  const storedValues = series('storage.bytes:avg')?.values ?? []
  const stored = storedValues.filter((value) => value !== null)
  const firstStored = stored[0]
  const lastStored = stored.at(-1)
  const growth =
    firstStored !== undefined && lastStored !== undefined ? lastStored - firstStored : null
  const received = series('uploads.bytes:rate')
  const sent = series('downloads.bytes:rate')
  const requests = series('http.requests:rate')
  const p95 = series('http.ms:p95')?.overall
  const receivedPeak = peak('uploads.bytes:rate')
  const sentPeak = peak('downloads.bytes:rate')

  if (!data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'grid gap-4 transition-opacity motion-glide sm:grid-cols-2 lg:grid-cols-4',
        stale && 'opacity-50',
      )}
    >
      <FigureTile
        label="Stored on Discord"
        value={lastStored === undefined ? '—' : formatBytes(lastStored)}
        detail={
          growth === null
            ? 'Nothing recorded yet'
            : `${growth >= 0 ? '+' : '−'}${formatBytes(Math.abs(growth))} in ${rangeLabel}`
        }
        values={storedValues}
      />
      <FigureTile
        label="Received from browsers"
        value={formatBytes(received?.overall ?? 0)}
        detail={
          receivedPeak ? `peak ${formatValue(receivedPeak, 'bytesPerSecond')}` : `in ${rangeLabel}`
        }
        values={received?.values ?? []}
      />
      <FigureTile
        label="Sent to browsers"
        value={formatBytes(sent?.overall ?? 0)}
        detail={sentPeak ? `peak ${formatValue(sentPeak, 'bytesPerSecond')}` : `in ${rangeLabel}`}
        values={sent?.values ?? []}
      />
      <FigureTile
        label="Requests"
        value={formatValue(requests?.overall ?? 0, 'count')}
        detail={
          p95 === null || p95 === undefined
            ? `in ${rangeLabel}`
            : `95% answered within ${formatValue(p95, 'ms')}`
        }
        values={requests?.values ?? []}
      />
    </div>
  )
}

function FigureTile({
  label,
  value,
  detail,
  values,
}: {
  label: string
  value: string
  detail: string
  values: readonly (number | null)[]
}) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold">{value}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
        <div className="mt-1">
          <Sparkline values={values} />
        </div>
      </CardContent>
    </Card>
  )
}

function StatCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: ReactNode
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" aria-hidden /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">{children}</CardContent>
    </Card>
  )
}

function Figure({ value, unit }: { value: string; unit: string }) {
  return (
    <p className="flex items-baseline gap-1.5">
      <span className="text-2xl font-semibold">{value}</span>
      <span className="text-sm text-muted-foreground">{unit}</span>
    </p>
  )
}

function Detail({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground tabular-nums">{children}</p>
}

function Meter({
  ratio,
  label,
  warnAbove = 1,
}: {
  ratio: number
  label: string
  warnAbove?: number
}) {
  return (
    <Progress
      value={Math.min(100, ratio * 100)}
      aria-label={label}
      className={cn(
        'h-1.5',
        ratio > warnAbove && '[&_[data-slot=progress-indicator]]:bg-status-warning',
      )}
    />
  )
}
