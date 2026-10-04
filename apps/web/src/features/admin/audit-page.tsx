import type { AuditEntry } from '@dfs/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  DatabaseBackup,
  Hash,
  History,
  ScanSearch,
  ShieldAlert,
  TriangleAlert,
  UserCheck,
  UserCog,
  UserX,
  type LucideIcon,
} from 'lucide-react'
import { ListSkeleton } from '@/components/list-skeleton'
import { Spinner } from '@/components/ui/spinner'
import { VirtualList } from '@/components/virtual-list'
import { formatDate, formatFullDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { auditQuery } from './api'

const ROW_HEIGHT = 56

/** Known actions; others show their code as-is. */
const ACTIONS: Record<string, { label: string; icon: LucideIcon; tone?: string }> = {
  'user.updated': { label: 'Updated user', icon: UserCog },
  'user.disabled': { label: 'Disabled user', icon: UserX, tone: 'text-amber-500' },
  'user.enabled': { label: 'Enabled user', icon: UserCheck },
  'node.moderated': { label: 'Removed content', icon: ShieldAlert, tone: 'text-destructive' },
  'channel.created': { label: 'Added channel', icon: Hash },
  'channel.enabled': { label: 'Enabled channel', icon: Hash },
  'channel.disabled': { label: 'Disabled channel', icon: Hash, tone: 'text-amber-500' },
  'backup.completed': { label: 'Backup completed', icon: DatabaseBackup, tone: 'text-emerald-500' },
  'scrub.completed': { label: 'Scrub completed', icon: ScanSearch },
  'blob.lost': { label: 'Blob lost', icon: TriangleAlert, tone: 'text-destructive' },
}

/** `/admin/audit`: who did what, newest first (§7.5). */
export function AuditPage() {
  const audit = useInfiniteQuery(auditQuery)
  const entries = audit.data?.pages.flatMap((page) => page.items) ?? []

  if (audit.isPending) return <ListSkeleton />

  return (
    <VirtualList
      role="list"
      aria-label="Audit log"
      className="flex-1 py-1"
      items={entries}
      getKey={(entry) => entry.id}
      itemHeight={ROW_HEIGHT}
      animateMoves
      onEndReached={
        audit.hasNextPage && !audit.isFetchingNextPage
          ? () => void audit.fetchNextPage()
          : undefined
      }
      renderItem={(entry) => <AuditRow entry={entry} />}
      footer={
        audit.isFetchingNextPage && (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        )
      }
    />
  )
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const action = ACTIONS[entry.action] ?? { label: entry.action, icon: History }
  const Icon = action.icon
  return (
    <div
      role="listitem"
      className="mx-2 flex h-full items-center gap-3 rounded-md px-3 hover:bg-muted/40"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className={cn('size-4', action.tone ?? 'text-muted-foreground')} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium">{action.label}</span>
          <span className="text-muted-foreground"> · </span>
          {entry.target}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {entry.actorName}
          {entry.details && ` · ${entry.details}`}
        </p>
      </div>
      <time
        dateTime={entry.at}
        title={formatFullDate(entry.at)}
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
      >
        {formatDate(entry.at)}
      </time>
    </div>
  )
}
