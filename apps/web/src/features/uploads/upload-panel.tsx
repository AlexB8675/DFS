import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CloudUpload,
  Pause,
  Play,
  RotateCcw,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useStore } from 'zustand'
import { NodeIcon } from '@/components/node-icon'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { VirtualList } from '@/components/virtual-list'
import { formatBytes, formatCount, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { uploadEngine } from './upload-engine'
import {
  isSettled,
  useUploadStore,
  type UploadEntry,
  type UploadItem,
  type UploadSummary,
} from './upload-store'

const UPLOAD_ROW_HEIGHT = 52
/** How long "Cancel all" waits for the confirming second click. */
const CONFIRM_MS = 3000

/** A docked panel with the progress of every upload in this session. */
export function UploadPanel() {
  const items = useUploadStore((state) => state.items)
  const summary = useUploadStore((state) => state.summary)
  const bytesPerSecond = useUploadStore((state) => state.bytesPerSecond)
  const collapsed = useUploadStore((state) => state.collapsed)
  const setCollapsed = useUploadStore((state) => state.setCollapsed)

  if (items.length === 0) return null

  const pending = summary.active + summary.paused > 0

  return (
    <section
      aria-label="Uploads"
      className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] origin-bottom-right animate-in overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl fade-in-0 zoom-in-90 slide-in-from-bottom-4 motion-spring"
    >
      <header className="flex items-center gap-0.5 py-2 pr-2 pl-4">
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="truncate text-sm font-medium">{title(summary)}</p>
          <p className="truncate text-xs text-muted-foreground tabular-nums">
            {subtitle(summary, bytesPerSecond)}
          </p>
        </div>
        {summary.active > 0 && (
          <IconButton
            icon={Pause}
            label="Pause all"
            onClick={() => {
              uploadEngine.pauseAll()
            }}
          />
        )}
        {summary.active === 0 && summary.paused > 0 && (
          <IconButton
            icon={Play}
            label="Resume all"
            onClick={() => {
              uploadEngine.resumeAll()
            }}
          />
        )}
        <IconButton
          icon={ChevronDown}
          label={collapsed ? 'Show uploads' : 'Hide uploads'}
          aria-expanded={!collapsed}
          iconClassName={cn('transition-transform motion-spring', collapsed && 'rotate-180')}
          onClick={() => {
            setCollapsed(!collapsed)
          }}
        />
        {pending ? (
          <CancelAllButton />
        ) : (
          <IconButton
            icon={X}
            label="Close"
            onClick={() => {
              uploadEngine.clearFinished()
            }}
          />
        )}
      </header>
      {pending && (
        <Progress
          value={Math.round(summary.progress * 100)}
          aria-label="Total upload progress"
          className="h-1 rounded-none"
        />
      )}
      {/* Animating the grid track from 0fr to 1fr slides the list open and closed. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] motion-glide',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
        inert={collapsed}
      >
        <div className="overflow-hidden">
          {/* Virtualized: dropping a folder can queue thousands of files. */}
          <VirtualList
            role="list"
            aria-label="Upload queue"
            className="max-h-80 border-t"
            items={items}
            getKey={(item) => item.id}
            itemHeight={UPLOAD_ROW_HEIGHT}
            animateMoves
            renderItem={(entry) => <UploadRow entry={entry} />}
          />
        </div>
      </div>
    </section>
  )
}

function title(summary: UploadSummary): string {
  if (summary.active > 0) return `Uploading ${formatCount(summary.active, 'file')}`
  if (summary.paused > 0) return `${formatCount(summary.paused, 'upload')} paused`
  if (summary.failed > 0) return `${summary.done} uploaded, ${summary.failed} failed`
  if (summary.syncing > 0) return `Syncing ${formatCount(summary.syncing, 'file')} to Discord`
  return `${formatCount(summary.done, 'upload')} complete`
}

function subtitle(summary: UploadSummary, bytesPerSecond: number): string {
  const percent = `${Math.round(summary.progress * 100)}%`
  if (summary.active > 0) {
    // Nothing sent for a few seconds: before the first byte, or the server holding back.
    if (bytesPerSecond <= 0)
      return `${percent} · ${summary.progress > 0 ? 'waiting…' : 'starting…'}`
    const left = formatDuration(summary.remainingBytes / bytesPerSecond)
    return `${percent} · ${formatBytes(bytesPerSecond)}/s · ${left} left`
  }
  if (summary.paused > 0) return `${percent} · paused`
  if (summary.syncing > 0) return 'Uploaded; your files are on their way to Discord.'
  return 'Everything is stored on Discord.'
}

