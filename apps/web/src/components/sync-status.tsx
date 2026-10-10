import type { SyncState } from '@dfs/shared'
import { CloudCheck, CloudOff, CloudUpload, LoaderCircle, type LucideIcon } from 'lucide-react'
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
    className: 'animate-pulse text-sky-600 dark:text-sky-500',
  },
  stored: {
    icon: CloudCheck,
    label: 'Stored in Discord',
    className: 'text-muted-foreground/70',
  },
  failed: {
    icon: CloudOff,
    label: 'Upload failed. Upload the file again.',
    className: 'text-amber-700 dark:text-amber-500',
  },
}

/**
 * An icon for where a file's bytes are (§5.2). It explains itself with a
 * native tooltip rather than a Radix one: it appears in every list row, and
 * rows mount constantly while scrolling.
 */
export function SyncStatus({ state, className }: { state: SyncState; className?: string }) {
  const { icon: Icon, label, className: color } = SYNC_STATES[state]
  return (
    <span className={cn('inline-flex', className)} role="img" aria-label={label} title={label}>
      <Icon className={cn('size-4', color)} aria-hidden />
    </span>
  )
}
