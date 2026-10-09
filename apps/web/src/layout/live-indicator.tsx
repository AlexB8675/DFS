import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLiveStatus, type LiveStatus } from '@/features/live-events/live-events'
import { cn } from '@/lib/utils'

const LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
}

const DESCRIPTIONS: Record<LiveStatus, string> = {
  connecting: 'Connecting to live updates…',
  live: 'Live: sync progress and changes show up as they happen.',
  reconnecting: 'The live connection dropped. Reconnecting; you will be caught up.',
  offline: 'You are offline. Changes show up once you are back.',
}

const DOT_COLORS: Record<LiveStatus, string> = {
  connecting: 'bg-muted-foreground/60',
  live: 'bg-emerald-500',
  reconnecting: 'bg-amber-500',
  offline: 'bg-rose-500',
}

/**
 * The state of the live connection: a quiet dot while it is up, which
 * ripples once when it connects, and a label when it is not, but on a
 * phone, where the dot's colour says it and the label would crowd search.
 */
export function LiveIndicator() {
  const status = useLiveStatus((state) => state.status)
  const troubled = status === 'reconnecting' || status === 'offline'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          aria-label={DESCRIPTIONS[status]}
          className="flex h-8 shrink-0 items-center gap-2 rounded-full px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Keyed by state, so the dot pops in again whenever the state changes. */}
          <span key={status} className="relative flex size-2 animate-in zoom-in-0 motion-bounce">
            {status === 'live' && (
              <span className="absolute inset-0 animate-[live-ripple_1s_var(--ease-glide)_both] rounded-full bg-emerald-500" />
            )}
            <span
              className={cn(
                'relative size-2 rounded-full',
                DOT_COLORS[status],
                status === 'reconnecting' && 'animate-pulse',
              )}
            />
          </span>
          {troubled && (
            <span className="animate-in fade-in-0 slide-in-from-right-2 motion-spring max-sm:hidden">
              {LABELS[status]}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{DESCRIPTIONS[status]}</TooltipContent>
    </Tooltip>
  )
}
