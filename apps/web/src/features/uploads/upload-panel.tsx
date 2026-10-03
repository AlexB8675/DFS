import { ChevronDown, CircleCheck, RotateCcw, X } from 'lucide-react'
import { NodeIcon } from '@/components/node-icon'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { VirtualList } from '@/components/virtual-list'
import { formatBytes, formatCount } from '@/lib/format'
import { cn } from '@/lib/utils'
import { cancelUpload, retryUpload } from './upload-engine'
import { summarize, useUploadStore, type UploadItem } from './upload-store'

const UPLOAD_ROW_HEIGHT = 48

/** A docked panel with the progress of every upload in this session. */
export function UploadPanel() {
  const items = useUploadStore((state) => state.items)
  const collapsed = useUploadStore((state) => state.collapsed)
  const setCollapsed = useUploadStore((state) => state.setCollapsed)
  const clearFinished = useUploadStore((state) => state.clearFinished)

  if (items.length === 0) return null

  const summary = summarize(items)
  const percent = Math.round(summary.progress * 100)
  const title =
    summary.active > 0
      ? `Uploading ${formatCount(summary.active, 'file')}`
      : summary.failed > 0
        ? `${summary.done} uploaded, ${summary.failed} failed`
        : `${formatCount(summary.done, 'upload')} complete`

  return (
    <section
      aria-label="Uploads"
      className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] animate-in overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl duration-300 ease-smooth fade-in-0 slide-in-from-bottom-4"
    >
      <header className="flex items-center gap-1 py-2 pr-2 pl-4">
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="truncate text-sm font-medium">{title}</p>
          {summary.active > 0 && (
            <p className="text-xs text-muted-foreground">{percent}% · then syncing to Discord</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? 'Show uploads' : 'Hide uploads'}
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed(!collapsed)
          }}
        >
          <ChevronDown
            className={cn('transition-transform duration-200', collapsed && 'rotate-180')}
          />
        </Button>
        {summary.active === 0 && (
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={clearFinished}>
            <X />
          </Button>
        )}
      </header>
      {summary.active > 0 && (
        <Progress value={percent} aria-label="Total upload progress" className="rounded-none" />
      )}
      {/* Animating the grid track from 0fr to 1fr slides the list open and closed. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-300',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
        inert={collapsed}
      >
        <div className="overflow-hidden">
          {/* Virtualized: dropping a folder can queue thousands of files. */}
          <VirtualList
            role="list"
            aria-label="Upload queue"
            className="max-h-72 border-t"
            items={items}
            getKey={(item) => item.id}
            itemHeight={UPLOAD_ROW_HEIGHT}
            renderItem={(item) => <UploadRow item={item} />}
          />
        </div>
      </div>
    </section>
  )
}

function UploadRow({ item }: { item: UploadItem }) {
  return (
    <div role="listitem" className="flex h-full items-center gap-3 pr-2 pl-4">
      <NodeIcon
        node={{ kind: 'file', name: item.file.name, mimeType: item.file.type || null }}
        className="size-5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={item.file.name}>
          {item.file.name}
        </p>
        <p
          className={
            item.status === 'failed'
              ? 'truncate text-xs text-destructive'
              : 'truncate text-xs text-muted-foreground'
          }
        >
          {statusText(item)}
        </p>
      </div>
      <UploadRowAction item={item} />
    </div>
  )
}

function UploadRowAction({ item }: { item: UploadItem }) {
  switch (item.status) {
    case 'queued':
    case 'uploading':
      return (
        <span className="group relative flex size-7 items-center justify-center">
          {item.status === 'uploading' && <Spinner className="group-hover:invisible" />}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Cancel upload of ${item.file.name}`}
            className={
              item.status === 'uploading'
                ? 'absolute opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                : undefined
            }
            onClick={() => {
              cancelUpload(item.id)
            }}
          >
            <X />
          </Button>
        </span>
      )
    case 'done':
      return <CircleCheck className="mx-1.5 size-4 text-emerald-500" aria-label="Uploaded" />
    case 'failed':
      return (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Retry upload of ${item.file.name}`}
          onClick={() => {
            retryUpload(item.id)
          }}
        >
          <RotateCcw />
        </Button>
      )
    case 'canceled':
      return null
  }
}

function statusText(item: UploadItem): string {
  switch (item.status) {
    case 'queued':
      return 'Waiting…'
    case 'uploading':
      return `${formatBytes(item.uploadedBytes)} of ${formatBytes(item.file.size)}`
    case 'done':
      return `${formatBytes(item.file.size)} · uploaded`
    case 'failed':
      return item.error ?? 'Upload failed'
    case 'canceled':
      return 'Canceled'
  }
}
