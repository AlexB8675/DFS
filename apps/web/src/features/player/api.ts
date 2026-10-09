import { fileMediaSchema, playbackSchema } from '@dfs/shared'
import { queryOptions } from '@tanstack/react-query'
import { ApiError, apiGet } from '@/lib/api/client'
import type { FilePlace } from '@/lib/file-place'
import { linkPosition } from './link-positions'

// What the players ask the API (DESIGN.md §10.4), under a file's path:
// `/files/:id` in the drive, `/s/:token/files/:id` through a share link.

export const playerKeys = {
  all: ['player'] as const,
  playback: (path: string) => [...playerKeys.all, path, 'playback'] as const,
  media: (path: string) => [...playerKeys.all, path, 'media'] as const,
}

/**
 * The version to play, where the viewer stopped, and the subtitle files
 * beside it: fresh each time. A link's viewer stopped where their browser
 * says, as the server keeps nothing for them.
 */
export function playbackQuery(place: FilePlace) {
  return queryOptions({
    queryKey: playerKeys.playback(place.path),
    queryFn: async ({ signal }) => {
      const playback = await apiGet(`${place.path}/playback`, playbackSchema, { signal })
      if (place.token === null) return playback
      return { ...playback, positionMs: linkPosition(place, playback.versionId) }
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    // A file gone or a link ended stays so: only the server's own trouble is asked again.
    retry: (failures, error) => failures < 2 && !(error instanceof ApiError && error.status < 500),
    meta: linkMeta(place),
  })
}

/** What the file holds. The first ask may examine it; a `503` isn't asked again. */
export function mediaQuery(place: FilePlace) {
  return queryOptions({
    queryKey: playerKeys.media(place.path),
    queryFn: ({ signal }) => apiGet(`${place.path}/media`, fileMediaSchema, { signal }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
    meta: linkMeta(place),
  })
}

/**
 * The version's bytes, for the video element: named, so a replaced file
 * never mixes in. Through a link, playing is looking, which never counts
 * toward its download limit (§7.5).
 */
export function contentUrl(place: FilePlace, versionId: string, startSeconds = 0): string {
  const preview = place.token === null ? '' : '&preview=1'
  const start = startSeconds > 0 ? `#t=${startSeconds.toFixed(3)}` : ''
  return `/api${place.path}/content?version=${versionId}${preview}${start}`
}

/** Where to test the connection: a user's, or a link viewer's, under the link. */
export function connectionTestPath(place: FilePlace): string {
  return place.token === null ? '/connection-test' : `/s/${place.token}/connection-test`
}

/** A link's errors are the player's to show, not a reason to sign in. */
function linkMeta(place: FilePlace) {
  return { skipAuthRedirect: place.token !== null }
}
