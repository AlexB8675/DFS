import type { AdminUser, Role } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { FolderSearch, Pencil } from 'lucide-react'
import { useActionState, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ListSkeleton } from '@/components/list-skeleton'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useCurrentUser } from '@/features/auth/session'
import { UserAvatar } from '@/layout/user-menu'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { formText } from '@/lib/form-data'
import { transitionLinkProps } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { adminUsersQuery, useUpdateUser } from './api'

const GB = 1024 ** 3

/** `/admin/users`: everyone with access, their storage, and their quotas. */
export function UsersPage() {
  const users = useQuery(adminUsersQuery)
  const [editing, setEditing] = useState<AdminUser | null>(null)

  if (!users.data) return <ListSkeleton />

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <table className="w-full table-fixed text-sm">
        <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
          <tr className="border-b text-left">
            <th className="py-2 pl-5 font-medium">User</th>
            <th className="hidden w-24 py-2 pl-4 font-medium sm:table-cell">Role</th>
            <th className="hidden w-56 py-2 pl-4 font-medium md:table-cell">Storage</th>
            <th className="hidden w-24 py-2 pl-4 text-right font-medium lg:table-cell">Files</th>
            <th className="hidden w-32 py-2 pl-4 font-medium lg:table-cell">Last seen</th>
            <th className="w-24 py-2 pr-5">
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
                setEditing(user)
              }}
            />
          ))}
        </tbody>
      </table>
      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function UserRow({ user, onEdit }: { user: AdminUser; onEdit: () => void }) {
  const ratio = user.quotaBytes === 0 ? 1 : Math.min(1, user.usedBytes / user.quotaBytes)
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
              {user.disabled && <Badge variant="outline">Disabled</Badge>}
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {user.discordUserId}
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

interface FormState {
  error: string | null
}

function EditUserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const me = useCurrentUser()
  const update = useUpdateUser()
  const [role, setRole] = useState<Role>(user.role)
  const [disabled, setDisabled] = useState(user.disabled)
  const isMe = user.id === me.id

  const [state, submit, pending] = useActionState(
    async (_previous: FormState, formData: FormData): Promise<FormState> => {
      const quotaGb = Number(formText(formData, 'quota'))
      if (!Number.isFinite(quotaGb) || quotaGb < 0) return { error: 'Enter a quota in GB.' }
      try {
        await update.mutateAsync({
          id: user.id,
          changes: { quotaBytes: Math.round(quotaGb * GB), role, disabled },
        })
        toast.success(`Saved ${user.displayName}`)
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
        <form action={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Edit {user.displayName}</DialogTitle>
            <DialogDescription>
              Uses {formatBytes(user.usedBytes)} across {user.fileCount.toLocaleString()} files.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="quota">Quota</Label>
            <div className="flex items-center gap-2">
              <Input
                id="quota"
                name="quota"
                type="number"
                min={0}
                step="any"
                defaultValue={Math.round((user.quotaBytes / GB) * 10) / 10}
                className="w-32 tabular-nums"
              />
              <span className="text-sm text-muted-foreground">GB</span>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Role</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={role}
              disabled={isMe}
              aria-label="Role"
              onValueChange={(value) => {
                if (value === 'admin' || value === 'user') setRole(value)
              }}
            >
              <ToggleGroupItem value="user" className="px-4">
                User
              </ToggleGroupItem>
              <ToggleGroupItem value="admin" className="px-4">
                Admin
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Label htmlFor="disabled">Disable account</Label>
              <p className="text-xs text-muted-foreground">
                {isMe
                  ? 'You can’t disable your own account.'
                  : 'Signs them out and blocks sign-in. Their files are kept.'}
              </p>
            </div>
            <Switch
              id="disabled"
              checked={disabled}
              disabled={isMe}
              onCheckedChange={setDisabled}
            />
          </div>

          {state.error && (
            <p
              role="alert"
              className="animate-in text-sm text-destructive fade-in-0 slide-in-from-top-1 motion-spring"
            >
              {state.error}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
