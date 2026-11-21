// The feed's targets (DESIGN.md §10.4): the engine feeds to the least of what the window wants of the
// tracks that play, so that a track far ahead does not pull the other many seconds, and many megabytes,
// past its window in one call with no removal in between. It uses no DOM type and no timer.

/**
 * The distinct `until` values of what the window wants of each playing track, from the least up. A track
 * that wants nothing (null) leaves none. The engine tries the least first, and the next only when
 * that feed appended nothing (a track that has ended, or a gap at the playhead).
 */
export function feedTargets(wanted: readonly ({ until: number } | null)[]): number[] {
  const untils: number[] = []
  for (const want of wanted) {
    if (want !== null && !untils.includes(want.until)) untils.push(want.until)
  }
  return untils.sort((a, b) => a - b)
}
