import { passwordSchema } from '@dfs/shared'
import { useMutation } from '@tanstack/react-query'
import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useRef, useState, type SubmitEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
import { PasswordInput } from '@/components/password-input'
import { PasswordRequirements } from '@/components/password-requirements'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { changePassword, signOut, useCurrentUser } from '@/features/auth/session'
import { UserAvatar } from '@/layout/user-menu'
import { errorMessage } from '@/lib/api/client'
import { appRelease } from '@/lib/env'
import { formatBytes, formatFullDate } from '@/lib/format'
import { shake } from '@/lib/motion'
import { useThemeStore, type Theme } from '@/lib/theme'

/** `/settings`: profile, password, appearance and storage. */
export function SettingsPage() {
  const user = useCurrentUser()
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const usedRatio = user.quotaBytes === 0 ? 1 : Math.min(1, user.usedBytes / user.quotaBytes)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>Settings – DFS</title>
      <PageHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-2xl gap-4 p-4 sm:p-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>An admin sets your name and username.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <UserAvatar user={user} className="size-14 text-lg" />
              <div className="grid gap-1">
                <p className="flex items-center gap-2 font-medium">
                  {user.displayName}
                  <Badge variant="secondary">{user.role === 'admin' ? 'Admin' : 'User'}</Badge>
                </p>
                <p className="font-mono text-xs text-muted-foreground">{user.username}</p>
              </div>
            </CardContent>
          </Card>

          <PasswordCard />

          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Dark is the default. System follows your device.</CardDescription>
            </CardHeader>
            <CardContent>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                value={theme}
                aria-label="Theme"
                onValueChange={(value) => {
                  if (value) setTheme(value as Theme)
                }}
              >
                <ThemeOption value="dark" icon={<Moon />} label="Dark" />
                <ThemeOption value="light" icon={<Sun />} label="Light" />
                <ThemeOption value="system" icon={<Monitor />} label="System" />
              </ToggleGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Storage</CardTitle>
              <CardDescription>
                Files in the trash count until they are deleted forever.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Progress value={usedRatio * 100} aria-label="Storage used" className="h-2" />
              <p className="text-sm">
                <span className="font-medium">{formatBytes(user.usedBytes)}</span>
                <span className="text-muted-foreground">
                  {' '}
                  of {formatBytes(user.quotaBytes)} used ({Math.round(usedRatio * 100)}%)
                </span>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Session</CardTitle>
              <CardDescription>Signing out ends your session in this browser.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void signOut()}>
                <LogOut /> Sign out
              </Button>
            </CardContent>
          </Card>

          <p className="text-center text-xs text-muted-foreground">
            {appRelease.version === 'dev'
              ? 'DFS, a development build'
              : `DFS ${appRelease.version}${appRelease.deployedAt ? `, deployed ${formatFullDate(appRelease.deployedAt)}` : ''}`}
          </p>
        </div>
      </div>
    </div>
  )
}

/** Changing the password needs the current one, and signs out every other session (§7.1). */
function PasswordCard() {
  const user = useCurrentUser()
  const change = useMutation({ mutationFn: changePassword })
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  function fail(message: string) {
    setError(message)
    shake(formRef.current)
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!current) {
      fail('Enter your current password.')
      return
    }
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) {
      fail(parsed.error.issues[0]?.message ?? 'Choose a longer password.')
      return
    }
    if (password !== confirmation) {
      fail('The two new passwords don’t match.')
      return
    }
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: parsed.data })
      setError(null)
      setCurrent('')
      setPassword('')
      setConfirmation('')
      toast.success('Password changed', {
        description: 'Your other devices were signed out.',
      })
    } catch (failure) {
      fail(errorMessage(failure))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs you out on your other devices.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          className="grid max-w-sm gap-4"
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
        >
          {/* Lets password managers save the new password under the right account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={user.username}
            readOnly
            hidden
          />
          <div className="grid gap-2">
            <Label htmlFor="current-password">Current password</Label>
            <PasswordInput
              id="current-password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => {
                setCurrent(event.target.value)
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-password">New password</Label>
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm-password">Type it again</Label>
            <PasswordInput
              id="confirm-password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value)
              }}
            />
          </div>
          {password && <PasswordRequirements password={password} confirmation={confirmation} />}
          {error && (
            <p
              role="alert"
              className="animate-in text-sm text-destructive fade-in-0 slide-in-from-top-1 motion-spring"
            >
              {error}
            </p>
          )}
          <div>
            <Button type="submit" disabled={change.isPending}>
              {change.isPending && <Spinner />} Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ThemeOption({ value, icon, label }: { value: Theme; icon: ReactNode; label: string }) {
  return (
    <ToggleGroupItem value={value} className="gap-2 px-4">
      {icon} {label}
    </ToggleGroupItem>
  )
}
