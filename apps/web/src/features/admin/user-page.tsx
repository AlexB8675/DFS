import type { AdminUser, DriveNode, UsageCategory, UserUsage } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, EyeOff, ShieldX, UserX } from 'lucide-react'
import { Fragment, useActionState, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { ListSkeleton } from '@/components/list-skeleton'
import { NodeIcon } from '@/components/node-icon'
import { SyncStatus } from '@/components/sync-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { VirtualList } from '@/components/virtual-list'
import { sessionQuery } from '@/features/auth/session'
import { linkCount } from '@/features/shares/api'
import { LinkWarning } from '@/features/shares/link-warning'
import { UserAvatar } from '@/layout/user-menu'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { formText } from '@/lib/form-data'
import { transitionLinkProps } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import {
  adminChildrenQuery,
  adminPathQuery,
  adminUsersQuery,
  linksToDeleteQuery,
  useModerateNode,
  userUsageQuery,
} from './api'
import { UserBadges } from './user-badges'
import { UserSessions } from './user-sessions'

const ROW_HEIGHT = 40

const CATEGORIES: Record<UsageCategory, { label: string; color: string }> = {
  image: { label: 'Images', color: 'bg-emerald-500' },
  video: { label: 'Videos', color: 'bg-rose-500' },
  audio: { label: 'Audio', color: 'bg-violet-500' },
  document: { label: 'Documents', color: 'bg-sky-500' },
  archive: { label: 'Archives', color: 'bg-amber-500' },
  other: { label: 'Other', color: 'bg-slate-400' },
}

/**
 * `/admin/users/:userId(/folders/:folderId)`: one user's storage, and a
 * read-only browser of their files. Names, sizes and dates only: there is no
 * way to open or download anything here (D4).
 */
export function UserPage() {
  const { userId = '', folderId } = useParams()
  const users = useQuery(adminUsersQuery)
  const usage = useQuery(userUsageQuery(userId))
  const session = useQuery(sessionQuery)
  const user = users.data?.items.find((candidate) => candidate.id === userId)
  const viewerIsOwner =
    users.data?.items.find((candidate) => candidate.id === session.data?.user.id)?.isOwner ?? false

  if (users.isPending) return <ListSkeleton />
  if (!user) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserX />
          </EmptyMedia>
          <EmptyTitle>User not found</EmptyTitle>
          <EmptyDescription>
            <Link to="/admin/users" {...transitionLinkProps('back')}>
              Back to all users
            </Link>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>{`${user.displayName} – Admin – DFS`}</title>
      <UserSummary user={user} usage={usage.data} viewerIsOwner={viewerIsOwner} />
      <MetadataBrowser user={user} folderId={folderId ?? user.rootFolderId} />
    </div>
  )
}

function UserSummary({
  user,
  usage,
  viewerIsOwner,
}: {
  user: AdminUser
  usage: UserUsage | undefined
  viewerIsOwner: boolean
}) {
  return (
    // One column that may shrink: a grid's default track would grow to the row's widest content.
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-3 border-b px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/admin/users" {...transitionLinkProps('back')} aria-label="All users">
            <ArrowLeft />
          </Link>
        </Button>
        <UserAvatar user={user} className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <span className="max-w-full truncate">{user.displayName}</span>
            {user.role === 'admin' && <Badge>Admin</Badge>}
            <UserBadges user={user} />
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            <span className="font-mono">{user.username}</span> · {formatBytes(user.usedBytes)} of{' '}
            {formatBytes(user.quotaBytes)}
            {usage &&
              ` · ${usage.fileCount.toLocaleString()} files in ${usage.folderCount.toLocaleString()} folders · ${formatBytes(usage.trashBytes)} in trash`}
          </p>
        </div>
        <UserSessions user={user} viewerIsOwner={viewerIsOwner} />
      </div>
      {usage ? <UsageBar usage={usage} /> : <Skeleton className="h-6 w-full" />}
    </div>
  )
}

