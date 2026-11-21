// Whether a track's buffered ranges hold a playhead (DESIGN.md §10.4): the rule for a seek being inside the
// decoder window. It uses no DOM type.

import { GAP_EDGE_SECONDS } from '../limits.ts'

/**
 * A range holds `at` when it starts no later than the edge after it and either has room ahead (`at` is more
 * than the edge short of its end), or the feed is done, the range is the track's last, and `at` is no more than
 * the edge past its end (the end of the file: no more is to come).
 */
export function holdsAt(
  ranges: readonly (readonly [number, number])[],
  at: number,
  feedDone: boolean,
): boolean {
  return ranges.some(([start, end], index) => {
    if (start - GAP_EDGE_SECONDS > at) return false
    if (at < end - GAP_EDGE_SECONDS) return true
    return feedDone && index === ranges.length - 1 && at <= end + GAP_EDGE_SECONDS
  })
}
