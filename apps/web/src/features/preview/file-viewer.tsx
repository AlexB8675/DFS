import type { SyncState } from '@dfs/shared'
import { ChevronLeft, ChevronRight, Download, Info, Share2, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { NodeIcon } from '@/components/node-icon'
import { SyncStatus } from '@/components/sync-status'
import { fileCategory, fileCategoryLabel } from '@/lib/file-types'
import { formatBytes, formatFullDate } from '@/lib/format'
import { previewKind } from '@/lib/preview-kind'
import { cn } from '@/lib/utils'
import { ImageView } from './image-view'
import { NoPreview } from './no-preview'
import type { ViewHandle } from './view-handle'

// Text, with its editor, loads with the first text file opened.
const TextView = lazy(() => import('./text-view'))

/** A file as the viewer shows it: from the drive, or from a share link. */
export interface ViewedFile {
  id: string
  name: string
  mimeType: string | null
  sizeBytes: number
  updatedAt: string
  /** Where its bytes are; a share link's files don't say. */
  syncState?: SyncState | null
}

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
  const [failedId, setFailedId] = useState<string | null>(null)

  useEffect(() => {
    if (open && !covered) contentRef.current?.focus()
  }, [open, covered])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || isEditable(event.target)) return
    const command = event.ctrlKey || event.metaKey
    const find = view.current?.find
    if (command && event.key === 'f' && find) {
      event.preventDefault()
      find()
      return
    }
    if (command) return
    const actions: Record<string, (() => void) | null | undefined> = {
      ArrowLeft: previous,
      ArrowRight: next,
      '+': view.current?.zoomIn,
      '=': view.current?.zoomIn,
      '-': view.current?.zoomOut,
      '0': view.current?.reset,
    }
    const action = actions[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  const readable = file && file.syncState !== 'uploading' && file.syncState !== 'failed'
  const kind = file && readable ? previewKind(file.name, file.mimeType) : null
  let body: ReactNode
  if (error) {
    body = <NoPreview title={error.title} description={error.description} />
  } else if (!file || !contentPath) {
    body = <Loading />
  } else if (kind === 'image' && failedId !== file.id) {
    body = (
      <ImageView
        key={file.id}
        ref={view}
        src={`/api${contentPath}`}
        alt={file.name}
        vector={file.mimeType === 'image/svg+xml' || /\.svg$/i.test(file.name)}
        onSwipe={(direction) => {
          ;(direction === 1 ? next : previous)?.()
        }}
        onError={() => {
          setFailedId(file.id)
        }}
      />
    )
  } else if (kind === 'text') {
    body = (
      <Suspense fallback={<Loading />}>
        <TextView
          key={file.id}
          ref={view}
          name={file.name}
          mimeType={file.mimeType}
          sizeBytes={file.sizeBytes}
          contentPath={contentPath}
          onDownload={onDownload}
        />
      </Suspense>
    )
  } else {
    body = (
      <NoPreview
        title="No preview"
        description={
          kind
            ? 'This file can’t be shown here: it may be damaged, or in a format this browser can’t draw.'
            : 'This kind of file can’t be shown here.'
        }
        onDownload={onDownload}
      />
    )
  }

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
          onKeyDown={handleKeyDown}
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
            {body}
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
            {detailsOpen && file && <Details file={file} />}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function Loading() {
  return (
    <div className="flex size-full items-center justify-center text-muted-foreground">
      <Spinner className="size-6" />
    </div>
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

function Details({ file }: { file: ViewedFile }) {
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
      </dl>
    </section>
  )
}

/** Keys typed into a field are the field's. */
function isEditable(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  )
}
