import { Mp4Error } from './errors.ts'
import type { FrameTable } from './frames.ts'
import type { Edit, TrackHeader } from './movie.ts'

// Where a track's frames are in time, and where in the file (DESIGN.md §10.4,
// D45). The fragments the repackager writes carry raw decode times, with no edit
// list in the init segment, so what a track's edit list says is not in them: it
// is one number for each track, `offsetSeconds`, which the player gives its
// SourceBuffer as `timestampOffset`. Seeking and splitting then work in seconds
// of the movie's time, found through that offset: the keyframe to start a seek
// at, the sound that goes with it, and the bytes of both, which are read from
// the file in one Range request.

/** What a track's SourceBuffer's timestampOffset takes, in seconds: the leading empty edit, less the media edit's start. */
export interface TrackTiming {
  offsetSeconds: number
}

/** The rate 1, as an edit holds it: 16.16 fixed point. */
const NORMAL_RATE = 0x10000

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** An edit list that does something the init segment has no way to say. */
function unplaceable(what: string): Mp4Error {
  return new Mp4Error(
    'edit-list',
    `The track's edit list has ${what}, and only one media edit at normal speed, with at most one empty edit before it, can be placed.`,
  )
}

/** The edit list as one of its two shapes, or a refusal that names what it is: an optional empty edit, then one media edit. */
function placeable(edits: readonly Edit[]): { empty: Edit | null; media: Edit } {
  const [first, second, third] = edits
  if (!first) throw unplaceable('no edits') // not reached: the caller has dealt with a list of none
  if (third) throw unplaceable(`${edits.length} edits`)
  // Only -1 is an empty edit and only 0 and up a place in the media: another start isn't either.
  for (const edit of second ? [first, second] : [first]) {
    if (edit.mediaTime < -1) {
      throw unplaceable(`an edit that starts at a media time of ${edit.mediaTime}`)
    }
  }
  const empty = (edit: Edit): boolean => edit.mediaTime === -1
  if (!second) {
    if (empty(first)) throw unplaceable('an empty edit and no media edit')
    return { empty: null, media: first }
  }
  if (empty(first) && empty(second)) throw unplaceable('two empty edits and no media edit')
  if (!empty(first) && !empty(second)) throw unplaceable('two media edits')
  if (!empty(first)) throw unplaceable('an empty edit after a media edit')
  return { empty: first, media: second }
}

/**
 * The offset a track's edit list gives. The media edit starts at `mediaTime` of
 * the media, and shows it from where the empty edit before it, if there is one,
 * ends: so a frame at media time t is shown at `t - mediaTime + pause` of the
 * movie, and the offset is `pause - mediaTime`, in seconds. Accepts no edit
 * list, or an optional leading empty edit and then one media edit at rate 1 (the
 * only shapes the videos in use have, as surveyed), and refuses any other as
 * `Mp4Error('edit-list')` with a sentence that says what the list is. How long
 * the media edit lasts is not used: a trim at its end is not applied, and the
 * track plays to its last frame. An empty edit's rate is not read either, for it
 * plays nothing. A track timescale of 0 (which `readMovie` keeps as the track's
 * problem, so it doesn't come here) is refused as `damaged`, and so is a movie
 * timescale of 0 when an empty edit has to be turned into seconds with it.
 */
export function trackTiming(track: TrackHeader, movieTimescale: number): TrackTiming {
  if (track.timescale === 0) throw damaged(`The track counts its time in ticks of 0 seconds.`)
  if (track.edits === null || track.edits.length === 0) return { offsetSeconds: 0 }

  const { empty, media } = placeable(track.edits)
  if (media.rate !== NORMAL_RATE) {
    throw new Mp4Error(
      'edit-list',
      `The track's media edit plays at a rate of ${media.rate / NORMAL_RATE}, and only normal speed can be placed.`,
    )
  }
  let paused = 0
  if (empty) {
    if (movieTimescale === 0) {
      throw damaged(
        `The track has an empty edit, and the movie counts its time in ticks of 0 seconds.`,
      )
    }
    paused = empty.durationMovieTicks / movieTimescale
  }
  // From 0, and not negated, so that a start of 0 is 0 and not -0.
  return { offsetSeconds: paused - media.mediaTime / track.timescale }
}

