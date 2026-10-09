import { useEffect, useState } from 'react'
import { previewPath, type FilePlace } from '@/lib/file-place'
import { isPreviewable, previewKind, type ListedFile } from '@/lib/preview-kind'
import { usePreview } from './use-preview'

/** How many files before the end of what has loaded the viewer asks for the next page. */
const LOAD_AHEAD = 3

interface PreviewListOptions<T> {
  /** The list the viewer was opened from, as far as it has loaded. */
  items: T[]
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
  /** Where a file is: the drive's, or a link's. */
  placeOf: (id: string) => FilePlace
  /** Load the list's next pages until the file asked for turns up (a share link's, with no other way to find it). */
  findMissing?: boolean
}

/**
 * The viewer's way through a list (§10.3): the file in the address
 * (`?preview=<id>`), the previewable files around it, the list's next page
 * near its end, and the next image loaded ahead.
 */
export function usePreviewList<T extends ListedFile & { id: string }>({
  items,
  hasMore,
  isLoadingMore,
  onLoadMore,
  placeOf,
  findMissing = false,
}: PreviewListOptions<T>) {
  const { previewId, move, close } = usePreview()
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

  const files = items.filter((item) => isPreviewable(item))
  const index = files.findIndex((item) => item.id === shownId)
  const listed = items.find((item) => item.id === shownId)
  const before = index > 0 ? files[index - 1] : undefined
  const after = index === -1 ? undefined : files[index + 1]

  const wanted =
    previewId !== null &&
    ((index !== -1 && index >= files.length - LOAD_AHEAD) || (findMissing && !listed))
  useEffect(() => {
    if (wanted && hasMore && !isLoadingMore) onLoadMore()
  }, [wanted, hasMore, isLoadingMore, onLoadMore])

  // The next image, loaded ahead; asked for again when shown, it costs a 304.
  const ahead =
    after && previewKind(after.name, after.mimeType) === 'image'
      ? previewPath(placeOf(after.id))
      : null
  useEffect(() => {
    if (!ahead) return
    const image = new Image()
    image.src = `/api${ahead}`
  }, [ahead])

  return {
    /** The file in the address; `null` while the viewer is closed. */
    previewId,
    /** The file on screen, which stays while the viewer closes. */
    shownId,
    /** The file on screen, if it is in what has loaded of the list. */
    listed,
    previous: before
      ? () => {
          show(before.id)
        }
      : null,
    next: after
      ? () => {
          show(after.id)
        }
      : null,
    /** Its place among the list's previewable files, when the whole list has loaded. */
    position: index !== -1 && !hasMore ? { index, total: files.length } : null,
    close,
  }
}
