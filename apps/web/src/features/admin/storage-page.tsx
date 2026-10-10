import {
  ADMIN_TASK_LABELS,
  type AdminTask,
  type AdminTaskKind,
  type StorageStatus,
} from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleX, Combine, Package, RotateCcw, ScanSearch, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDateInSentence, formatFullDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isFinished, storageQuery, tasksQuery, useStartTask } from './api'
import { ChannelsSection } from './channels-page'
import { AllClear, Section } from './section'
import { taskLabel, useTaskResults } from './task-results'

/**
 * `/admin/storage`: the channels, what is stuck between staging and Discord,
 * and what the leading bot can do about them now (§9).
 */
export function StoragePage() {
  const storage = useQuery(storageQuery)
  const tasks = useQuery(tasksQuery)
  const start = useStartTask()
  const discord = storage.data?.blobStore === 'discord'

  /** Whether a task of this kind is being asked for, or is under way. */
  const busy = (kind: AdminTaskKind) =>
    (start.isPending && start.variables.kind === kind) ||
    (tasks.data ?? []).some((task) => task.kind === kind && !isFinished(task))
  const run = (kind: AdminTaskKind) => {
    start.mutate(
      { kind },
      {
        onError: (error) => {
          toast.error(`Couldn’t start “${ADMIN_TASK_LABELS[kind]}”`, {
            description: errorMessage(error),
          })
        },
      },
    )
  }

  useTaskResults(tasks.data)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Tasks</CardTitle>
            <p className="text-xs text-muted-foreground">
              The leading bot does these now, one at a time, rather than on its own schedule.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap gap-2">
              <TaskButton
                icon={Package}
                busy={busy('packs.seal')}
                onClick={() => {
                  run('packs.seal')
                }}
              >
                Seal packs now
              </TaskButton>
              <TaskButton
                icon={ScanSearch}
                busy={busy('orphans.reconcile')}
                disabled={!discord}
                onClick={() => {
                  run('orphans.reconcile')
                }}
              >
                Clean up orphan messages
              </TaskButton>
              <TaskButton
                icon={Wrench}
                busy={busy('discord.setup')}
                disabled={!discord}
                onClick={() => {
                  run('discord.setup')
                }}
              >
                Check the Discord layout
              </TaskButton>
            </div>
            <RecentTasks tasks={tasks.data} />
          </CardContent>
        </Card>

        <ChannelsSection
          discord={discord}
          creating={busy('channel.create')}
          onCreate={() => {
            run('channel.create')
          }}
        />

        {storage.data ? (
          <>
            <Compaction
              compaction={storage.data.compaction}
              compacting={busy('packs.compact')}
              onCompact={() => {
                run('packs.compact')
              }}
            />
            <Uploads
              uploads={storage.data.uploads}
              retrying={busy('uploads.retry')}
              onRetry={() => {
                run('uploads.retry')
              }}
            />
            <Deletions
              deletions={storage.data.deletions}
              retrying={busy('deletions.retry')}
              onRetry={() => {
                run('deletions.retry')
              }}
            />
          </>
        ) : storage.isError ? (
          <p className="text-sm text-muted-foreground">
            Storage couldn’t be read: {errorMessage(storage.error)}
          </p>
        ) : (
          <Skeleton className="h-40 rounded-xl" />
        )}
      </div>
    </div>
  )
}

function TaskButton({
  icon: Icon,
  busy,
  disabled = false,
  onClick,
  children,
}: {
  icon: typeof Package
  busy: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || disabled}
      onClick={onClick}
      title={disabled ? 'This needs Discord storage.' : undefined}
    >
      {busy ? <Spinner /> : <Icon />} {children}
    </Button>
  )
}

