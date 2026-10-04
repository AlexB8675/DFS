import { createUserSchema, resetPasswordSchema, type AdminUser, type Role } from '@dfs/shared'
import { Check, Copy, RefreshCw, ShieldAlert, UserCheck } from 'lucide-react'
import { useActionState, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
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
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useCurrentUser } from '@/features/auth/session'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatFullDate } from '@/lib/format'
import { generatePassword } from '@/lib/password'
import { useCreateUser, useResetPassword, useUpdateUser } from './api'

const GB = 1024 ** 3
/** `DEFAULT_QUOTA_BYTES` (§15), as the form's starting value. */
const DEFAULT_QUOTA_GB = 100

// The fields are controlled: React resets a form after its action, also
// when the action only reports an error, which would clear what was typed.

interface FormState {
  error: string | null
}

/** Sign-in details to hand over: shown once, since only the API's hash remains. */
interface Handover {
  user: AdminUser
  password: string
}

// ── Add a user ───────────────────────────────────────────────────────────────

/**
 * Makes an account with a temporary password (D27). Once it exists, the
 * dialog shows the sign-in details to pass on; they aren't shown again.
 */
export function AddUserDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateUser()
  const [password, setPassword] = useState(generatePassword)
  const [role, setRole] = useState<Role>('user')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [quota, setQuota] = useState(String(DEFAULT_QUOTA_GB))
  const [handover, setHandover] = useState<Handover | null>(null)

  const [state, submit, pending] = useActionState(
    async (_previous: FormState): Promise<FormState> => {
      const quotaGb = Number(quota)
      if (!quota || !Number.isFinite(quotaGb) || quotaGb < 0) {
        return { error: 'Enter a quota in GB.' }
      }
      const input = createUserSchema.safeParse({
        username,
        displayName: displayName.trim() || undefined,
        temporaryPassword: password,
        quotaBytes: Math.round(quotaGb * GB),
        role,
      })
      if (!input.success) return { error: input.error.issues[0]?.message ?? 'Check the form.' }
      try {
        const user = await create.mutateAsync(input.data)
        setHandover({ user, password })
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
        {handover ? (
          <SignInDetails
            {...handover}
            title={`${handover.user.displayName} can sign in now`}
            onDone={onClose}
          />
        ) : (
          <form action={submit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Add a user</DialogTitle>
              <DialogDescription>
                They sign in with this username and a temporary password, then choose their own.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <Label htmlFor="new-username">Username</Label>
              <Input
                id="new-username"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                placeholder="sam"
                className="font-mono"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value)
                }}
              />
              <p className="text-xs text-muted-foreground">
                Letters, digits, dots, dashes and underscores. Capital letters don’t matter.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="new-display-name">Name</Label>
              <Input
                id="new-display-name"
                autoComplete="off"
                placeholder={username.trim() || 'Sam Rivera'}
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value)
                }}
              />
            </div>

            <TemporaryPasswordField value={password} onChange={setPassword} />

            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              <QuotaField value={quota} onChange={setQuota} />
              <RoleField value={role} onChange={setRole} />
            </div>

            <FormError message={state.error} />

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />} Add user
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Reset a password ─────────────────────────────────────────────────────────

