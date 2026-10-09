import { audioQueueSchema, mediaKind, type SyncState } from '@dfs/shared'
import { queryOptions } from '@tanstack/react-query'
import { toast } from 'sonner'
import { queryClient } from '@/app/query-client'
import { apiGet, errorMessage } from '@/lib/api/client'
import { addTracks, playOpened, playTracks, unlockAudio, type NewTrack } from './engine'

// Opening and queueing audio (DESIGN.md §10.4), from the drive, search and
// the share page: an audio file plays at once in the bar, with its folder's
// audio queued around it; a folder plays everything below it, folder by
// folder (the user's decision, 2026-10-09). A link's files go under its token.

/** A file as a list shows it. */
interface ListedFile {
  id: string
  name: string
  parentId: string | null
}

/** A file the bar plays: audio, uploaded. */
export function isAudio(node: {
  kind: string
  name: string
  mimeType: string | null
  syncState?: SyncState | null
}): boolean {
  return (
    node.kind === 'file' &&
    node.syncState !== 'uploading' &&
    node.syncState !== 'failed' &&
    mediaKind(node.name, node.mimeType) === 'audio'
  )
}

/** A folder's audio in play order, or everything below it (`deep`): the drive's, or a link's. */
export function audioQuery(folderId: string, token: string | null, deep: boolean) {
  return queryOptions({
    queryKey: ['audio', token, folderId, deep],
    queryFn: async ({ signal }) => {
      const queue =
        token === null
          ? await apiGet(`/folders/${folderId}/audio`, audioQueueSchema, {
              query: { deep: deep ? '1' : null },
              signal,
            })
          : await apiGet(`/s/${token}/audio`, audioQueueSchema, {
              query: { folderId, deep: deep ? '1' : null },
              signal,
            })
      return { ...queue, items: queue.items.map((item): NewTrack => ({ ...item, token })) }
    },
    staleTime: 30_000,
    meta: { skipAuthRedirect: token !== null },
  })
}

/** A file by itself, before its folder's queue says more of it. */
function lone(file: ListedFile, token: string | null): NewTrack {
  return {
    id: file.id,
    name: file.name,
    token,
    versionId: null,
    durationMs: null,
    title: null,
    artist: null,
    album: null,
    hasCover: false,
  }
}

/** Opening an audio file: it plays at once, and its folder's audio is queued around it. */
export function openAudio(file: ListedFile, token: string | null = null): void {
  const track = lone(file, token)
  const folder = file.parentId
  playOpened(
    track,
    folder === null
      ? Promise.resolve([track])
      : fetchTracks(folder, token, false).then((queue) => queue.items),
  )
}

/** Adds an audio file after what is queued. */
export function queueAudio(file: ListedFile, token: string | null = null): void {
  addTracks([lone(file, token)])
}

/** Plays a folder: everything below it, folder by folder. */
export async function playFolder(folderId: string, token: string | null = null): Promise<void> {
  // The request comes back after the click: a phone would refuse the sound then.
  unlockAudio()
  const tracks = await queued(folderId, token)
  if (tracks) playTracks(tracks)
}

/** Adds everything below a folder after what is queued. */
export async function queueFolder(folderId: string, token: string | null = null): Promise<void> {
  const tracks = await queued(folderId, token)
  if (tracks) addTracks(tracks)
}

/** A folder's tracks for Play or Add to queue, saying when there are none or too many. */
async function queued(folderId: string, token: string | null): Promise<NewTrack[] | null> {
  try {
    const queue = await fetchTracks(folderId, token, true)
    if (queue.items.length === 0) {
      toast.info('There is no audio in this folder.')
      return null
    }
    if (queue.truncated) {
      toast.info(`Only the first ${queue.items.length.toLocaleString('en')} files are queued.`)
    }
    return queue.items
  } catch (error) {
    toast.error('Couldn’t play this folder', { description: errorMessage(error) })
    return null
  }
}

function fetchTracks(folderId: string, token: string | null, deep: boolean) {
  return queryClient.query(audioQuery(folderId, token, deep))
}
