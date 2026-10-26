import type { RawFrame } from './clusters.ts'

// When Matroska's frames are decoded (DESIGN.md §10.4, D45). A Matroska file stores
// only the times a frame is presented at, in ticks of its TimestampScale. A
// fragment of MP4 wants the time it is decoded at (its dts) and how long it
// decodes for (the next frame's dts less its own), which Media Source takes to
// tell a stream that goes on from a gap: a duration that is wrong makes it see a
// gap and drop the frames to the next keyframe. They are derived as ffmpeg
// derives them. In decode order, which is the order of the blocks, a frame's dts
// is the least of the presentation times that are not yet taken, which is the
// presentation times in rising order, delayed by the picture's reorder depth
// (ffprobe's `has_b_frames`, see reorder.ts); the first `depth` frames, which
// have nothing to be delayed by, are put back from the first presentation time at
// the length of a frame each, as ffmpeg's remux does. A sound reorders nothing,
// and the same function serves it with a depth of 0.
//
// The frames of a track come in spans, as the clusters are read, so the work is
// carried from one call to the next in a state (`DecodeState`) of plain data, and a
// call never changes the state it is given. A frame is held until the next one's
// dts is known, for its duration is the difference. All times here are whole
// numbers of ticks, which is what the writer's tables hold: the presentation
// times are whole already, and a distance of fractional ticks (a frame's length
// is, at 33 333 333 ns a frame) is rounded once, where it is used.

/** What is carried from one span of a track's frames to the next. */
export interface DecodeState {
  /** How many frames the picture's decode runs ahead of its presentation (0 for a sound). */
  depth: number
  /** How long a frame lasts, in ticks, perhaps not a whole number: the distance that the first dts are put back by, and the length of a last frame that says none. */
  frameTicks: number
  /** The presentation times of the frames seen that no dts has been taken for. */
  pending: number[]
  /**
   * The frames that are not given out yet. Before the first dts is known
   * (`lastDts` is null) they are the frames seen since the start, fewer than
   * `depth + 1`, and none has a dts. After it there is at most one, the last frame
   * seen, whose dts is `lastDts` and whose duration waits for the next.
   */
  held: RawFrame[]
  /** The dts last given to a frame, null since the start (the file's, a seek's or a skip's) until frame `depth` is seen. */
  lastDts: number | null
}

/** A frame with the two times that a fragment needs, in ticks. */
export interface TimedFrame extends RawFrame {
  /** When it is decoded; the first frames of a start may be before 0. */
  dts: number
  /** How long it decodes for, at least 1. */
  decodeDuration: number
}

/** The scale a second is counted in, when `timestampScale` nanoseconds go into a second a whole number of times; else null. A scale that is no number of nanoseconds is none. */
function wholeTimescale(timestampScale: number): number | null {
  if (!(timestampScale > 0)) return null
  const perSecond = 1e9 / timestampScale
  return Number.isInteger(perSecond) ? perSecond : null
}

/**
 * The timescale a track's table counts in. Matroska's ticks are `timestampScale`
 * nanoseconds, so the ticks themselves are the table's when a second holds a
 * whole number of them (1 000 000 gives 1000, the usual millisecond), and the
 * table counts in nanoseconds when it does not: the timescale of an MP4 track is a
 * whole number.
 */
export function trackTimescale(timestampScale: number): number {
  return wholeTimescale(timestampScale) ?? 1e9
}

/** A time in ticks of the file's `timestampScale` as ticks of `trackTimescale`: the same number, or in nanoseconds when the scale is not a whole divisor of a second. */
export function toTrackTicks(ticks: number, timestampScale: number): number {
  return wholeTimescale(timestampScale) === null ? ticks * timestampScale : ticks
}

/** A state for the frames after a start (the file's, a seek's, or a skip's: the caller decides), of a picture of this reorder depth or a sound (0), whose frames last `frameTicks` ticks. */
export function startDecode(depth: number, frameTicks: number): DecodeState {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new RangeError(`${depth} is not a number of frames that a decode runs ahead.`)
  }
  if (!Number.isFinite(frameTicks) || frameTicks <= 0) {
    throw new RangeError(`${frameTicks} is not a length of a frame in ticks.`)
  }
  return { depth, frameTicks, pending: [], held: [], lastDts: null }
}

/** Takes the least presentation time out of `pending`, which holds at least one. */
function takeLeast(pending: number[]): number {
  let at = 0
  for (const [index, time] of pending.entries()) {
    if (time < (pending[at] ?? Infinity)) at = index
  }
  return pending.splice(at, 1)[0] ?? 0
}

