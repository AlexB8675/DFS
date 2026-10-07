import type { AdminUser } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { FolderSearch, KeyRound, Pencil, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ListSkeleton } from '@/components/list-skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useCurrentUser } from '@/features/auth/session'
import { UserAvatar } from '@/layout/user-menu'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { transitionLinkProps } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { adminUsersQuery } from './api'
import { UserBadges } from './user-badges'
import { AddUserDialog, EditUserDialog, ResetPasswordDialog } from './user-dialogs'

type OpenDialog =
  { kind: 'add' } | { kind: 'edit'; user: AdminUser } | { kind: 'reset'; user: AdminUser }

/** `/admin/users`: everyone with an account, their storage, and their quotas. */
export function UsersPage() {
  const users = useQuery(adminUsersQuery)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const close = () => {
    setDialog(null)
  }

  if (!users.data) return <ListSkeleton />
  const waiting = users.data.items.filter((user) => user.activatedAt === null).length
  const asking = users.data.items.filter(
    (user) => user.passwordResetRequestedAt !== null && !user.disabled,
  ).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-2.5">
        <p className="text-sm text-muted-foreground">
          {users.data.items.length.toLocaleString()} users
          {waiting > 0 && ` · ${waiting.toLocaleString()} not signed in yet`}
          {asking > 0 && ` · ${asking.toLocaleString()} asked for a new password`}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setDialog({ kind: 'add' })
          }}
        >
          <UserPlus /> Add user
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
            <tr className="border-b text-left">
              <th className="py-2 pl-5 font-medium">User</th>
              <th className="hidden w-24 py-2 pl-4 font-medium sm:table-cell">Role</th>
              <th className="hidden w-56 py-2 pl-4 font-medium md:table-cell">Storage</th>
              <th className="hidden w-24 py-2 pl-4 text-right font-medium lg:table-cell">Files</th>
              <th className="hidden w-32 py-2 pl-4 font-medium lg:table-cell">Last seen</th>
              <th className="w-32 py-2 pr-5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.data.items.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                onEdit={() => {
                  setDialog({ kind: 'edit', user })
                }}
                onReset={() => {
                  setDialog({ kind: 'reset', user })
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'add' && <AddUserDialog onClose={close} />}
      {dialog?.kind === 'edit' && <EditUserDialog user={dialog.user} onClose={close} />}
      {dialog?.kind === 'reset' && <ResetPasswordDialog user={dialog.user} onClose={close} />}
    </div>
  )
}

function UserRow({
  user,
  onEdit,
  onReset,
}: {
  user: AdminUser
  onEdit: () => void
  onReset: () => void
}) {
  const me = useCurrentUser()
  const ratio = user.quotaBytes === 0 ? 1 : Math.min(1, user.usedBytes / user.quotaBytes)
  let resetBlocked: string | null = null
  if (user.isOwner) resetBlocked = 'The owner’s password can only be reset on the server'
  else if (user.id === me.id) resetBlocked = 'Change your own password in Settings'

  return (
    <tr
      className={cn('border-b border-border/50 hover:bg-muted/40', user.disabled && 'opacity-60')}
    >
      <td className="py-2.5 pl-5">
        <Link
          to={`/admin/users/${user.id}`}
          {...transitionLinkProps('forward')}
          className="flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UserAvatar user={user} className="size-8" />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{user.displayName}</span>
              <UserBadges user={user} />
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {user.username}
            </span>
          </span>
        </Link>
      </td>
      <td className="hidden py-2.5 pl-4 sm:table-cell">
        <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
          {user.role === 'admin' ? 'Admin' : 'User'}
        </Badge>
      </td>
      <td className="hidden py-2.5 pl-4 md:table-cell">
        <Progress
          value={ratio * 100}
          aria-label={`Storage used by ${user.displayName}`}
          className={cn(
            'h-1.5',
            ratio > 0.9 && '[&_[data-slot=progress-indicator]]:bg-destructive',
          )}
        />
        <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
          {formatBytes(user.usedBytes)} of {formatBytes(user.quotaBytes)}
        </span>
      </td>
      <td className="hidden py-2.5 pl-4 text-right text-muted-foreground tabular-nums lg:table-cell">
        {user.fileCount.toLocaleString()}
      </td>
      <td
        className="hidden truncate py-2.5 pl-4 text-muted-foreground lg:table-cell"
        title={user.lastSeenAt ? formatFullDate(user.lastSeenAt) : undefined}
      >
        {user.lastSeenAt ? formatDate(user.lastSeenAt) : 'Never'}
      </td>
      <td className="py-2.5 pr-5">
        <span className="flex justify-end gap-1">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link
              to={`/admin/users/${user.id}`}
              {...transitionLinkProps('forward')}
              aria-label={`Browse ${user.displayName}’s files`}
              title="Browse files"
            >
              <FolderSearch />
            </Link>
          </Button>
          {/* A span carries the tooltip, since a disabled button gets no hover. */}
          <span title={resetBlocked ?? 'Reset password'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Reset ${user.displayName}’s password`}
              disabled={resetBlocked !== null}
              onClick={onReset}
            >
              <KeyRound />
            </Button>
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${user.displayName}`}
            title="Edit"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        </span>
      </td>
    </tr>
  )
}
