// The picture's longest stretch without a keyframe (DESIGN.md §10.4), from an MP4 track's frame table: the
// decoder needs a whole group of pictures at once, so this is what the window has to hold at least.
// It uses no DOM type.

import type { EngineTrack } from './tracks.ts'

/**
 * The longest stretch of the picture between one keyframe and the next, or to the end of the last frame,
 * in seconds. 0 when it isn't known: a Matroska file keeps no frame table, and a table may have no frames.
 */
export function keyframeGapSeconds(track: EngineTrack): number {
  const { track: source } = track
  if (!('table' in source)) return 0
  const { table } = source
  if (table.count === 0 || table.timescale <= 0) return 0
  let longest = 0
  let from: number | null = null
  for (let i = 0; i < table.count; i += 1) {
    if (table.sync[i] !== 1) continue
    const at = table.dts[i] ?? 0
    if (from !== null) longest = Math.max(longest, at - from)
    from = at
  }
  if (from === null) return 0
  const last = table.count - 1
  const end = (table.dts[last] ?? 0) + (table.durations[last] ?? 0)
  longest = Math.max(longest, end - from)
  return longest / table.timescale
}