/** Gives a user a new temporary password, which signs them out everywhere (§7.1). */
export function ResetPasswordDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const reset = useResetPassword()
  const [password, setPassword] = useState(generatePassword)
  const [handover, setHandover] = useState<Handover | null>(null)

  const [state, submit, pending] = useActionState(
    async (_previous: FormState): Promise<FormState> => {
      const input = resetPasswordSchema.safeParse({ temporaryPassword: password })
      if (!input.success) return { error: input.error.issues[0]?.message ?? 'Check the password.' }
      try {
        const updated = await reset.mutateAsync({ id: user.id, ...input.data })
        setHandover({ user: updated, password })
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
        {handover ? (
          <SignInDetails
            {...handover}
            title={`New sign-in details for ${user.displayName}`}
            onDone={onClose}
          />
        ) : (
          <form action={submit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Reset {user.displayName}’s password</DialogTitle>
              <DialogDescription>
                This signs them out everywhere. They choose a new password when they next sign in.
              </DialogDescription>
            </DialogHeader>
            <TemporaryPasswordField value={password} onChange={setPassword} autoFocus />
            <FormError message={state.error} />
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />} Reset password
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Edit a user ──────────────────────────────────────────────────────────────

/** Name, quota, role and access. The owner stays an admin and can't be disabled (D28). */
export function EditUserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const me = useCurrentUser()
  const update = useUpdateUser()
  const [displayName, setDisplayName] = useState(user.displayName)
  const [quota, setQuota] = useState(String(Math.round((user.quotaBytes / GB) * 10) / 10))
  const [role, setRole] = useState<Role>(user.role)
  const [disabled, setDisabled] = useState(user.disabled)
  const isMe = user.id === me.id
  const locked = isMe || user.isOwner

  const [state, submit, pending] = useActionState(
    async (_previous: FormState): Promise<FormState> => {
      const quotaGb = Number(quota)
      if (!quota || !Number.isFinite(quotaGb) || quotaGb < 0) {
        return { error: 'Enter a quota in GB.' }
      }
      const name = displayName.trim()
      if (!name) return { error: 'Enter a name.' }
      try {
        await update.mutateAsync({
          id: user.id,
          changes: {
            displayName: name,
            quotaBytes: Math.round(quotaGb * GB),
            ...(locked ? {} : { role, disabled }),
          },
        })
        toast.success(`Saved ${name}`)
        onClose()
        return { error: null }
      } catch (error) {
        return { error: errorMessage(error) }
      }
    },
    { error: null },
  )

  let lockReason: string | null = null
  if (user.isOwner) lockReason = 'The owner is always an admin and can’t be disabled.'
  else if (isMe) lockReason = 'You can’t demote or disable your own account.'

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
              <span className="font-mono">{user.username}</span> · uses{' '}
              {formatBytes(user.usedBytes)} across {user.fileCount.toLocaleString()} files.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="display-name">Name</Label>
            <Input
              id="display-name"
              autoComplete="off"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value)
              }}
            />
          </div>

          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            <QuotaField value={quota} onChange={setQuota} />
            <RoleField value={role} onChange={setRole} disabled={locked} />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Label htmlFor="disabled">Disable account</Label>
              <p className="text-xs text-muted-foreground">
                {lockReason ?? 'Signs them out and blocks sign-in. Their files are kept.'}
              </p>
            </div>
            <Switch
              id="disabled"
              checked={disabled}
              disabled={locked}
              onCheckedChange={setDisabled}
            />
          </div>

          <FormError message={state.error} />

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

// ── Parts ────────────────────────────────────────────────────────────────────

/** The temporary password: a generated one to start with, which the admin may replace. */
function TemporaryPasswordField({
  value,
  onChange,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  // Bumped per click, so the icon spins once each time.
  const [spins, setSpins] = useState(0)
  return (
    <div className="grid gap-2">
      <Label htmlFor="temporary-password">Temporary password</Label>
      <div className="flex gap-2">
        <Input
          id="temporary-password"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="font-mono"
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
        <Button
          type="button"
          variant="outline"
          aria-label="Generate another password"
          title="Generate another"
          onClick={() => {
            onChange(generatePassword())
            setSpins((count) => count + 1)
          }}
        >
          <RefreshCw
            className="transition-transform duration-[580ms] ease-bounce"
            style={{ transform: `rotate(${String(spins * 180)}deg)` }}
          />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        It works for 7 days, and only until they choose their own.
      </p>
    </div>
  )
}

function QuotaField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="quota">Quota</Label>
      <div className="flex items-center gap-2">
        <Input
          id="quota"
          type="number"
          min={0}
          step="any"
          className="w-28 tabular-nums"
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
        <span className="text-sm text-muted-foreground">GB</span>
      </div>
    </div>
  )
}

function RoleField({
  value,
  onChange,
  disabled,
}: {
  value: Role
  onChange: (role: Role) => void
  disabled?: boolean
}) {
  return (
    <div className="grid gap-2">
      <Label>Role</Label>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={value}
        disabled={disabled}
        aria-label="Role"
        onValueChange={(next) => {
          if (next === 'admin' || next === 'user') onChange(next)
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
  )
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="animate-in text-sm text-destructive fade-in-0 slide-in-from-top-1 motion-spring"
    >
      {message}
    </p>
  )
}

/** The sign-in details to pass on, with one button to copy them all. */
function SignInDetails({
  user,
  password,
  title,
  onDone,
}: Handover & { title: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const address = `${window.location.origin}/login`
  const until = user.temporaryPasswordExpiresAt
    ? formatFullDate(user.temporaryPasswordExpiresAt)
    : null
  const text = [
    `Sign in to DFS at ${address}`,
    `Username: ${user.username}`,
    `Temporary password: ${password}`,
    `You’ll choose your own password when you sign in.${until ? ` This one works until ${until}.` : ''}`,
  ].join('\n')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success('Sign-in details copied')
    } catch {
      toast.error('Could not copy. Select the details and copy them manually.')
    }
  }

  return (
    <div className="grid animate-in gap-5 fade-in-0 zoom-in-95 motion-spring">
      <DialogHeader className="items-center text-center">
        <span className="mb-1 flex size-12 animate-in items-center justify-center rounded-full bg-emerald-500/15 zoom-in-50 motion-bounce">
          <UserCheck className="size-5 text-emerald-500" aria-hidden />
        </span>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>Send them these details.</DialogDescription>
      </DialogHeader>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
        <Detail term="Address">{address}</Detail>
        <Detail term="Username">{user.username}</Detail>
        <Detail term="Password">{password}</Detail>
        {until && (
          <>
            <dt className="text-muted-foreground">Works until</dt>
            <dd>{until}</dd>
          </>
        )}
      </dl>

      <p className="flex gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        Copy them now. DFS keeps only a fingerprint of the password, so it can’t show it again.
      </p>

      <DialogFooter>
        <Button variant="outline" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy details'}
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  )
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="truncate font-mono select-all">{children}</dd>
    </>
  )
}
