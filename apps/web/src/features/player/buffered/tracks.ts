// Small sums about a video's tracks and its buffer (DESIGN.md §10.4). The
// player gives mp4box's tracks to Media Source Extensions, which wants a MIME
// type for each, and has to decide how many samples go in a segment, how far
// ahead of the playhead is buffered, and how far ahead it should buffer. These
// are plain functions of numbers, so they can be tested without a browser.

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
 * How many bytes to buffer ahead of the playhead: under Firefox's 150 MB
 * eviction threshold for Media Source video, and Chrome's similar quota.
 */
export const AHEAD_BYTES = 100 * 1024 * 1024

/** How many bytes of what was already played to keep behind the playhead. */
export const BEHIND_BYTES = 16 * 1024 * 1024

/** `value`, held to between `low` and `high`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/** How far ahead to buffer and how much to keep behind, for a file of `bytesPerSecond`. */
export function bufferTargets(bytesPerSecond: number): {
  aheadSeconds: number
  behindSeconds: number
} {
  if (bytesPerSecond <= 0) return { aheadSeconds: 60, behindSeconds: 10 }
  return {
    aheadSeconds: clamp(AHEAD_BYTES / bytesPerSecond, 4, 60),
    behindSeconds: clamp(BEHIND_BYTES / bytesPerSecond, 1, 10),
  }
}
