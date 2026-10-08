import type { DriveNode } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { nodeQuery } from '@/features/drive/api'
import { useDialogStore } from '@/features/drive/dialogs/dialog-store'
import { useSelectionStore } from '@/features/drive/selection'
import { useNodeActions } from '@/features/drive/use-node-actions'
import { ApiError } from '@/lib/api/client'
import { isPreviewable, previewKind } from '@/lib/preview-kind'
import { FileViewer } from './file-viewer'
import { usePreview } from './use-preview'

/** How many files before the end of what has loaded the viewer asks for the next page. */
const LOAD_AHEAD = 3

interface DrivePreviewProps {
  /** The list the viewer was opened from: a folder's files, or search results. */
  nodes: DriveNode[]
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
}

/**
 * The viewer over a drive list (§10.3), opened by `?preview=<id>`: ← and →
 * move through the list's previewable files, loading its next page at the
 * end, and closing it selects the file last seen.
 */
export function DrivePreview({ nodes, hasMore, isLoadingMore, onLoadMore }: DrivePreviewProps) {
  const { previewId, move, close } = usePreview()
  const actions = useNodeActions()
  const store = useSelectionStore()
  const covered = useDialogStore((state) => state.dialog !== null)
  // The file on screen: ahead of the address while it changes, so a key held
  // down moves one file each time, and kept while the viewer fades out.
  const [shownId, setShownId] = useState(previewId)
  const [addressId, setAddressId] = useState(previewId)
  /** The file the address is on its way to; those it passes on the way aren't shown. */
  const [movingTo, setMovingTo] = useState<string | null>(null)
  if (previewId !== addressId) {
    setAddressId(previewId)
    if (previewId === null || previewId === movingTo) setMovingTo(null)
    if (previewId !== null && (movingTo === null || previewId === movingTo)) setShownId(previewId)
  }
  function show(id: string) {
    setShownId(id)
    setMovingTo(id)
    move(id)
  }

  const files = nodes.filter((node) => isPreviewable(node))
  const index = files.findIndex((node) => node.id === shownId)
  const listed = nodes.find((node) => node.id === shownId)
  // Not in the list (a reload far down a large folder, or a link): asked for alone.
  const fetched = useQuery({
    ...nodeQuery(shownId ?? ''),
    enabled: shownId !== null && listed === undefined,
  })
  const node = listed ?? fetched.data ?? null
  const before = index > 0 ? files[index - 1] : undefined
  const after = index === -1 ? undefined : files[index + 1]

  const nearEnd = previewId !== null && index !== -1 && index >= files.length - LOAD_AHEAD
  useEffect(() => {
    if (nearEnd && hasMore && !isLoadingMore) onLoadMore()
  }, [nearEnd, hasMore, isLoadingMore, onLoadMore])

  // The next image, loaded ahead; asked for again when shown, it costs a 304.
  const ahead = after && previewKind(after.name, after.mimeType) === 'image' ? after.id : null
  useEffect(() => {
    if (!ahead) return
    const image = new Image()
    image.src = `/api${contentPath(ahead)}`
  }, [ahead])

  const missing = fetched.error instanceof ApiError && fetched.error.status === 404
  const error =
    node?.kind === 'folder' || missing
      ? {
          title: 'This file can’t be opened',
          description: 'It may have been moved to the trash or deleted.',
        }
      : fetched.error
        ? { title: 'This file can’t be opened', description: fetched.error.message }
        : null

  return (
    <FileViewer
      open={previewId !== null}
      file={node?.kind === 'file' ? node : null}
      error={error}
      contentPath={shownId ? contentPath(shownId) : null}
      previous={
        before
          ? () => {
              show(before.id)
            }
          : null
      }
      next={
        after
          ? () => {
              show(after.id)
            }
          : null
      }
      position={index !== -1 && !hasMore ? { index, total: files.length } : null}
      covered={covered}
      onClose={() => {
        if (listed) store.getState().select(listed.id)
        close()
      }}
      onDownload={() => {
        if (node) actions.download([node])
      }}
      onShare={() => {
        if (node) actions.share(node)
      }}
    />
  )
}

function contentPath(id: string): string {
  return `/files/${id}/content`
}
