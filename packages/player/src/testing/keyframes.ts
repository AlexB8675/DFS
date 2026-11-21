// How far apart a picture's keyframes are, from the index alone (DESIGN.md §10.4): what decides whether a file
// is held to the fast link's one-second marks.

import { presentationSeconds } from '@dfs/mp4'
import type { PlayTrack } from '@dfs/mp4'

/**
 * The longest stretch of the picture that has no keyframe, in seconds: the stretch before the first keyframe,
 * between each two, and from the last to `durationSeconds`, with the presentation times of the track (its
 * offset applied).
 */
export function keyframeGapSeconds(track: PlayTrack, durationSeconds: number): number {
  let previous = 0
  let longest = 0
  for (const frame of track.keyframes) {
    const at = presentationSeconds(track.table, track.timing, frame)
    longest = Math.max(longest, at - previous)
    previous = at
  }
  return Math.max(longest, durationSeconds - previous)
}
