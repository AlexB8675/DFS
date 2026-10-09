import type { DriveNode } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { nodeQuery } from '@/features/drive/api'
import { useDialogStore } from '@/features/drive/dialogs/dialog-store'
import { useSelectionStore } from '@/features/drive/selection'
import { useNodeActions } from '@/features/drive/use-node-actions'
import { ApiError } from '@/lib/api/client'
import { drivePlace } from '@/lib/file-place'
import { FileViewer } from './file-viewer'
import { usePreviewList } from './use-preview-list'

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
  const list = usePreviewList({
    items: nodes,
    hasMore,
    isLoadingMore,
    onLoadMore,
    placeOf: drivePlace,
  })
  const actions = useNodeActions()
  const store = useSelectionStore()
  const covered = useDialogStore((state) => state.dialog !== null)
  // Not in the list (a reload far down a large folder, or a link): asked for alone.
  const fetched = useQuery({
    ...nodeQuery(list.shownId ?? ''),
    enabled: list.shownId !== null && list.listed === undefined,
  })
  const node = list.listed ?? fetched.data ?? null

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
      open={list.previewId !== null}
      file={node?.kind === 'file' ? node : null}
      error={error}
      place={list.shownId ? drivePlace(list.shownId) : null}
      previous={list.previous}
      next={list.next}
      position={list.position}
      covered={covered}
      onClose={() => {
        if (list.listed) store.getState().select(list.listed.id)
        list.close()
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
