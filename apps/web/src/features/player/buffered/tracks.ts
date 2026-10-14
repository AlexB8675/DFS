// Small sums about a video's tracks and its buffer (DESIGN.md §10.4). The
// player gives mp4box's tracks to Media Source Extensions, which wants a MIME
// type for each, and has to decide how many samples go in a segment, how far
// ahead of the playhead is buffered, how far ahead it should buffer, and where
// a video's keyframes are (trimming must never cut the group of frames being
// played, which can't be dropped before the next keyframe). These are plain
// functions of numbers, so they can be tested without a browser.

/** What these helpers need of an mp4box track (mp4box's `Track` has these fields). */
export interface TrackShape {
  codec: string
  type?: 'audio' | 'video' | 'subtitles' | 'metadata'
  nb_samples: number
  /** In the track's timescale. */
  duration: number
  timescale: number
}

/** The MIME type a SourceBuffer is made with: `video/mp4; codecs="hvc1.2.4.L153.B0"`. */
export function mimeOf(track: TrackShape): string {
  const container = track.type === 'audio' ? 'audio/mp4' : 'video/mp4'
  return `${container}; codecs="${track.codec}"`
}

/** Samples per segment for about `seconds` of the track; at least 1. */
export function samplesPerSegment(track: TrackShape, seconds: number): number {
  if (track.duration === 0) return Math.max(track.nb_samples, 1)
  const trackSeconds = track.duration / track.timescale
  return Math.max(1, Math.round((track.nb_samples / trackSeconds) * seconds))
}

/** What a TimeRanges has, for tests. */
export interface RangesShape {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

/** How late a range may start and still count as holding `time`: a first frame can start a little after 0. */
const START_SLACK_SECONDS = 0.1

/** Seconds buffered from `time` on without a gap; 0 when `time` isn't inside a range. */
export function aheadSeconds(ranges: RangesShape, time: number): number {
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.start(i) <= time + START_SLACK_SECONDS && time < ranges.end(i)) {
      return ranges.end(i) - time
    }
  }
  return 0
}

/**
 * All that is buffered, ahead and behind the playhead, in bytes: under Chrome's
 * and Firefox's 150 MB for Media Source video (§10.4).
 */
export const TOTAL_BYTES = 120 * 1024 * 1024

/** How many bytes of what was already played to keep behind the playhead (§10.4). */
export const BEHIND_BYTES = 16 * 1024 * 1024

/** `value`, held to between `low` and `high`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * How far ahead to buffer and how much to keep behind, for a file of
 * `bytesPerSecond` whose keyframes are at most `keyframeGapSeconds` apart.
 * Behind the playhead sits what is kept, plus the group of frames being played,
 * which can't be cut until the next keyframe; the rest of the budget goes ahead
 * (§10.4).
 */
export function bufferTargets(
  bytesPerSecond: number,
  keyframeGapSeconds: number,
): {
  aheadSeconds: number
  behindSeconds: number
} {
  if (bytesPerSecond <= 0) return { aheadSeconds: 60, behindSeconds: 10 }
  const behindSeconds = clamp(BEHIND_BYTES / bytesPerSecond, 1, 10)
  return {
    aheadSeconds: clamp(TOTAL_BYTES / bytesPerSecond - (behindSeconds + keyframeGapSeconds), 2, 60),
    behindSeconds,
  }
}

/**
 * Seconds to queue at a start, or after a seek, before the video plays: little,
 * so it begins quickly, as YouTube's does (§10.4).
 */
export const START_GOAL_SECONDS = 2

/**
 * Seconds to queue at least after a stall, before the video plays again: more
 * than at a start, so one stall isn't followed at once by another (§10.4).
 */
export const STALL_GOAL_SECONDS = 4

/** Why playback waits for data: its start (or after a seek), or a stall while playing. */
export type HoldReason = 'start' | 'stall'

/**
 * Seconds to queue before letting the video play again (§10.4), as YouTube does.
 * A start needs little. After a stall on a link slower than the video, it waits
 * long enough to play to the end, or as long as the buffer allows.
 */
export function bufferingGoal(input: {
  reason: HoldReason
  /** How fast the link brought bytes while reading, or `null` before any were read. */
  linkBytesPerSecond: number | null
  bytesPerSecond: number
  targetAheadSeconds: number
  /** Seconds from the playhead to the end of the video. */
  remainingSeconds: number
}): number {
  const { reason, linkBytesPerSecond, bytesPerSecond, targetAheadSeconds, remainingSeconds } = input
  if (reason === 'start') {
    return Math.max(0, Math.min(START_GOAL_SECONDS, targetAheadSeconds, remainingSeconds))
  }
  const floor = Math.min(STALL_GOAL_SECONDS, targetAheadSeconds)
  if (linkBytesPerSecond === null || linkBytesPerSecond >= bytesPerSecond) {
    return Math.max(0, Math.min(floor, remainingSeconds))
  }
  // The link is slower than the video: queue what the rest of the video will
  // take from the link, as much as the buffer can hold.
  const needed = remainingSeconds * (1 - linkBytesPerSecond / bytesPerSecond)
  return Math.max(0, Math.min(remainingSeconds, clamp(needed, floor, targetAheadSeconds * 0.9)))
}

/** What these helpers need of an mp4box sample (mp4box's `Sample` has these fields). */
export interface SampleShape {
  is_sync: boolean
  /** Presentation time, in `timescale` units. */
  cts: number
  timescale: number
}

/** The keyframes' presentation times in seconds, ascending (§10.4). */
export function keyframeTimes(samples: readonly SampleShape[]): number[] {
  const times: number[] = []
  for (const sample of samples) {
    if (sample.is_sync) times.push(sample.cts / sample.timescale)
  }
  // B-frames make presentation times come out of order.
  return times.sort((a, b) => a - b)
}

/** The last keyframe at or before `time`; 0 when there is none (§10.4). */
export function keyframeAtOrBefore(times: readonly number[], time: number): number {
  let low = 0
  let high = times.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = times[middle]
    if (candidate !== undefined && candidate <= time) {
      found = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * The longest stretch without a keyframe, counting from 0 to the first and from
 * the last to `durationSeconds`; `durationSeconds` when there are none (§10.4).
 */
export function longestKeyframeGap(times: readonly number[], durationSeconds: number): number {
  let previous = 0
  let longest = 0
  for (const time of times) {
    longest = Math.max(longest, time - previous)
    previous = time
  }
  return Math.max(longest, durationSeconds - previous)
}
