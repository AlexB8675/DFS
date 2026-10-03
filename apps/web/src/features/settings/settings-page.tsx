import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { signOut, useCurrentUser } from '@/features/auth/session'
import { UserAvatar } from '@/layout/user-menu'
import { formatBytes } from '@/lib/format'
import { useThemeStore, type Theme } from '@/lib/theme'

/** `/settings`: profile, appearance and storage. */
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
              <CardDescription>
                Your name and picture come from Discord and update when you sign in.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <UserAvatar user={user} className="size-14 text-lg" />
              <div className="grid gap-1">
                <p className="flex items-center gap-2 font-medium">
                  {user.displayName}
                  <Badge variant="secondary">{user.role === 'admin' ? 'Admin' : 'User'}</Badge>
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  Discord ID {user.discordUserId}
                </p>
              </div>
            </CardContent>
          </Card>

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
        </div>
      </div>
    </div>
  )
}

function ThemeOption({ value, icon, label }: { value: Theme; icon: ReactNode; label: string }) {
  return (
    <ToggleGroupItem value={value} className="gap-2 px-4">
      {icon} {label}
    </ToggleGroupItem>
  )
}
