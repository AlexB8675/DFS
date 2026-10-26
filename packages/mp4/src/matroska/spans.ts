import { Mp4Error } from '../errors.ts'
import type { FrameTable } from '../frames.ts'
import type { ByteRange, Chunk } from '../source.ts'
import type { FragmentTrack } from '../write.ts'
import { readClusters } from './clusters.ts'
import type { ClusterPlace, RawFrame } from './clusters.ts'
import type { MatroskaIndex, MatroskaPlayTrack } from './read.ts'
import { decodeTimes, startDecode, toTrackTicks } from './timing.ts'
import type { DecodeState, TimedFrame } from './timing.ts'

// The frames of a span of a Matroska file, as the tables the writer takes (DESIGN.md
// §10.4, D45). The player's engine reads a file span by span, and each span is one
// call: the cursor says where the last one stopped, `readClusters` finds the frames
// of the picture and of the sound in the chunk, `decodeTimes` gives them the times
// that Matroska leaves out (it stores only when a frame is presented), and what
// comes out is a table of frames for each track, in decode order, that `fragment`
// writes as it is, and the cursor to go on with. A frame is given out once its decode
// time and the next one's are known, so the last frame of a span is held in the
// cursor until the next span, whose chunk need not hold its bytes: the table has
// only where they are in the file, and the engine reads them when it writes.
//
// What a span restarts. A cursor made for a start (the file's, or a seek's) has not
// started its picture: its frames wait for a keyframe, as the index counted from the
// first one, and those before it are left out. A file's damage (`readClusters` skips
// a stretch of it) does the same to the picture's frames after it, which can't be
// decoded without what was skipped: its decode state starts again and it waits for a
// keyframe. The frames before the skip are whole, so they all come out, those held
// for the next frame's decode time with a duration of their own (as at the Segment's
// end). The sound's frames each stand alone, and its state goes on over the gap, the
// frame before it lasting to the one after.
//
// The tables are in the track's timescale (`trackTimescale`). A frame's decode time
// is the file's with the track's shift added (the index's, so that none is before
// 0), and its composition offset is its presentation time less its decode time
// before the shift, so that the player's `timestampOffset` takes the shift back from
// both. A value that a table can't hold (the typed arrays wrap what they can't hold
// without a word) is a damaged file and refused, and so is a time before 0 after the
// shift, which only a span of frames that the index was not made from can give.

/** What a call of `matroskaFrames` carries from one span to the next. */
export interface MatroskaCursor {
  container: 'matroska'
  /** Where reading goes on in the file, and the cluster that offset is inside, if any (see `readClusters`). */
  at: number
  cluster: ClusterPlace | null
  /** True while a search for a cluster, after damage, is under way. */
  searching: boolean
  /** True once the Segment's end is reached and every frame held has been given out. */
  ended: boolean
  /** The id of the sound that plays, or null for none. */
  sound: number | null
  /** The decode states of the picture and of the sound. */
  picture: DecodeState
  audio: DecodeState | null
  /** False until a keyframe of the picture is seen after a start or a skip: the frames before it are left out. */
  pictureStarted: boolean
}

/** The most that a 32-bit field of a table holds, unsigned and signed. */
const MAX_UINT32 = 0xffffffff
const MIN_INT32 = -(2 ** 31)
const MAX_INT32 = 2 ** 31 - 1

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** The sound with this id among those that play, null for none; an id that is not one is a RangeError, which only a caller that miscounted gives. */
function chosenSound(index: MatroskaIndex, id: number | null): MatroskaPlayTrack | null {
  if (id === null) return null
  const track = index.soundTracks.find((one) => one.header.id === id)
  if (track === undefined) {
    throw new RangeError(`${id} is not the id of a sound that plays in this file.`)
  }
  return track
}

/**
 * A cursor at the start of the file, for the sound with this id (one of
 * `index.soundTracks`, which need not be the one that `index.sound` says plays
 * first), or for none. The decode states are fresh, at the picture's depth and
 * frame length and at the sound's; the picture has not started, so its first frames
 * wait for a keyframe. An id that is no sound of the index is a RangeError.
 */