/** Storage by kind of file, as a share of the quota. Grows in with a little bounce. */
function UsageBar({ usage }: { usage: UserUsage }) {
  const total = Math.max(usage.quotaBytes, usage.usedBytes, 1)
  return (
    <div className="grid gap-2">
      <div
        className="flex h-2 origin-left animate-[grow-x_580ms_var(--ease-bounce)_both] overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label="Storage by file type"
      >
        {usage.categories.map((entry) => (
          <span
            key={entry.category}
            className={CATEGORIES[entry.category].color}
            style={{ width: `${(entry.bytes / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {usage.categories.map((entry) => (
          <li key={entry.category} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', CATEGORIES[entry.category].color)} />
            {CATEGORIES[entry.category].label}
            <span className="tabular-nums">{formatBytes(entry.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function MetadataBrowser({ user, folderId }: { user: AdminUser; folderId: string }) {
  const path = useQuery(adminPathQuery(folderId))
  const children = useInfiniteQuery(adminChildrenQuery(folderId))
  const [removing, setRemoving] = useState<DriveNode | null>(null)
  const nodes = children.data?.pages.flatMap((page) => page.items) ?? []
  const folderUrl = (id: string) =>
    id === user.rootFolderId ? `/admin/users/${user.id}` : `/admin/users/${user.id}/folders/${id}`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b px-4 sm:px-5">
        <nav aria-label="Folder path" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-0.5 text-sm">
            {path.data?.map((entry, index) => (
              <Fragment key={entry.id}>
                {index > 0 && (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                )}
                <li className="min-w-0">
                  <Link
                    to={folderUrl(entry.id)}
                    {...transitionLinkProps('back')}
                    className={cn(
                      'block truncate rounded px-1.5 py-1 hover:bg-muted',
                      index === path.data.length - 1 ? 'font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {entry.name}
                  </Link>
                </li>
              </Fragment>
            )) ?? (
              <li>
                <Skeleton className="h-4 w-40" />
              </li>
            )}
          </ol>
        </nav>
        <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground @min-[34rem]:flex">
          <EyeOff className="size-3.5" aria-hidden /> Read-only: contents stay private
        </span>
      </div>

      {children.isPending ? (
        <ListSkeleton />
      ) : nodes.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">This folder is empty.</p>
      ) : (
        <VirtualList
          role="list"
          aria-label={`Contents of ${path.data?.at(-1)?.name ?? 'folder'}`}
          className="flex-1 py-1"
          items={nodes}
          getKey={(node) => node.id}
          itemHeight={ROW_HEIGHT}
          animateMoves
          onEndReached={
            children.hasNextPage && !children.isFetchingNextPage
              ? () => void children.fetchNextPage()
              : undefined
          }
          renderItem={(node) => (
            <MetadataRow
              node={node}
              folderUrl={folderUrl}
              onRemove={() => {
                setRemoving(node)
              }}
            />
          )}
        />
      )}
      {removing && (
        <ModerationDialog
          node={removing}
          ownerName={user.displayName}
          onClose={() => {
            setRemoving(null)
          }}
        />
      )}
    </div>
  )
}

function MetadataRow({
  node,
  folderUrl,
  onRemove,
}: {
  node: DriveNode
  folderUrl: (id: string) => string
  onRemove: () => void
}) {
  const name = (
    <span className="flex min-w-0 items-center gap-3">
      <NodeIcon node={node} className="size-5 shrink-0" />
      <span className="truncate" title={node.name}>
        {node.name}
      </span>
    </span>
  )
  return (
    <div
      role="listitem"
      className="group/row mx-2 grid h-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-4 rounded-md px-3 text-sm hover:bg-muted/60 @min-[34rem]:grid-cols-[minmax(0,1fr)_9.5rem_5.5rem_2rem_2rem]"
    >
      {node.kind === 'folder' ? (
        <Link
          to={folderUrl(node.id)}
          {...transitionLinkProps('forward')}
          className="min-w-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {name}
        </Link>
      ) : (
        name
      )}
      <span
        className="hidden truncate text-muted-foreground @min-[34rem]:block"
        title={formatFullDate(node.updatedAt)}
      >
        {formatDate(node.updatedAt)}
      </span>
      <span className="hidden text-right text-muted-foreground tabular-nums @min-[34rem]:block">
        {node.kind === 'folder' && node.sizeBytes === 0 ? '—' : formatBytes(node.sizeBytes)}
      </span>
      <span className="hidden justify-center @min-[34rem]:flex">
        {node.syncState && <SyncStatus state={node.syncState} />}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${node.name}`}
        title="Remove for moderation"
        className="text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-destructive focus-visible:opacity-100"
        onClick={onRemove}
      >
        <ShieldX />
      </Button>
    </div>
  )
}

interface FormState {
  error: string | null
}

/** Moderation trash (§7.2): the item goes to the owner's trash, with the reason. */
function ModerationDialog({
  node,
  ownerName,
  onClose,
}: {
  node: DriveNode
  ownerName: string
  onClose: () => void
}) {
  const moderate = useModerateNode()
  const links = useQuery(linksToDeleteQuery(node.id))
  const [state, submit, pending] = useActionState(
    async (_previous: FormState, formData: FormData): Promise<FormState> => {
      const reason = formText(formData, 'reason').trim()
      if (reason.length < 3) return { error: 'Give a reason; the owner will see it.' }
      try {
        const { deletedLinks } = await moderate.mutateAsync({ id: node.id, reason })
        toast.success(`Removed “${node.name}”`, {
          description:
            deletedLinks === 0
              ? `${ownerName} sees it in their trash, with your reason.`
              : `${ownerName} sees it in their trash, with your reason. ${linkCount(deletedLinks)} to it ${deletedLinks === 1 ? 'was' : 'were'} deleted.`,
        })
        onClose()
        return { error: null }
      } catch (error) {
        return { error: errorMessage(error) }
      }
    },
    { error: null },
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form action={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Remove “{node.name}”?</DialogTitle>
            <DialogDescription>
              It moves to {ownerName}’s trash
              {node.kind === 'folder' ? ' with everything in it' : ''}. They can see why, and it is
              logged in the audit log.
            </DialogDescription>
          </DialogHeader>
          {links.data !== undefined && links.data.links > 0 && (
            <LinkWarning>
              {linkCount(links.data.links)} to it
              {node.kind === 'folder' ? ' or what’s inside it' : ''} will be deleted:{' '}
              {links.data.links === 1 ? 'it stops' : 'they stop'} working now, and restoring it
              won’t bring {links.data.links === 1 ? 'it' : 'them'} back.
            </LinkWarning>
          )}
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <textarea
              id="reason"
              name="reason"
              rows={3}
              maxLength={500}
              required
              placeholder="e.g. Executable files are not allowed on this server."
              className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            {state.error && (
              <p
                role="alert"
                className="animate-in text-sm text-destructive fade-in-0 slide-in-from-top-1 motion-spring"
              >
                {state.error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending} pending={pending}>
              Remove
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
