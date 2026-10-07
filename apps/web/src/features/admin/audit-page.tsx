import type { AuditEntry } from '@dfs/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  Database,
  DatabaseBackup,
  Eye,
  Hash,
  Link2,
  Link2Off,
  History,
  KeyRound,
  LogIn,
  LogOut,
  Search,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldAlert,
  Trash,
  Trash2,
  Upload,
  UserCheck,
  UserCog,
  UserLock,
  UserPlus,
  UserX,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { ListSkeleton } from '@/components/list-skeleton'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Spinner } from '@/components/ui/spinner'
import { VirtualList } from '@/components/virtual-list'
import { formatDate, formatFullDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { auditQuery } from './api'

const ROW_HEIGHT = 56

/** Known actions; others show their code as-is. */
const ACTIONS: Record<string, { label: string; icon: LucideIcon; tone?: string }> = {
  'user.created': { label: 'Added user', icon: UserPlus },
  'user.updated': { label: 'Updated user', icon: UserCog },
  'user.password_reset': { label: 'Reset password', icon: KeyRound, tone: 'text-amber-500' },
  'user.disabled': { label: 'Disabled user', icon: UserX, tone: 'text-amber-500' },
  'user.enabled': { label: 'Enabled user', icon: UserCheck },
  'auth.login': { label: 'Signed in', icon: LogIn },
  'auth.login_failed': { label: 'Failed sign-in', icon: UserLock, tone: 'text-destructive' },
  'auth.password_changed': { label: 'Changed password', icon: KeyRound },
  'share.created': { label: 'Shared a link', icon: Link2 },
  'share.revoked': { label: 'Deleted a link', icon: Link2Off },
  'admin.viewed': { label: 'Viewed a drive', icon: Eye },
  'upload.completed': { label: 'Uploaded', icon: Upload },
  'node.trashed': { label: 'Moved to the trash', icon: Trash },
  'node.restored': { label: 'Restored', icon: RotateCcw },
  'node.purged': { label: 'Deleted for good', icon: Trash2 },
  'node.moderated': { label: 'Removed content', icon: ShieldAlert, tone: 'text-destructive' },
  'channel.created': { label: 'Added channel', icon: Hash },
  'channel.enabled': { label: 'Enabled channel', icon: Hash },
  'channel.disabled': { label: 'Disabled channel', icon: Hash, tone: 'text-amber-500' },
  'task.started': { label: 'Ran a task', icon: Play },
  'session.ended': { label: 'Signed a session out', icon: LogOut, tone: 'text-amber-500' },
  'user.signed_out': { label: 'Signed out everywhere', icon: LogOut, tone: 'text-amber-500' },
  'upload.cancelled': { label: 'Gave up an upload', icon: XCircle, tone: 'text-amber-500' },
  'database.vacuumed': { label: 'Vacuumed a table', icon: Database },
  'system.cache_cleared': { label: 'Cleared the frame cache', icon: Database },
  'database.query_cancelled': {
    label: 'Cancelled a query',
    icon: Database,
    tone: 'text-amber-500',
  },
  'database.session_ended': {
    label: 'Ended a database session',
    icon: Database,
    tone: 'text-amber-500',
  },
  'backup.completed': { label: 'Backup completed', icon: DatabaseBackup, tone: 'text-emerald-500' },
  'scrub.completed': { label: 'Scrub completed', icon: ScanSearch },
}

/** Kinds of action to narrow the log to, by the prefixes of their names. */
const CATEGORIES = [
  { value: 'all', label: 'All', actions: [] },
  { value: 'sign-ins', label: 'Sign-ins', actions: ['auth.', 'session.'] },
  { value: 'accounts', label: 'Accounts', actions: ['user.'] },
  { value: 'sharing', label: 'Sharing', actions: ['share.'] },
  { value: 'content', label: 'Content', actions: ['node.', 'upload.', 'admin.'] },
  {
    value: 'system',
    label: 'System',
    actions: ['channel.', 'task.', 'database.', 'system.', 'blob.', 'backup.', 'scrub.'],
  },
] as const

/** `/admin/audit`: who did what, newest first, by kind or by words (§7.5). */
export function AuditPage() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('all')
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  // Searches once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(draft.trim())
    }, 300)
    return () => {
      clearTimeout(timer)
    }
  }, [draft])
  const actions = [...(CATEGORIES.find((entry) => entry.value === category)?.actions ?? [])]
  const audit = useInfiniteQuery(auditQuery({ actions, q }))
  const entries = audit.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={category}
          aria-label="Kind of action"
          onValueChange={(value) => {
            const found = CATEGORIES.find((entry) => entry.value === value)
            if (found) setCategory(found.value)
          }}
        >
          {CATEGORIES.map((entry) => (
            <ToggleGroupItem key={entry.value} value={entry.value} className="px-2.5">
              {entry.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="relative ml-auto w-full sm:w-64">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            placeholder="Find a name or address"
            aria-label="Find in the audit log"
            className="pl-8"
          />
        </div>
      </div>
      {audit.isPending ? (
        <ListSkeleton />
      ) : entries.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
      ) : (
        <AuditList
          entries={entries}
          stale={audit.isPlaceholderData}
          onEndReached={
            audit.hasNextPage && !audit.isFetchingNextPage
              ? () => void audit.fetchNextPage()
              : undefined
          }
          loadingMore={audit.isFetchingNextPage}
        />
      )}
    </div>
  )
}

function AuditList({
  entries,
  stale,
  onEndReached,
  loadingMore,
}: {
  entries: AuditEntry[]
  stale: boolean
  onEndReached: (() => void) | undefined
  loadingMore: boolean
}) {
  return (
    <VirtualList
      role="list"
      aria-label="Audit log"
      className={cn('flex-1 py-1 transition-opacity motion-glide', stale && 'opacity-50')}
      items={entries}
      getKey={(entry) => entry.id}
      itemHeight={ROW_HEIGHT}
      animateMoves
      onEndReached={onEndReached}
      renderItem={(entry) => <AuditRow entry={entry} />}
      footer={
        loadingMore && (
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
