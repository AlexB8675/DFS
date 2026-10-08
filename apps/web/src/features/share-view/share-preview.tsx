import type { SharedNode } from '@dfs/shared'
import { toast } from 'sonner'
import { FileViewer } from '@/features/preview/file-viewer'
import { usePreviewList } from '@/features/preview/use-preview-list'
import { errorMessage } from '@/lib/api/client'
import { downloadSharedFile, sharedPreviewPath } from './api'

interface SharePreviewProps {
  token: string
  /** The folder's items, as far as they have loaded. */
  nodes: SharedNode[]
  /** The folder's first page has come. */
  loaded: boolean
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
}

/**
 * The viewer over a shared folder (§10.3), as over the drive: its previews
 * never count toward the link's download limit, and its Download does.
 */
export function SharePreview({
  token,
  nodes,
  loaded,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: SharePreviewProps) {
  const contentPath = (id: string) => sharedPreviewPath(token, id)
  const list = usePreviewList({
    items: nodes,
    hasMore,
    isLoadingMore,
    onLoadMore,
    contentPath,
    findMissing: true,
  })
  const node = list.listed ?? null
  const gone = list.shownId !== null && !node && loaded && !hasMore && !isLoadingMore
  const error =
    gone || node?.kind === 'folder'
      ? { title: 'This file can’t be opened', description: 'It isn’t in this folder any more.' }
      : null

  return (
    <FileViewer
      open={list.previewId !== null}
      file={node?.kind === 'file' ? node : null}
      error={error}
      contentPath={list.shownId ? contentPath(list.shownId) : null}
      previous={list.previous}
      next={list.next}
      position={list.position}
      onClose={list.close}
      onDownload={() => {
        if (!node) return
        downloadSharedFile(token, node).catch((reason: unknown) => {
          toast.error('Couldn’t download', { description: errorMessage(reason) })
        })
      }}
    />
  )
}
