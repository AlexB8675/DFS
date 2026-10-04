import { Cloud } from 'lucide-react'
import { Link } from 'react-router'
import { Progress } from '@/components/ui/progress'
import { useCurrentUser } from '@/features/auth/session'
import { formatBytes } from '@/lib/format'
import { transitionLinkProps } from '@/lib/navigation'
import { cn } from '@/lib/utils'

/** Storage used against the user's quota (§5.1). */
export function QuotaMeter({ onNavigate }: { onNavigate?: () => void }) {
  const { usedBytes, quotaBytes } = useCurrentUser()
  const ratio = quotaBytes === 0 ? 1 : Math.min(1, usedBytes / quotaBytes)

  return (
    <Link
      to="/settings"
      {...transitionLinkProps('section')}
      className="block rounded-md p-2 transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      onClick={onNavigate}
    >
      <span className="mb-2 flex items-center gap-2 text-sm">
        <Cloud className="size-4 text-muted-foreground" aria-hidden /> Storage
      </span>
      <Progress
        value={ratio * 100}
        aria-label="Storage used"
        className={cn(ratio > 0.9 && '[&_[data-slot=progress-indicator]]:bg-destructive')}
      />
      <span className="mt-2 block text-xs text-muted-foreground">
        {formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used
      </span>
    </Link>
  )
}
