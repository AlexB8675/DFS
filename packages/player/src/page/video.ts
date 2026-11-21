// What the engine reads from a `video` element (DESIGN.md §10.4), as plain values: its buffered ranges, and
// how far they reach from a time. Nothing here changes the element.

import { GAP_EDGE_SECONDS } from '../limits.ts'

/** `HTMLMediaElement.HAVE_CURRENT_DATA`: the element has the picture at the clock. */
export const HAVE_CURRENT_DATA = 2

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: the element has data past the clock. */
export const HAVE_FUTURE_DATA = 3

/** The ranges as `[start, end]` pairs in seconds. */
export function rangesOf(buffered: TimeRanges): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < buffered.length; i += 1) out.push([buffered.start(i), buffered.end(i)])
  return out
}

/** The seconds from `at` to the end of the range that holds it (a range's edge counts as holding it, a little short), or 0. */
export function aheadOf(buffered: TimeRanges, at: number): number {
  for (const [start, end] of rangesOf(buffered)) {
    if (start - GAP_EDGE_SECONDS <= at && at <= end) return Math.max(0, end - at)
  }
  return 0
}

/** The frames the element has shown so far. */
export function framesShown(video: HTMLVideoElement): number {
  return video.getVideoPlaybackQuality().totalVideoFrames
}

/** Whether the element is paused, read afresh (the compiler cannot see that an `await` lets it change). */
export function isPaused(video: HTMLVideoElement): boolean {
  return video.paused
}

/** Whether the ranges hold `at` with more than `GAP_EDGE_SECONDS` of data after it: the element has something to play. */
export function hasDataAt(buffered: TimeRanges, at: number): boolean {
  return rangesOf(buffered).some(([start, end]) => start <= at && end - at > GAP_EDGE_SECONDS)
}