/**
 * Gives the frames that follow the ones of `state` their decode times, and gives
 * out the frames that these settle: those whose own dts and the next frame's are
 * known, so that their duration is exact. `frames` are of one track, in decode
 * order. With `end` there is no next frame, and every frame held is given out; the
 * state that comes back is then a start again (`startDecode`).
 *
 * From frame `depth` on, a frame's dts is the least presentation time still
 * pending after its own is added. When frame `depth` is seen, the frames before it
 * get the least of the `depth + 1` (which is its own dts) less one frame's length
 * for each frame between, each rounded once: frame i gets `least - round((depth -
 * i) * frameTicks)`. When a stream ends before that, the k frames that were seen
 * count as the whole: frame i of k gets `least - round((k - 1 - i) * frameTicks)`,
 * so that the last of them gets the least, as frame `depth` would, and they rise.
 *
 * A dts is always at least one tick past the last: a stream that reorders deeper
 * than the depth says, which a conforming one does not, would take a presentation
 * time that is not past it, and the dts is raised to one past it instead, so that
 * every duration is at least 1 and the composition offset, which goes negative
 * then, takes up the difference. The last frame's duration, with `end`, is its own,
 * else a frame's length, rounded and at least 1.
 */
export function decodeTimes(
  state: DecodeState,
  frames: readonly RawFrame[],
  end: boolean,
): { timed: TimedFrame[]; state: DecodeState } {
  const { depth, frameTicks } = state
  const pending = [...state.pending]
  const timed: TimedFrame[] = []

  // The frame whose dts is the last one given, waiting for the next to say how long it lasts, and that dts. A record, so that the closure below does not narrow them.
  const run: { waiting: RawFrame | null; lastDts: number | null } = {
    waiting: state.lastDts === null ? null : (state.held[0] ?? null),
    lastDts: state.lastDts,
  }
  // The frames seen since the start, while no dts is known.
  let seen: RawFrame[] = state.lastDts === null ? [...state.held] : []

  /** Gives `frame` the decode time `wanted`, raised to one past the last, and gives out the frame before it, whose duration it settles. */
  const settle = (frame: RawFrame, wanted: number): void => {
    const dts = run.lastDts === null ? wanted : Math.max(wanted, run.lastDts + 1)
    if (run.waiting !== null && run.lastDts !== null) {
      timed.push({ ...run.waiting, dts: run.lastDts, decodeDuration: dts - run.lastDts })
    }
    run.waiting = frame
    run.lastDts = dts
  }

  /** Gives the frames seen since the start their decode times: the last the least pending, and each before it that less the length of a frame for each frame that follows it among them. */
  const release = (): void => {
    if (seen.length === 0) return
    const last = seen.length - 1
    const base = Math.min(...pending)
    for (const [index, frame] of seen.entries()) {
      if (index < last) settle(frame, base - Math.round((last - index) * frameTicks))
    }
    const final = seen[last]
    if (final !== undefined) settle(final, takeLeast(pending))
    seen = []
  }

  for (const frame of frames) {
    pending.push(frame.pts)
    if (run.lastDts === null) {
      seen.push(frame)
      if (seen.length === depth + 1) release()
    } else {
      settle(frame, takeLeast(pending))
    }
  }

  if (end) {
    release()
    if (run.waiting !== null && run.lastDts !== null) {
      const own = run.waiting.duration ?? frameTicks
      timed.push({ ...run.waiting, dts: run.lastDts, decodeDuration: Math.max(1, Math.round(own)) })
    }
    return { timed, state: startDecode(depth, frameTicks) }
  }

  const held = run.lastDts === null ? seen : run.waiting === null ? [] : [run.waiting]
  return { timed, state: { depth, frameTicks, pending, held, lastDts: run.lastDts } }
}

/**
 * What a track's SourceBuffer takes as its `timestampOffset`, in seconds (the
 * MP4 reader's `offsetSeconds`): minus its CodecDelay (RFC 9559 takes the delay
 * off every timestamp; Opus's pre-skip is one), and minus the shift that was added
 * to its decode times to keep them from being before 0 (`shiftTicks` of
 * `timescale`). It is computed from 0, so that a track with neither gets 0 and not
 * -0.
 */
export function trackOffsetSeconds(
  codecDelayNs: number,
  shiftTicks: number,
  timescale: number,
): number {
  return 0 - codecDelayNs / 1e9 - shiftTicks / timescale
}
