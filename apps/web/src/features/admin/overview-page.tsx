import type { ServiceStatus, SystemHealth } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import {
  Archive,
  CloudUpload,
  Database,
  HardDrive,
  ListTodo,
  ScanSearch,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes, formatDate, formatDuration, formatFullDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { healthQuery } from './api'

const STATUS_DOTS: Record<ServiceStatus, string> = {
  ok: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-rose-500',
}

/** `/admin`: system health, refreshed every few seconds while open. */
export function OverviewPage() {
  const health = useQuery(healthQuery)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-4 p-4 sm:p-6">
        {health.data ? (
          <HealthView health={health.data} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-36 rounded-xl" />
            ))}
          </div>
        )}
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
        <li className="ml-auto self-center text-xs text-muted-foreground">
          Updated {formatDate(health.checkedAt)}
        </li>
      </ul>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard icon={CloudUpload} title="Sync to Discord">
          <Figure value={sync.backlogFiles.toLocaleString()} unit="files waiting" />
          <Detail>
            {formatBytes(sync.backlogBytes)} to go
            {sync.bytesPerSecond > 0 &&
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
          <Figure value={`${Math.round(cache.hitRate * 100)}%`} unit="hit rate" />
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
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
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
        ratio > warnAbove && '[&_[data-slot=progress-indicator]]:bg-amber-500',
      )}
    />
  )
}