function RecentTasks({ tasks }: { tasks: AdminTask[] | undefined }) {
  if (!tasks) return <Skeleton className="h-16 rounded-lg" />
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">No task has run lately.</p>
  }
  return (
    <ul className="grid gap-2" aria-label="Recent tasks">
      {tasks.slice(0, 6).map((task) => (
        <li key={task.id} className="flex items-start gap-2.5 text-sm">
          <span className="mt-0.5 shrink-0">
            {task.state === 'done' ? (
              <CircleCheck className="size-4 text-status-good" aria-label="Done" />
            ) : task.state === 'failed' ? (
              <CircleX className="size-4 text-status-critical" aria-label="Failed" />
            ) : (
              <Spinner aria-label={task.state === 'running' ? 'Running' : 'Waiting'} />
            )}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="font-medium">{taskLabel(task)}</span>
            <span className="text-xs text-muted-foreground">
              {task.result ?? (task.state === 'running' ? 'Running…' : 'Waiting for the bot…')}
            </span>
          </span>
          <span
            className="ml-auto shrink-0 text-xs whitespace-nowrap text-muted-foreground"
            title={formatFullDate(task.createdAt)}
          >
            {task.requestedBy} · {formatDateInSentence(task.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** How old a pack must be before the bot merges it on its own, in words. */
function age(days: number): string {
  if (days === 7) return 'a week'
  return days === 1 ? 'a day' : `${String(days)} days`
}

/** Packs that hold little (§6.6, D32), and what merging them would do. */
function Compaction({
  compaction,
  compacting,
  onCompact,
}: {
  compaction: StorageStatus['compaction']
  compacting: boolean
  onCompact: () => void
}) {
  const { minAgeDays, due, all } = compaction
  const row = (key: string, which: string, figures: typeof due) => ({
    key,
    cells: [
      which,
      String(figures.packs),
      String(figures.into),
      formatBytes(figures.liveBytes),
      formatBytes(figures.freedBytes),
    ],
  })
  return (
    <Section
      title="Packs that hold little"
      description={`Packs whose files were mostly deleted. Once ${age(minAgeDays)} old, the bot merges them into fewer, a group a minute while nothing is being uploaded or downloaded, and the deleted files’ bytes leave Discord with them.`}
      action={
        all.packs > 0 && (
          <Button size="sm" variant="outline" disabled={compacting} onClick={onCompact}>
            {compacting ? <Spinner /> : <Combine />} Compact packs now
          </Button>
        )
      }
    >
      {all.packs === 0 ? (
        <AllClear>No packs hold little enough to merge.</AllClear>
      ) : (
        <Rows
          head={['Packs', 'Merged', 'Into', 'Files', 'Frees']}
          rows={[
            row('due', `${capitalized(age(minAgeDays))} old or more`, due),
            row('all', 'Any age, with Compact packs now', all),
          ]}
        />
      )}
    </Section>
  )
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function Uploads({
  uploads,
  retrying,
  onRetry,
}: {
  uploads: StorageStatus['uploads']
  retrying: boolean
  onRetry: () => void
}) {
  const failed = uploads.filter((upload) => upload.state === 'failed').length
  return (
    <Section
      title="Failing uploads"
      description="Blobs whose posting to Discord failed: retried with backoff, then given up after every try."
      action={
        failed > 0 && (
          <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
            {retrying ? <Spinner /> : <RotateCcw />} Retry {failed} given up
          </Button>
        )
      }
    >
      {uploads.length === 0 ? (
        <AllClear>Every upload reaches Discord.</AllClear>
      ) : (
        <Rows
          head={['Blob', 'Size', 'Tries', 'Last error']}
          rows={uploads.map((upload) => ({
            key: upload.jobId,
            cells: [
              <span key="blob" className="font-mono text-xs">
                {upload.blobId}
                <span className="block font-sans text-muted-foreground">
                  {upload.kind ?? 'purged'} · since {formatDateInSentence(upload.since)}
                </span>
              </span>,
              upload.sizeBytes === null ? '—' : formatBytes(upload.sizeBytes),
              <span key="tries" className={cn(upload.state === 'failed' && 'text-status-critical')}>
                {upload.state === 'failed'
                  ? 'gave up'
                  : `${String(upload.attempts)} of ${String(upload.maxAttempts)}`}
              </span>,
              <ErrorText key="error" error={upload.error} />,
            ],
          }))}
        />
      )}
    </Section>
  )
}

function Deletions({
  deletions,
  retrying,
  onRetry,
}: {
  deletions: StorageStatus['deletions']
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <Section
      title="Failing deletions"
      description="Released blobs whose message couldn’t be deleted. The bot keeps trying, after the others."
      action={
        deletions.length > 0 && (
          <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
            {retrying ? <Spinner /> : <RotateCcw />} Try them now
          </Button>
        )
      }
    >
      {deletions.length === 0 ? (
        <AllClear>Every released blob was deleted.</AllClear>
      ) : (
        <Rows
          head={['Blob', 'Channel', 'Tries', 'Last error']}
          rows={deletions.map((deletion) => ({
            key: deletion.blobId,
            cells: [
              <span key="blob" className="font-mono text-xs">
                {deletion.blobId}
              </span>,
              deletion.channelName ? `#${deletion.channelName}` : '—',
              String(deletion.attempts),
              <ErrorText key="error" error={deletion.error} />,
            ],
          }))}
        />
      )}
    </Section>
  )
}

function ErrorText({ error }: { error: string | null }) {
  return (
    <span className="line-clamp-2 text-xs break-words text-muted-foreground" title={error ?? ''}>
      {error ?? '—'}
    </span>
  )
}

/** A table whose first column names the row and whose last one may wrap. */
function Rows({ head, rows }: { head: string[]; rows: { key: string; cells: ReactNode[] }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {head.map((label, index) => (
              <th key={label} className={cn('pb-2 font-medium', index > 0 && 'pl-4')}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border/60 align-top">
              {row.cells.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    'py-1.5',
                    index > 0 && 'pl-4',
                    index < row.cells.length - 1 && 'whitespace-nowrap',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
