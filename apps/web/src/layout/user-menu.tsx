import type { User } from '@dfs/shared'
import { LogOut, RotateCcw, Settings } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { signOut, useCurrentUser } from '@/features/auth/session'
import { apiSend, errorMessage } from '@/lib/api/client'
import { mocksEnabled } from '@/lib/env'
import { initials } from '@/lib/format'
import { transitionLinkProps } from '@/lib/navigation'

export function UserMenu() {
  const user = useCurrentUser()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
          <UserAvatar user={user} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex items-center gap-3 py-2 font-normal">
          <UserAvatar user={user} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground">{user.displayName}</span>
            <span className="block truncate font-mono text-xs">{user.username}</span>
            {user.role === 'admin' && (
              <Badge variant="secondary" className="mt-0.5">
                Admin
              </Badge>
            )}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings" {...transitionLinkProps('section')}>
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
        {mocksEnabled && (
          <DropdownMenuItem onSelect={() => void resetDemoData()}>
            <RotateCcw /> Reset demo data
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The user's initials in a circle. */
export function UserAvatar({ user, className }: { user: User; className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback className="bg-primary/20 font-medium text-primary">
        {initials(user.displayName)}
      </AvatarFallback>
    </Avatar>
  )
}

/** Mock mode only: restores the seeded demo drive. */
async function resetDemoData(): Promise<void> {
  try {
    await apiSend('POST', '/dev/reset')
    window.location.assign('/drive')
  } catch (error) {
    toast.error('Could not reset the demo data', { description: errorMessage(error) })
  }
}
