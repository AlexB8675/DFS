import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FilePlace } from '@/lib/file-place'

// Where a link's viewer stopped a video (DESIGN.md §10.4), kept in their
// browser, as they have no account: by link and file (its path under the
// link), and the version they played. A browser keeps the latest few
// hundred; a private window, or one that keeps nothing, starts each video
// over.

/** The most a browser keeps: the oldest go first. */
const MAX_KEPT = 200

interface Kept {
  versionId: string
  positionMs: number
  savedAt: number
}

interface LinkPositions {
  /** By the file's path under its link: `/s/:token/files/:id`. */
  positions: Record<string, Kept>
  keep: (path: string, versionId: string, positionMs: number) => void
  forget: (path: string) => void
}

export const useLinkPositions = create<LinkPositions>()(
  persist(
    (set) => ({
      positions: {},
      keep: (path, versionId, positionMs) => {
        set(({ positions }) => {
          const kept = { ...positions, [path]: { versionId, positionMs, savedAt: Date.now() } }
          const newest = Object.entries(kept)
            .sort(([, a], [, b]) => b.savedAt - a.savedAt)
            .slice(0, MAX_KEPT)
          return { positions: Object.fromEntries(newest) }
        })
      },
      forget: (path) => {
        set(({ positions }) => ({
          positions: Object.fromEntries(Object.entries(positions).filter(([key]) => key !== path)),
        }))
      },
    }),
    { name: 'dfs.link-positions', version: 1 },
  ),
)

/** Where this browser's viewer stopped in this version of a link's file, if they did. */
export function linkPosition(place: FilePlace, versionId: string): number | null {
  const kept = useLinkPositions.getState().positions[place.path]
  return kept?.versionId === versionId ? kept.positionMs : null
}
