import { fileMediaSchema, playbackSchema } from '@dfs/shared'
import { queryOptions } from '@tanstack/react-query'
import { ApiError, apiGet } from '@/lib/api/client'

// What the players ask the API (DESIGN.md §10.4), under a file's path:
// `/files/:id` in the drive.

export const playerKeys = {
  all: ['player'] as const,
  playback: (base: string) => [...playerKeys.all, base, 'playback'] as const,
  media: (base: string) => [...playerKeys.all, base, 'media'] as const,
}

/** The version to play, where the user stopped, and the subtitle files beside it: fresh each time. */
export function playbackQuery(base: string) {
  return queryOptions({
    queryKey: playerKeys.playback(base),
    queryFn: ({ signal }) => apiGet(`${base}/playback`, playbackSchema, { signal }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
}

/** What the file holds. The first ask may examine it; a `503` isn't asked again. */
export function mediaQuery(base: string) {
  return queryOptions({
    queryKey: playerKeys.media(base),
    queryFn: ({ signal }) => apiGet(`${base}/media`, fileMediaSchema, { signal }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
  })
}

/** The version's bytes, for the video element: named, so a replaced file never mixes in. */
export function contentUrl(base: string, versionId: string, startSeconds = 0): string {
  const start = startSeconds > 0 ? `#t=${startSeconds.toFixed(3)}` : ''
  return `/api${base}/content?version=${versionId}${start}`
}
