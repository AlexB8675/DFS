import { Mp4Error } from './errors.ts'
import type { FrameTable } from './frames.ts'

// A picture's frames, timed for the player's buffer (DESIGN.md §10.4). A file with
// reordered frames (B-frames) lists each frame's duration as its decode delta, and
// a frame's presentation time as its decode time plus an offset. A browser's Media
// Source works out where a frame ends from its presentation time and its duration,
// and Chrome, given durations that are not the gaps between the frames as they are
// shown, seeks one frame early. So the play index re-times each track once, over
// its whole table: a frame lasts until the next is shown, the decode times are the
// running sum of those durations, and the offsets make up the difference, signed
// (the writer's `trun` is version 1). Every frame is still shown when the table
// says (`dts + cts` is unchanged), and the decode times still rise and are the same
// whichever frames are written, for a fragment is a slice of this one table: the
// Media Source's coded frame processing takes a decode time that falls, or jumps
// by more than twice the last frame's duration, as a discontinuity and drops the
// frames up to the next keyframe.

/** The least and greatest a composition offset of 32 bits holds. */
const OFFSET_MIN = -(2 ** 31)
const OFFSET_MAX = 2 ** 31 - 1

/**
 * The table with each frame's duration the gap from when it is shown to when the
 * next is, in presentation order, and the decode times that follow: from the first
 * frame's own, the running sum of the durations. The frame shown last keeps the
 * table's duration, and frames shown at the same time give a gap of 0, which is 1
 * tick so that decode times rise. The offsets are what each frame's presentation
 * time lacks of its new decode time. A track shown in the order it is decoded, a
 * sound among them, has gaps that are its durations, and comes back as it was
 * (the same table). The table given is not changed. Frames shown further from
 * where they are decoded than an offset of 32 bits holds are `damaged`.
 */
export function displayTimed(table: FrameTable): FrameTable {
  const { count } = table
  if (count === 0) return table
  const shown = new Float64Array(count)
  for (let i = 0; i < count; i += 1) shown[i] = (table.dts[i] ?? 0) + (table.cts[i] ?? 0)

  // The frames in the order they are shown, ties in the order they are decoded. A track shown as it is decoded needs no sort.
  let ascending = true
  for (let i = 1; i < count && ascending; i += 1) ascending = (shown[i] ?? 0) > (shown[i - 1] ?? 0)
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i += 1) order[i] = i
  if (!ascending) {
    order.sort((a, b) => (shown[a] ?? 0) - (shown[b] ?? 0) || a - b)
  }

  const durations = new Uint32Array(count)
  for (let place = 0; place < count; place += 1) {
    const frame = order[place] ?? 0
    const next = order[place + 1]
    durations[frame] =
      next === undefined
        ? (table.durations[frame] ?? 0)
        : Math.max((shown[next] ?? 0) - (shown[frame] ?? 0), 1)
  }

  const dts = new Float64Array(count)
  const cts = new Int32Array(count)
  let time = table.dts[0] ?? 0
  let same = true
  for (let i = 0; i < count; i += 1) {
    dts[i] = time
    const offset = (shown[i] ?? 0) - time
    if (offset < OFFSET_MIN || offset > OFFSET_MAX) {
      throw new Mp4Error(
        'damaged',
        `Frame ${i} is shown ${offset} ticks from where it is decoded, more than an offset of 32 bits holds.`,
      )
    }
    cts[i] = offset
    time += durations[i] ?? 0
    same = same && durations[i] === table.durations[i] && dts[i] === table.dts[i]
  }
  return same ? table : { ...table, dts, durations, cts }
}
