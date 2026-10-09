import { ChevronLeft, ChevronRight, Download, Info, Share2, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { NodeIcon } from '@/components/node-icon'
import { SyncStatus } from '@/components/sync-status'
import { MediaDetails } from '@/features/player/media-details'
import { fileCategory, fileCategoryLabel } from '@/lib/file-types'
import { formatBytes, formatFullDate } from '@/lib/format'
import { previewKind } from '@/lib/preview-kind'
import { cn } from '@/lib/utils'
import { handlePreviewKey } from './keys'
import { PreviewBody, type ViewedFile } from './preview-body'
import type { ViewHandle } from './view-handle'

interface FileViewerProps {
  open: boolean
  /** `null` while it loads, or when it can't be shown (`error`). */
  file: ViewedFile | null
  error: { title: string; description: string } | null
  /** Where its bytes are, as an API path (`/files/:id/content`). */
  contentPath: string | null
  /** The previewable files around it in the list it was opened from. */
  previous: (() => void) | null
  next: (() => void) | null
  /** Its place among them, when the whole list has loaded. */
  position: { index: number; total: number } | null
  /**
   * Another dialog is open over it (Share). Opened from code, it has no
   * button to give the focus back to, so the viewer takes it back.
   */
  covered?: boolean
  onClose: () => void
  onDownload: () => void
  onShare?: () => void
}

/**
 * The full-screen viewer (§10.3): the file, with its name, Download, Share
 * and Details above it; ← and → (or a swipe) move through the list's
 * previewable files, Esc closes it, and + − 0 zoom.
 */
export function FileViewer({
  open,
  file,
  error,
  contentPath,
  previous,
  next,
  position,
  covered = false,
  onClose,
  onDownload,
  onShare,
}: FileViewerProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  /** What had the focus before it opened (the list), to give it back. */
  const opener = useRef<Element | null>(null)
  const view = useRef<ViewHandle>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    if (open && !covered) contentRef.current?.focus()
  }, [open, covered])

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={contentRef}
          aria-describedby={undefined}
          // Dark whatever the theme, as photos look best on it.
          className="dark fixed inset-0 z-50 flex flex-col bg-neutral-950 text-foreground outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          onOpenAutoFocus={(event) => {
            // The viewer itself, so the keys work and the close button shows no ring.
            event.preventDefault()
            opener.current = document.activeElement
            contentRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            // Opened from the list, not from a trigger: back to the list.
            event.preventDefault()
            if (opener.current instanceof HTMLElement && opener.current.isConnected)
              opener.current.focus()
          }}
          onEscapeKeyDown={(event) => {
            // What is open inside closes first: the text's search, then Details.
            if (view.current?.dismiss?.()) {
              event.preventDefault()
              contentRef.current?.focus()
            } else if (detailsOpen) {
              event.preventDefault()
              setDetailsOpen(false)
            }
          }}
          onKeyDown={(event) => {
            handlePreviewKey(event, view.current, previous, next)
          }}
        >
          <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:gap-2 sm:px-3">
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
            {file && <NodeIcon node={{ ...file, kind: 'file' }} className="size-4 shrink-0" />}
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-medium">
              {file?.name ?? ''}
            </DialogPrimitive.Title>
            {position && (
              <span className="px-1 text-xs text-muted-foreground tabular-nums max-sm:hidden">
                {position.index + 1} / {position.total}
              </span>
            )}
            {/* On a phone, where the side arrows would cover the file. */}
            {(previous ?? next) && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="sm:hidden"
                  aria-label="Previous file"
                  disabled={!previous}
                  onClick={() => previous?.()}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="sm:hidden"
                  aria-label="Next file"
                  disabled={!next}
                  onClick={() => next?.()}
                >
                  <ChevronRight />
                </Button>
              </>
            )}
            {file && (
              <Button variant="ghost" size="icon" aria-label="Download" onClick={onDownload}>
                <Download />
              </Button>
            )}
            {file && onShare && (
              <Button variant="ghost" size="icon" aria-label="Share link" onClick={onShare}>
                <Share2 />
              </Button>
            )}
            {file && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Details"
                aria-expanded={detailsOpen}
                onClick={() => {
                  setDetailsOpen(!detailsOpen)
                }}
              >
                <Info />
              </Button>
            )}
          </header>
          <div className="relative min-h-0 flex-1">
            <PreviewBody
              file={file}
              error={error}
              contentPath={contentPath}
              view={view}
              previous={previous}
              next={next}
              onDownload={onDownload}
            />
            {previous && (
              <StepButton side="left" label="Previous file" onClick={previous}>
                <ChevronLeft />
              </StepButton>
            )}
            {next && (
              <StepButton side="right" label="Next file" onClick={next}>
                <ChevronRight />
              </StepButton>
            )}
            {detailsOpen && file && (
              <Details
                file={file}
                media={
                  contentPath && previewKind(file.name, file.mimeType) === 'video' ? (
                    <MediaDetails contentPath={contentPath} />
                  ) : null
                }
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function StepButton({
  side,
  label,
  onClick,
  children,
}: {
  side: 'left' | 'right'
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="secondary"
      size="icon-lg"
      aria-label={label}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 rounded-full bg-secondary/70 shadow-lg backdrop-blur-sm max-sm:hidden',
        side === 'left' ? 'left-3' : 'right-3',
      )}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/** The file's facts; a video's formats too (`media`). */
function Details({ file, media }: { file: ViewedFile; media: ReactNode }) {
  const rows: [string, ReactNode][] = [
    ['Size', formatBytes(file.sizeBytes)],
    ['Type', file.mimeType ?? fileCategoryLabel(fileCategory(file.name, file.mimeType))],
    ['Modified', formatFullDate(file.updatedAt)],
  ]
  if (file.syncState) {
    rows.push([
      'Stored',
      <span key="sync" className="inline-flex items-center gap-1.5">
        <SyncStatus state={file.syncState} />
        {file.syncState === 'stored' ? 'In Discord' : file.syncState === 'syncing' ? 'Syncing' : ''}
      </span>,
    ])
  }
  return (
    <section
      aria-label="Details"
      className="absolute top-2 right-2 w-72 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 max-sm:inset-x-2 max-sm:top-auto max-sm:bottom-2 max-sm:w-auto"
    >
      <h2 className="mb-3 truncate font-medium">{file.name}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </div>
        ))}
        {media}
      </dl>
    </section>
  )
}
