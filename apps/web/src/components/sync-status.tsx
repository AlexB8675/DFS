import type { SyncState } from '@dfs/shared'
import {
  CloudCheck,
  CloudOff,
  CloudUpload,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const SYNC_STATES: Record<SyncState, { icon: LucideIcon; label: string; className: string }> = {
  uploading: {
    icon: LoaderCircle,
    label: 'Uploading',
    className: 'animate-spin text-muted-foreground',
  },
  syncing: {
    icon: CloudUpload,
    label: 'Syncing to Discord. You can already open it.',
    className: 'animate-pulse text-sky-500',
  },
  stored: {
    icon: CloudCheck,
    label: 'Stored in Discord',
    className: 'text-muted-foreground/70',
  },
  failed: {
    icon: CloudOff,
    label: 'Upload failed. Upload the file again.',
    className: 'text-amber-500',
  },
  lost: {
    icon: TriangleAlert,
    label: 'Lost: the copy in Discord is missing or damaged.',
    className: 'text-destructive',
  },
}

/** An icon for where a file's bytes are (§5.2), explained in a tooltip. */
export function SyncStatus({ state, className }: { state: SyncState; className?: string }) {
  const { icon: Icon, label, className: color } = SYNC_STATES[state]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)} aria-label={label}>
          <Icon className={cn('size-4', color)} aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