/** Asks for a second click before cancelling everything, right in place. */
function CancelAllButton() {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <IconButton
        icon={X}
        label="Cancel all uploads"
        onClick={() => {
          setConfirming(true)
          setTimeout(() => {
            setConfirming(false)
          }, CONFIRM_MS)
        }}
      />
    )
  }
  return (
    <Button
      variant="destructive"
      size="sm"
      className="animate-in fade-in-0 zoom-in-75 motion-bounce"
      onClick={() => {
        setConfirming(false)
        uploadEngine.cancelAll()
      }}
    >
      Cancel all?
    </Button>
  )
}

function UploadRow({ entry }: { entry: UploadEntry }) {
  const item = useStore(entry.store)
  return (
    <div role="listitem" className="group/row flex h-full items-center gap-3 pr-2 pl-4">
      <NodeIcon
        node={{ kind: 'file', name: item.file.name, mimeType: item.file.type || null }}
        className="size-5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={item.file.name}>
          {item.file.name}
        </p>
        <p
          className={cn(
            'truncate text-xs tabular-nums',
            item.status === 'failed' || item.syncState === 'failed' || item.syncState === 'lost'
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {statusText(item)}
        </p>
      </div>
      <UploadRowActions item={item} />
    </div>
  )
}

function UploadRowActions({ item }: { item: UploadItem }) {
  const name = item.file.name
  const pause = (
    <IconButton
      icon={Pause}
      label={`Pause ${name}`}
      onClick={() => {
        uploadEngine.pause(item.id)
      }}
    />
  )
  const cancel = (
    <IconButton
      icon={X}
      label={`Cancel ${name}`}
      onClick={() => {
        uploadEngine.cancel(item.id)
      }}
    />
  )

  switch (item.status) {
    case 'queued':
    case 'uploading':
      // The progress ring gives way to the buttons on hover or keyboard focus.
      return (
        <div className="relative flex items-center">
          <ProgressRing
            value={item.file.size === 0 ? 0 : item.uploadedBytes / item.file.size}
            waiting={item.status === 'queued' || item.retrying}
            className="absolute right-1.5 transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0"
          />
          <div className="flex opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
            {pause}
            {cancel}
          </div>
        </div>
      )
    case 'paused':
      return (
        <div className="flex">
          <IconButton
            icon={Play}
            label={`Resume ${name}`}
            onClick={() => {
              uploadEngine.resume(item.id)
            }}
          />
          {cancel}
        </div>
      )
    case 'failed':
      return (
        <div className="flex">
          <IconButton
            icon={RotateCcw}
            label={`Retry ${name}`}
            onClick={() => void uploadEngine.retry(item.id)}
          />
          {cancel}
        </div>
      )
    case 'done':
      if (item.syncState === 'stored') {
        return (
          <CircleCheck
            className="mx-1.5 size-4 animate-in text-emerald-500 zoom-in-0 motion-bounce"
            aria-label="Stored on Discord"
          />
        )
      }
      if (isSettled(item.syncState)) {
        return (
          <CircleAlert
            className="mx-1.5 size-4 animate-in text-destructive zoom-in-0 motion-bounce"
            aria-label="Could not store on Discord"
          />
        )
      }
      return (
        <CloudUpload
          className="mx-1.5 size-4 animate-pulse text-sky-500"
          aria-label="Syncing to Discord"
        />
      )
    case 'canceled':
      return null
  }
}

/** A small circular progress indicator; the arc glides as the bytes go. */
function ProgressRing({
  value,
  waiting,
  className,
}: {
  value: number
  waiting: boolean
  className?: string
}) {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  return (
    <svg viewBox="0 0 20 20" className={cn('size-5 -rotate-90', className)} aria-hidden>
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-muted" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - value)}
        className={cn(
          'stroke-primary transition-[stroke-dashoffset] motion-glide',
          waiting && 'animate-pulse',
        )}
      />
    </svg>
  )
}

interface IconButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  iconClassName?: string
  'aria-expanded'?: boolean
}

function IconButton({ icon: Icon, label, onClick, iconClassName, ...props }: IconButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={onClick}
      {...props}
    >
      <Icon className={iconClassName} />
    </Button>
  )
}

function statusText(item: UploadItem): string {
  const progress = `${formatBytes(item.uploadedBytes)} of ${formatBytes(item.file.size)}`
  switch (item.status) {
    case 'queued':
      return 'Waiting…'
    case 'uploading':
      return item.retrying ? `Connection trouble, retrying… · ${progress}` : progress
    case 'paused':
      return `Paused · ${progress}`
    case 'done':
      switch (item.syncState) {
        case 'stored':
          return `${formatBytes(item.file.size)} · on Discord`
        case 'failed':
        case 'lost':
          return 'Uploaded, but it couldn’t be stored on Discord'
        default:
          return 'Syncing to Discord…'
      }
    case 'failed':
      return item.error ?? 'Upload failed'
    case 'canceled':
      return 'Canceled'
  }
}