export function matroskaStart(index: MatroskaIndex, sound: number | null): MatroskaCursor {
  const track = chosenSound(index, sound)
  const { depth, frameTicks } = index.video.read
  return {
    container: 'matroska',
    at: index.firstCluster,
    cluster: null,
    searching: false,
    ended: false,
    sound,
    picture: startDecode(depth, frameTicks),
    audio: track === null ? null : startDecode(0, track.read.frameTicks),
    pictureStarted: false,
  }
}

/** The ranges with those that touch or overlap joined, in order, as new ranges. */
function joined(ranges: readonly ByteRange[]): ByteRange[] {
  const out: ByteRange[] = []
  for (const range of ranges) {
    const last = out[out.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else out.push({ start: range.start, end: range.end })
  }
  return out
}

/** Whether a number is one that the writer's tables hold exactly. */
function whole(value: number): boolean {
  return Number.isSafeInteger(value)
}

/**
 * The table of a track's timed frames: the times in the track's timescale, the
 * decode time with the track's shift added, and the bytes as the file stores them.
 * Every number is checked against the field it goes in before it is written, for a
 * typed array wraps what it can't hold without a word.
 */
function tableOf(
  index: MatroskaIndex,
  track: MatroskaPlayTrack,
  timed: readonly TimedFrame[],
): FrameTable {
  const scale = index.timestampScale
  const { timescale } = track.header
  const { shift } = track.read
  const what = track.header.kind === 'video' ? 'picture' : 'sound'
  const count = timed.length
  const table: FrameTable = {
    count,
    timescale,
    offsets: new Float64Array(count),
    sizes: new Uint32Array(count),
    dts: new Float64Array(count),
    durations: new Uint32Array(count),
    cts: new Int32Array(count),
    sync: new Uint8Array(count),
  }

  for (const [at, frame] of timed.entries()) {
    const own = `The ${what} track's frame at offset ${frame.offset}`
    const decoded = toTrackTicks(frame.dts, scale)
    const dts = decoded + shift
    const cts = toTrackTicks(frame.pts, scale) - decoded
    const duration = toTrackTicks(frame.decodeDuration, scale)
    if (![dts, cts, duration, frame.offset, frame.size].every(whole)) {
      throw damaged(
        `${own} has a time or a place that is not a whole number that a table holds exactly (its decode time is ${dts}, its composition offset ${cts}, its duration ${duration}).`,
      )
    }
    if (dts < 0) {
      throw damaged(
        `${own} is decoded at ${dts} in ticks of 1/${timescale} of a second, before 0, though the index shifted the track's times by ${shift}: the span starts earlier than the frames the index was made from.`,
      )
    }
    if (cts < MIN_INT32 || cts > MAX_INT32) {
      throw damaged(
        `${own} has a composition offset of ${cts} ticks of 1/${timescale} of a second, which a fragment's 32 bits do not hold.`,
      )
    }
    if (duration < 1 || duration > MAX_UINT32) {
      throw damaged(
        `${own} has a duration of ${duration} ticks of 1/${timescale} of a second, which a fragment's 32 bits do not hold.`,
      )
    }
    if (frame.size > MAX_UINT32) {
      throw damaged(`${own} is ${frame.size} bytes, which a fragment's 32 bits do not hold.`)
    }
    table.offsets[at] = frame.offset
    table.sizes[at] = frame.size
    table.dts[at] = dts
    table.durations[at] = duration
    table.cts[at] = cts
    table.sync[at] = frame.keyframe ? 1 : 0
  }
  return table
}

/** The track as the writer takes it: its id, the table, and what header stripping took from the start of every frame. */
function fragmentTrack(
  index: MatroskaIndex,
  track: MatroskaPlayTrack,
  timed: readonly TimedFrame[],
): FragmentTrack | null {
  if (timed.length === 0) return null
  return {
    header: { id: track.header.id },
    table: tableOf(index, track, timed),
    prefix: track.prefix,
  }
}

/**
 * Turns the part of the file in `chunk` that the cursor reaches into the frames of
 * the picture and of the chosen sound that it completes, and says where to go on.
 * The chunk must hold the cursor's `at` (it may end there); one that does not is a
 * RangeError, the caller's miscount. The cursor given is never changed: a new one is
 * returned.
 *
 * - `frames` lists the picture first and then the sound, in decode order, and leaves
 *   out a track that has no frame to give. A frame comes out once its decode time and
 *   the next one's are known; the frames still waiting are in the returned cursor,
 *   and their bytes may lie in a chunk the caller no longer holds (the table has only
 *   offsets, and the engine reads the bytes of a frame when it writes it). At the
 *   Segment's end (`cursor.ended`) everything held comes out.
 * - A cursor whose picture has not started drops the picture's frames before its
 *   first keyframe; the sound's are kept from where the cursor is.
 * - `skipped` lists the stretches of the file that were damaged and passed over, in
 *   order and joined where they touch. The picture's frames before a skip all come
 *   out, those held among them with a duration of their own, as at the Segment's end;
 *   after it the picture restarts as after a seek: its decode state is fresh and it
 *   waits for a keyframe. The sound goes on over it.
 * - When the chunk ends before the next element is whole, nothing is read and the
 *   cursor comes back at the same `at`: the caller reads a bigger chunk from `at` and
 *   calls again, and the engine doubles its read until the cursor moves. The size
 *   that a block claims is not bounded here: a block of a track asked for must be
 *   whole in the chunk, so a block that claims more than the file holds is waited for
 *   to the file's end, which is for the engine's read to cap.
 *
 * A time that a table can't hold, or a decode time before 0 after the track's shift (a
 * span of frames that the index was not made from), is `damaged`.
 */
export function matroskaFrames(
  index: MatroskaIndex,
  cursor: MatroskaCursor,
  chunk: Chunk,
): { frames: FragmentTrack[]; cursor: MatroskaCursor; skipped: ByteRange[] } {
  const sound = chosenSound(index, cursor.sound)
  if ((sound === null) !== (cursor.audio === null)) {
    throw new RangeError(
      `The cursor's sound, ${cursor.sound}, and its decode state do not go together.`,
    )
  }
  const { video } = index
  const read = readClusters(
    chunk,
    cursor.at,
    cursor.cluster,
    cursor.searching,
    index.segment.end,
    sound === null ? [video.read] : [video.read, sound.read],
  )
  const skipped = joined(read.skipped)

  // The picture, in pieces: the frames before each skip go to the state as it is, and
  // the skip starts it again.
  const pictureFrames = read.frames.filter((frame) => frame.track === video.read.number)
  const pictureTimed: TimedFrame[] = []
  let picture = cursor.picture
  let started = cursor.pictureStarted
  const feed = (frames: readonly RawFrame[], end: boolean): void => {
    let usable = frames
    if (!started) {
      const first = frames.findIndex((frame) => frame.keyframe)
      usable = first === -1 ? [] : frames.slice(first)
      started = first !== -1
    }
    const done = decodeTimes(picture, usable, end)
    pictureTimed.push(...done.timed)
    picture = done.state
  }
  let piece: RawFrame[] = []
  let skips = 0
  /** Ends the piece before the next skip: its frames go to the state as at the Segment's end, so that those it held come out (they are whole, and wait only for the decode time of a next frame that the damage takes), and the state that comes back is a fresh start, as the skip needs; the picture then waits for a keyframe. */
  const restart = (): void => {
    feed(piece, true)
    piece = []
    started = false
    skips += 1
  }
  for (const frame of pictureFrames) {
    while (frame.offset >= (skipped[skips]?.start ?? Infinity)) restart()
    piece.push(frame)
  }
  while (skips < skipped.length) restart()
  feed(piece, read.ended)

  // The sound, which goes on over a skip.
  let audio = cursor.audio
  let soundTimed: TimedFrame[] = []
  if (sound !== null && audio !== null) {
    const frames = read.frames.filter((frame) => frame.track === sound.read.number)
    const done = decodeTimes(audio, frames, read.ended)
    soundTimed = done.timed
    audio = done.state
  }

  const frames: FragmentTrack[] = []
  const pictureTrack = fragmentTrack(index, video, pictureTimed)
  if (pictureTrack !== null) frames.push(pictureTrack)
  const soundTrack = sound === null ? null : fragmentTrack(index, sound, soundTimed)
  if (soundTrack !== null) frames.push(soundTrack)

  return {
    frames,
    cursor: {
      container: 'matroska',
      at: read.next,
      cluster: read.cluster === null ? null : { ...read.cluster },
      searching: read.searching,
      ended: read.ended,
      sound: cursor.sound,
      picture,
      audio,
      pictureStarted: started,
    },
    skipped,
  }
}