/** Frame i's presentation time in seconds, the offset applied: (dts + cts) / timescale + offset. A frame the table doesn't have is a RangeError: it is the caller's mistake, and not the file's. */
export function presentationSeconds(table: FrameTable, timing: TrackTiming, i: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= table.count) {
    throw new RangeError(`Frame ${i} is not one of the ${table.count} frames of the track.`)
  }
  return ((table.dts[i] ?? 0) + (table.cts[i] ?? 0)) / table.timescale + timing.offsetSeconds
}

/** The indexes of a table's keyframes, in decode order: made once per track (PlayTrack.keyframes). */
export function keyframeIndexes(table: FrameTable): Uint32Array {
  let count = 0
  for (let i = 0; i < table.count; i += 1) count += table.sync[i] === 1 ? 1 : 0
  const out = new Uint32Array(count)
  let at = 0
  for (let i = 0; i < table.count; i += 1) {
    if (table.sync[i] === 1) {
      out[at] = i
      at += 1
    }
  }
  return out
}

/**
 * The keyframe to decode from to show `seconds`: the last keyframe whose
 * presentation time is at or before it, as a frame index (an element of
 * `keyframes`, not a place in it), or the first keyframe when there is none
 * that early. A keyframe is shown after the keyframe decoded before it, so
 * their presentation times ascend, and a binary search finds it. A table with no
 * keyframe has nowhere to decode from and is refused as `damaged`.
 */
export function keyframeAtOrBefore(
  table: FrameTable,
  timing: TrackTiming,
  keyframes: Uint32Array,
  seconds: number,
): number {
  if (keyframes.length === 0) throw damaged(`The track has no keyframe to decode from.`)
  // How many keyframes are shown at or before `seconds`: the first that isn't is where the search ends.
  let low = 0
  let high = keyframes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (presentationSeconds(table, timing, keyframes[middle] ?? 0) <= seconds) low = middle + 1
    else high = middle
  }
  return keyframes[Math.max(low - 1, 0)] ?? 0
}

/**
 * The first frame, in decode order, whose decode time is at or after `seconds`,
 * the offset applied: where a sound track starts for a picture keyframe. It is
 * the decode time, `dts / timescale + offset` and not the presentation time,
 * that ascends with the index. `table.count` when no frame is that late.
 */
export function frameAtOrAfter(table: FrameTable, timing: TrackTiming, seconds: number): number {
  let low = 0
  let high = table.count
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((table.dts[middle] ?? 0) / table.timescale + timing.offsetSeconds >= seconds) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * The bytes that hold frames [from, to) of each table given: the least offset
 * and the greatest end, for one Range read of interleaved tracks. Each frame of
 * each range is looked at, for the offsets of a track don't have to ascend with
 * its frames. A range with no frame (`from` at or past `to`) holds no bytes and
 * is left out, and when there is nothing left the span is `{ start: 0, end: 0 }`:
 * nothing to read. A range that is not within the table's frames is a
 * RangeError, the caller's mistake and not the file's.
 */
export function byteSpan(parts: readonly { table: FrameTable; from: number; to: number }[]): {
  start: number
  end: number
} {
  let start = Infinity
  let end = 0
  for (const { table, from, to } of parts) {
    if (!(from < to)) continue
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > table.count) {
      throw new RangeError(
        `Frames ${from} to ${to} are not within the ${table.count} frames of the track.`,
      )
    }
    for (let i = from; i < to; i += 1) {
      const offset = table.offsets[i] ?? 0
      start = Math.min(start, offset)
      end = Math.max(end, offset + (table.sizes[i] ?? 0))
    }
  }
  return start === Infinity ? { start: 0, end: 0 } : { start, end }
}
