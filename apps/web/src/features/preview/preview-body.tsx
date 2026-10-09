import type { SyncState } from '@dfs/shared'
import { lazy, Suspense, useState, type RefObject } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { previewKind } from '@/lib/preview-kind'
import { ImageView } from './image-view'
import { NoPreview } from './no-preview'
import type { ViewHandle } from './view-handle'

// Text, with its editor, loads with the first text file opened; pdf.js with
// the first PDF; the player with the first video.
const TextView = lazy(() => import('./text-view'))
const PdfView = lazy(() => import('./pdf-view'))
const VideoView = lazy(() => import('@/features/player/video-view'))

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

interface PreviewBodyProps {
  /** `null` while it loads, or when it can't be shown (`error`). */
  file: ViewedFile | null
  error: { title: string; description: string } | null
  /** Where its bytes are, as an API path (`/files/:id/content`). */
  contentPath: string | null
  view: RefObject<ViewHandle | null>
  /** The files around it, for an image's swipes. */
  previous: (() => void) | null
  next: (() => void) | null
  onDownload: () => void
}

/**
 * A file as the viewer shows it (§10.3, §10.4): an image, a PDF, text or a
 * video, or why it can't be shown. The viewer puts it under its header; a file link's page
 * shows it under the link's.
 */
export function PreviewBody({
  file,
  error,
  contentPath,
  view,
  previous,
  next,
  onDownload,
}: PreviewBodyProps) {
  const [failedId, setFailedId] = useState<string | null>(null)

  const readable = file && file.syncState !== 'uploading' && file.syncState !== 'failed'
  const kind = file && readable ? previewKind(file.name, file.mimeType) : null
  if (error) {
    return <NoPreview title={error.title} description={error.description} />
  }
  if (!file || !contentPath) {
    return <Loading />
  }
  if (kind === 'image' && failedId !== file.id) {
    return (
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
  }
  if (kind === 'pdf') {
    return (
      <Suspense fallback={<Loading />}>
        <PdfView key={file.id} ref={view} contentPath={contentPath} onDownload={onDownload} />
      </Suspense>
    )
  }
  if (kind === 'video') {
    return (
      <Suspense fallback={<Loading />}>
        <VideoView
          key={file.id}
          ref={view}
          name={file.name}
          contentPath={contentPath}
          onDownload={onDownload}
          onSwipe={(direction) => {
            ;(direction === 1 ? next : previous)?.()
          }}
        />
      </Suspense>
    )
  }
  if (kind === 'text') {
    return (
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
  }
  return (
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

function Loading() {
  return (
    <div className="flex size-full items-center justify-center text-muted-foreground">
      <Spinner className="size-6" />
    </div>
  )
}
