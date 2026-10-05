import type { DatabaseSession, DatabaseStatus } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { Ban, MoreHorizontal, Power, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDate, formatDuration, formatFullDate } from '@/lib/format'
import { usePreferences } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { databaseQuery, useSignalSession } from './api'
import { MetricChart } from './charts/metric-chart'
import { RangePicker } from './charts/range-picker'
import { formatValue } from './charts/scales'
import { DATABASE_CHARTS } from './dashboards'
import { metricsQuery, seriesOf } from './metrics'

const DATABASE_SERIES = seriesOf(...DATABASE_CHARTS)
/**
 * Dead rows worth a warning: past autovacuum's own trigger (a fifth of the
 * table), and enough to matter; small tables cross the share all the time.
 */
const DEAD_ROWS_WARNING = { share: 0.2, rows: 1000 }

/** `/admin/database`: PostgreSQL now and over time (§16), and its stuck queries. */
export function DatabasePage() {
  const status = useQuery(databaseQuery)
  const range = usePreferences((state) => state.metricRange)
  const history = useQuery(metricsQuery(range, DATABASE_SERIES))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-8 p-4 sm:p-6">
        {status.data ? (
          <Now status={status.data} />
        ) : status.isError ? (
          <p className="text-sm text-muted-foreground">
            PostgreSQL’s statistics couldn’t be read: {errorMessage(status.error)}
          </p>
        ) : (
          <div className="grid gap-4">
            <Skeleton className="h-9 w-2/3 rounded-full" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
        )}

        <section aria-labelledby="database-history" className="grid gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h2 id="database-history" className="text-base font-medium">
              History
            </h2>
            <RangePicker />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {DATABASE_CHARTS.map((chart) => (
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

        {status.data && <Details status={status.data} />}
      </div>
    </div>
  )
}

/** The server in a line, then what runs right now. */
function Now({ status }: { status: DatabaseStatus }) {
  const { connections } = status
  const uptimeSeconds = (Date.parse(status.checkedAt) - Date.parse(status.startedAt)) / 1000
  return (
    <section aria-label="Now" className="grid gap-4">
      <ul className="flex flex-wrap gap-2 text-sm" aria-label="PostgreSQL">
        <Chip label={status.version} detail={`up ${formatDuration(uptimeSeconds)}`} />
        <Chip label="Size" detail={formatBytes(status.sizeBytes)} />
        <Chip
          label="Connections"
          detail={`${String(connections.used)} of ${String(connections.max)}`}
          warn={connections.used >= connections.max * 0.8}
        />
        <Chip
          label="Buffer cache"
          detail={
            status.cacheHitRatio === null
              ? 'no reads yet'
              : `${formatValue(status.cacheHitRatio, 'percent')} hits`
          }
        />
        <Chip
          label="Deadlocks"
          detail={status.deadlocks.toLocaleString()}
          warn={status.deadlocks > 0}
        />
        <li className="ml-auto self-center text-xs text-muted-foreground">
          {status.statsSince
            ? `Counting since ${formatDate(status.statsSince)}`
            : 'Counting since the server started'}{' '}
          · Updated {formatDate(status.checkedAt)}
        </li>
      </ul>
      <Sessions sessions={status.sessions} />
    </section>
  )
}

function Chip({ label, detail, warn = false }: { label: string; detail: string; warn?: boolean }) {
  return (
    <li className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5">
      {warn && <TriangleAlert className="size-3.5 text-status-warning" aria-label="Look at this" />}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground tabular-nums">{detail}</span>
    </li>
  )
}

/** Connections running a query or holding a transaction, oldest first; each can be stopped. */
function Sessions({ sessions }: { sessions: DatabaseSession[] }) {
  const signal = useSignalSession()
  const [confirming, setConfirming] = useState<{
    session: DatabaseSession
    how: 'cancel' | 'terminate'
  } | null>(null)

  const confirm = async () => {
    if (!confirming) return
    const { session, how } = confirming
    setConfirming(null)
    try {
      await signal.mutateAsync({ pid: session.pid, how })
      toast.success(
        how === 'cancel'
          ? `Cancelled ${session.application}’s query`
          : `Ended ${session.application}’s connection`,
      )
    } catch (error) {
      toast.error('Couldn’t do that', { description: errorMessage(error) })
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Running now</CardTitle>
        <p className="text-xs text-muted-foreground">
          Queries running longer than a quarter second, waiting for a lock, or holding a transaction
          open; longest first. DFS’s own queries show placeholders where their values go.
        </p>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing is running: every connection is idle.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Connection</th>
                  <th className="pb-2 font-medium">State</th>
                  <th className="pb-2 text-right font-medium">Running for</th>
                  <th className="pb-2 pl-4 font-medium">Query</th>
                  <th className="w-10 pb-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.pid} className="border-t border-border/60 align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <span className="font-medium">{session.application}</span>{' '}
                      <span className="font-mono text-xs text-muted-foreground">{session.pid}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="whitespace-nowrap">{session.state}</span>
                      {session.waitingFor && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <TriangleAlert
                            className="size-3 shrink-0 text-status-warning"
                            aria-hidden
                          />
                          waits for {session.waitingFor}
                          {session.blockedBy.length > 0 &&
                            `, held by ${session.blockedBy.join(', ')}`}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap tabular-nums">
                      {formatValue(session.querySeconds * 1000, 'ms')}
                      {session.transactionSeconds !== null &&
                        session.transactionSeconds - session.querySeconds > 1 && (
                          <span className="block text-xs text-muted-foreground">
                            transaction {formatValue(session.transactionSeconds * 1000, 'ms')}
                          </span>
                        )}
                    </td>
                    <td className="max-w-md py-2 pl-4">
                      <code
                        className="line-clamp-2 font-mono text-xs break-all text-muted-foreground"
                        title={session.query}
                      >
                        {session.query || '—'}
                      </code>
                    </td>
                    <td className="py-1.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Stop ${session.application} ${String(session.pid)}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {/* Idle in a transaction, there's no query to cancel. */}
                          {session.state === 'active' && (
                            <DropdownMenuItem
                              onSelect={() => {
                                setConfirming({ session, how: 'cancel' })
                              }}
                            >
                              <Ban /> Cancel query
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => {
                              setConfirming({ session, how: 'terminate' })
                            }}
                          >
                            <Power /> End connection
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.how === 'cancel'
                ? `Cancel ${confirming.session.application}’s query?`
                : `End ${confirming?.session.application ?? ''}’s connection?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.how === 'cancel'
                ? 'The query stops and its transaction rolls back. The request that ran it fails; the bot retries its own work.'
                : 'The connection closes and its transaction rolls back. The service opens a new one when it needs it; the bot’s queue connection may restart the bot.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirm()}>
              {confirming?.how === 'cancel' ? 'Cancel query' : 'End connection'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/** Connections by service, the slowest statements, tables, unused indexes and settings. */
function Details({ status }: { status: DatabaseStatus }) {
  const since = status.statsSince ? formatDate(status.statsSince) : 'the server started'

  return (
    <section aria-label="Details" className="grid gap-4 lg:grid-cols-2">
      <Panel title="Connections by service" description="Who holds this database’s connections.">
        <Table
          head={['Service', 'Total', 'Running', 'Idle', 'In a transaction']}
          rows={status.connections.byApplication.map((entry) => [
            entry.application,
            entry.total,
            entry.active,
            entry.idle,
            entry.idleInTransaction,
          ])}
        />
      </Panel>

      <Panel
        title="Slowest statements"
        description={`The statements that took the most time since ${since}, values left out.`}
      >
        {status.statements.unavailable ? (
          <p className="text-sm text-muted-foreground">{status.statements.unavailable}</p>
        ) : (
          <ul className="grid gap-3">
            {status.statements.items.map((statement) => (
              <li key={statement.query} className="grid gap-1 border-t border-border/60 pt-2">
                <code
                  className="line-clamp-2 font-mono text-xs break-all text-muted-foreground"
                  title={statement.query}
                >
                  {statement.query}
                </code>
                <p className="text-xs tabular-nums">
                  <span className="font-medium">{formatValue(statement.totalMs, 'ms')} in all</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {statement.calls.toLocaleString()} calls ·{' '}
                    {formatValue(statement.meanMs, 'ms')} each · {statement.rows.toLocaleString()}{' '}
                    rows
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Tables"
        description="The largest, with their indexes; dead rows wait for vacuum."
        wide
      >
        <Table
          head={['Table', 'Rows', 'Dead rows', 'Size', 'Indexes', 'Vacuumed', 'Index use']}
          rows={status.tables.map((table) => {
            const deadShare = table.deadRows / Math.max(1, table.rows + table.deadRows)
            const scans = table.seqScans + table.indexScans
            return [
              table.name,
              table.rows,
              <span key="dead" className="inline-flex items-center gap-1">
                {deadShare >= DEAD_ROWS_WARNING.share &&
                  table.deadRows >= DEAD_ROWS_WARNING.rows && (
                    <TriangleAlert
                      className="size-3 text-status-warning"
                      aria-label="Many dead rows"
                    />
                  )}
                {table.deadRows.toLocaleString()}
              </span>,
              formatBytes(table.totalBytes),
              formatBytes(table.indexBytes),
              table.lastVacuumAt ? (
                <span key="vacuum" title={formatFullDate(table.lastVacuumAt)}>
                  {formatDate(table.lastVacuumAt)}
                </span>
              ) : (
                'never'
              ),
              scans === 0 ? '—' : formatValue(table.indexScans / scans, 'percent'),
            ]
          })}
        />
      </Panel>

      <Panel
        title="Unused indexes"
        description={`No query has used these since ${since}; each still costs time on every write.`}
      >
        {status.unusedIndexes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every index has been used.</p>
        ) : (
          <Table
            head={['Index', 'Table', 'Size']}
            rows={status.unusedIndexes.map((index) => [
              index.name,
              index.table,
              formatBytes(index.bytes),
            ])}
          />
        )}
      </Panel>

      <Panel title="Settings" description="The ones that matter when tuning.">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {status.settings.map((setting) => (
            <div key={setting.name} className="contents">
              <dt className="font-mono text-xs text-muted-foreground">{setting.name}</dt>
              <dd className="font-mono text-xs break-all">{setting.value}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </section>
  )
}

function Panel({
  title,
  description,
  wide = false,
  children,
}: {
  title: string
  description: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <Card size="sm" className={cn(wide && 'lg:col-span-2')}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** A plain table: the first column is a name, the rest are figures. */
function Table({ head, rows }: { head: string[]; rows: [string, ...ReactNode[]][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {head.map((label, index) => (
              <th key={label} className={cn('pb-2 font-medium', index > 0 && 'pl-4 text-right')}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-t border-border/60">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    'py-1.5',
                    index === 0
                      ? 'font-medium break-all'
                      : 'pl-4 text-right whitespace-nowrap tabular-nums',
                  )}
                >
                  {typeof cell === 'number' ? cell.toLocaleString() : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
