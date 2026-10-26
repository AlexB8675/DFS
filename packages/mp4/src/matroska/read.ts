import { codecNames } from '../codecs.ts'
import { Mp4Error } from '../errors.ts'
import { heldBytes, heldPrefix } from '../source.ts'
import type { ByteRange, Chunk, SoundOffer, Step } from '../source.ts'
import type { TrackTiming } from '../timing.ts'
import type { InitTrack } from '../write.ts'
import { findCluster, readClusters } from './clusters.ts'
import type { ClusterTrack, RawFrame } from './clusters.ts'
import { readHeader } from './ebml.ts'
import { frameSamples, sampleRate } from './frameheaders.ts'
import { readHead } from './head.ts'
import type { MatroskaHead } from './head.ts'
import { FIRST_FRAMES_BYTES, MAX_INDEX_READS, TAIL_BYTES, TRACKS_LIMIT } from './limits.ts'
import { needsKeyframe, pictureEntry, pictureMatrix, pictureSize } from './pictures.ts'
import { reorderDepth } from './reorder.ts'
import { matroskaSoundEntry, needsFirstFrame } from './sounds.ts'
import {
  decodeTimes,
  startDecode,
  toTrackTicks,
  trackOffsetSeconds,
  trackTimescale,
} from './timing.ts'
import { chooseMatroskaTracks, readTracks } from './tracks.ts'
import type { MatroskaTrack } from './tracks.ts'

// The index of a Matroska or WebM file (DESIGN.md §10.4, D45): what a player needs
// to open it, which is its picture, its sounds in the order they are preferred in,
// each with the sample entry that its init segment carries, the names that Media
// Source is asked about and its timing, and the duration. Like `chooseTracks` for
// an MP4 it is a function of the parts of the file the caller holds, and gives
// either the index or the next range of the file that it needs; each call goes
// through the file again from its start, so that it keeps no state of its own.
//
// The head (`readHead`) is the first step. The Tracks element follows, held whole.
// What Matroska leaves to the frames is read from the first Cluster: an MP4 states
// when each frame is decoded, and a Matroska file only when it is presented, so
// the picture's first frames give how far its decode runs ahead of its
// presentation (to the depth that its configuration states), and so the time
// before 0 that the decode times start at; the first frame of an AC-3 or E-AC-3
// sound makes its entry, and the first keyframe of a VP9 picture its entry. A
// megabyte is read at a time, up to 4 MiB from the first Cluster, and the reading
// stops as soon as the frames are enough. The duration is Info's, or else the end
// of the last frame of the last Cluster in the file's last megabyte.
//
// Every read the index asks for lies inside the file and is never one that the
// caller holds. The reads are counted as the head's are: for each range that the
// open needs beyond the first chunk (the head), whether it finds it held or asks
// for it, so that the count is the same however much a caller has read ahead, and
// a file that needs more than `MAX_INDEX_READS` is refused.

/** The sentences that a track's refusal begins with, as the MP4 reader's `playTrack` has them. */
const PICTURE = "The picture track can't be played: "
const SOUND = "The sound track can't be played: "

/** The most that one read of the first frames takes: 1 MiB. */
const FRAMES_READ = 1024 * 1024

/**
 * What a track is read by, which `readClusters` takes as it is (`ClusterTrack`),
 * and how its decode times start. The times are in ticks of the file's
 * TimestampScale, like the frames' own, but for `shift`, which is in ticks of the
 * track's timescale (`header.timescale`): the cursor puts a frame's decode time
 * into those ticks, and adds the shift to it.
 */
export interface MatroskaRead extends ClusterTrack {
  /** How many frames the picture's decode runs ahead of its presentation (`reorderDepth`); 0 for a sound. */
  depth: number
  /** Whether the configuration states the depth, or it is the most the codec can hold back (an H.264 SPS that leaves it out). A sound's is stated. */
  depthStated: boolean
  /** How long a frame lasts, in ticks, perhaps not a whole number: the track's DefaultDuration, else the least gap between the presentation times of its first frames, else 1. */
  frameTicks: number
  /** What is added to the decode times so that none is before 0: the least that does, in ticks of the track's timescale. For a picture it is minus the first frame's decode time, when that is before 0; for a sound, minus its first presentation time. */
  shift: number
}

/** A track that plays: what its init segment is written from, its names, where its timestamps go and how its frames are read. */
export interface MatroskaPlayTrack extends InitTrack {
  /** The names Media Source is asked about, the RFC 6381 one first (`codecNames`), and that first one. */
  codecNames: readonly string[]
  codec: string
  /** What the SourceBuffer's `timestampOffset` takes: minus the CodecDelay and the shift of the decode times. A Matroska track has no end of its own. */
  timing: TrackTiming
  /** What header stripping took from the start of every frame, and the writer puts back (empty when the track has none). */
  prefix: Uint8Array
  read: MatroskaRead
}

/** What opening a file gives. */
export interface MatroskaIndex {
  container: 'matroska'
  docType: 'matroska' | 'webm'
  /** Nanoseconds in a tick of the file's timestamps. */
  timestampScale: number
  /** Where the Segment's data starts and where it ends (the file's end when it is of unknown size or runs past it). */
  segment: { data: number; end: number }
  /** Where the first Cluster's header is. */
  firstCluster: number
  /** The Cues as the head has them: where they start, and where they end when the walk met them before the first Cluster (else null: only a SeekHead said where they are, and nothing has read there). Null when no SeekHead names them. A seek looks further. */
  cues: { start: number; end: number | null } | null
  /** The file's duration in seconds: Info's (a Duration of 0 is none, as a recording that is still being written leaves it), else the end of the last frame of the last Cluster in the last megabyte, on the file's own timeline as Info's is (no track's offset is applied); null when neither is found. */
  durationSeconds: number | null
  video: MatroskaPlayTrack
  /** Every enabled sound, in the order of preference (D45), with what the player needs to offer it or to say why it can't. */
  sounds: readonly SoundOffer[]
  /** The sound that plays (D45): the first of `sounds` when it can, else none. */
  sound: MatroskaPlayTrack | null
  /** Every sound that can play, in the order of `sounds`. */
  soundTracks: readonly MatroskaPlayTrack[]
}

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** A refusal said again after the sentence of the track it is about. */
function said(error: Mp4Error, prefix: string): Mp4Error {
  return new Mp4Error(error.reason, prefix + error.message)
}

/** What `make` gives, or the `Mp4Error` it throws said again after the sentence of the track. Anything else thrown is a bug here and stays so. */
function saying<T>(prefix: string, make: () => T): T {
  try {
    return make()
  } catch (error) {
    if (error instanceof Mp4Error) throw said(error, prefix)
    throw error
  }
}

/**
 * The reads that the open has needed so far. A read is a range of the file that
 * the open needs beyond the head (the first chunk): it counts whether the caller
 * is found to hold it or is asked for it, as the head's walk counts, and the
 * one that would be past `MAX_INDEX_READS` refuses the file.
 */
class Reads {
  private count: number
  private readonly head: number

  /** `spent` reads are the head's own; `head` is how many bytes of the file's start the first chunk holds. */
  constructor(spent: number, head: number) {
    this.count = spent
    this.head = head
  }

  charge(range: ByteRange): void {
    if (range.end <= this.head) return
    if (this.count >= MAX_INDEX_READS) {
      throw damaged(
        `Opening the file needs more than ${MAX_INDEX_READS} reads after its first bytes, which is the most that opening a file takes, so the file is refused.`,
      )
    }
    this.count += 1
  }
}

/** What the open is given and has counted, passed from one step to the next. */
interface Open {
  chunks: readonly Chunk[]
  head: MatroskaHead
  reads: Reads
}

/** The bytes of a frame, as the chunk it was found in holds them. */
function bytesOf(chunk: Chunk, frame: RawFrame): Uint8Array {
  const at = frame.offset - chunk.start
  return chunk.bytes.subarray(at, at + frame.size)
}

/** A frame as the codec reads it: what header stripping took from the start of every frame of the track put back before the bytes that are stored. */
function restored(track: MatroskaTrack, stored: Uint8Array): Uint8Array {
  if (track.stripped.length === 0) return stored
  const whole = new Uint8Array(track.stripped.length + stored.length)
  whole.set(track.stripped)
  whole.set(stored, track.stripped.length)
  return whole
}

/** The Tracks element, held whole, read, and the picture and sounds chosen from it. */
function readTrackList(
  open: Open,
): Step<{ video: MatroskaTrack; sounds: readonly MatroskaTrack[] }> {
  const { start, end } = open.head.tracks
  if (end - start > TRACKS_LIMIT) {
    throw damaged(
      `The Tracks element at offset ${start} is ${end - start} bytes, where ${TRACKS_LIMIT} are the most that one has, so the file is refused.`,
    )
  }
  open.reads.charge({ start, end })
  const bytes = heldBytes(open.chunks, start, end)
  if (bytes === null) return { need: { start, end } }
  const element = readHeader(bytes, 0, bytes.length)
  if (element === null) {
    throw damaged(`The Tracks element at offset ${start} is cut short before its header ends.`)
  }
  const { tracks, damage } = readTracks(bytes, element)
  return { done: chooseMatroskaTracks(tracks, damage) }
}

/** What a track is read by, in ticks of the file's TimestampScale (`scale` nanoseconds). A sound's frames are told apart by their own headers where a lace has no other length; a picture's are not. */
function clusterTrack(track: MatroskaTrack, scale: number): ClusterTrack {
  const rate = sampleRate(track)
  return {
    number: track.number,
    defaultDuration: track.defaultDuration === null ? null : track.defaultDuration / scale,
    lace: (frame) => {
      if (track.kind !== 'audio' || !(rate > 0)) return null
      const samples = frameSamples(track, restored(track, frame))
      return samples === null ? null : (samples * 1e9) / rate / scale
    },
  }
}

/** The frames of a track, in file order. */
function framesOf(frames: readonly RawFrame[], number: number): RawFrame[] {
  return frames.filter((frame) => frame.track === number)
}

/** The picture's frames from its first keyframe on: where the cursor starts decoding it, as a seek does. Empty when it has none. */
function fromKeyframe(frames: readonly RawFrame[]): RawFrame[] {
  const at = frames.findIndex((frame) => frame.keyframe)
  return at === -1 ? [] : frames.slice(at)
}

/** How long a frame of the track lasts, in ticks: its DefaultDuration, else the least positive gap between the presentation times of its first frames, else 1. */
function frameTicksOf(track: MatroskaTrack, scale: number, frames: readonly RawFrame[]): number {
  if (track.defaultDuration !== null) return track.defaultDuration / scale
  const times = frames.map((frame) => frame.pts).sort((a, b) => a - b)
  let least = Infinity
  for (const [at, time] of times.entries()) {
    const gap = time - (times[at - 1] ?? time)
    if (gap > 0 && gap < least) least = gap
  }
  return Number.isFinite(least) ? least : 1
}

/** A matrix of no rotation (16.16 and 2.30 fixed point, as `tkhd` has it), which a sound's header carries as it carries a size of 0. */
function identityMatrix(): Uint8Array {
  const matrix = new Uint8Array(36)
  const view = new DataView(matrix.buffer)
  view.setUint32(0, 0x10000)
  view.setUint32(16, 0x10000)
  view.setUint32(32, 0x40000000)
  return matrix
}

/** How the decode times of a track start. `shift` is in ticks of the file's TimestampScale here, and in the track's timescale once it is in the track. */
interface Start {
  depth: number
  depthStated: boolean
  frameTicks: number
  shift: number
}

/** A track that plays, from its entry and how its decode times start. The names are read from the entry, and a configuration they can't be read from is the `Mp4Error` of the track. */
function playTrack(
  head: MatroskaHead,
  track: MatroskaTrack,
  entry: Uint8Array,
  starts: Start,
): MatroskaPlayTrack {
  const type = String.fromCharCode(...entry.subarray(4, 8))
  const names = codecNames({ type, bytes: entry, stsdVersion: 0 })
  const scale = head.timestampScale
  const timescale = trackTimescale(scale)
  const shift = toTrackTicks(starts.shift, scale)
  const picture = track.kind === 'video'
  return {
    header: {
      id: track.number,
      kind: picture ? 'video' : 'audio',
      timescale,
      language: track.language,
      ...(picture ? pictureSize(track) : { width: 0, height: 0 }),
      matrix: picture ? pictureMatrix(track) : identityMatrix(),
    },
    entry,
    codecNames: names,
    codec: names[0],
    timing: {
      offsetSeconds: trackOffsetSeconds(track.codecDelay, shift, timescale),
      endSeconds: null,
    },
    prefix: track.stripped,
    read: { ...clusterTrack(track, scale), ...starts, shift },
  }
}

/** A sound that is a candidate to play, once what can be told of it from its track is: its entry when that doesn't wait for a frame, or why it can't play. */
interface Candidate {
  track: MatroskaTrack
  entry: Uint8Array | null
  refusal: Mp4Error | null
}

/** Each sound track in its place, with its entry if the track alone gives it and the reason if the track alone rules it out (a track that couldn't be read or can't be played, whose number is another's, or whose entry can't be made), so that the frames that are waited for are the ones of sounds that may play. */
function candidatesOf(video: MatroskaTrack, sounds: readonly MatroskaTrack[]): Candidate[] {
  const taken = new Set([video.number])
  return sounds.map((track): Candidate => {
    if (track.problem !== null) {
      return { track, entry: null, refusal: damaged(SOUND + track.problem) }
    }
    if (track.refusal !== null) return { track, entry: null, refusal: said(track.refusal, SOUND) }
    if (taken.has(track.number)) {
      return {
        track,
        entry: null,
        refusal: damaged(
          `${SOUND}its TrackNumber, ${track.number}, is another track's, so the frames of the two could not be told apart.`,
        ),
      }
    }
    taken.add(track.number)
    if (needsFirstFrame(track)) return { track, entry: null, refusal: null }
    try {
      return { track, entry: matroskaSoundEntry(track, null), refusal: null }
    } catch (error) {
      if (error instanceof Mp4Error) return { track, entry: null, refusal: said(error, SOUND) }
      throw error
    }
  })
}

/** The frames from the first Cluster, as far as the open has read them, in a chunk that starts at the Cluster. */
interface FirstFrames {
  chunk: Chunk
  frames: RawFrame[]
}

/**
 * The frames of `tracks` from the first Cluster, read a megabyte at a time until
 * `enough` says they are, up to `FIRST_FRAMES_BYTES` from the Cluster (or the
 * Segment's end), where the open goes on with what it has. The reading goes by
 * windows of a megabyte from where the head ends (or from the first Cluster, when
 * the head ends before it), each one a read whether it is held or asked for, and
 * each time the frames are read again from the first Cluster over what the windows
 * so far hold, so that a caller that has read ahead is given the same index as one
 * that has read what was asked for.
 */
function readFirstFrames(
  open: Open,
  tracks: readonly ClusterTrack[],
  enough: (frames: readonly RawFrame[]) => boolean,
): Step<FirstFrames> {
  const { chunks, head, reads } = open
  const origin = head.firstCluster
  const bound = Math.min(origin + FIRST_FRAMES_BYTES, head.segment.end)
  let reach = Math.min(bound, Math.max(origin, chunks[0]?.bytes.length ?? 0))
  for (;;) {
    const chunk = { start: origin, bytes: heldPrefix(chunks, origin, reach) }
    const { frames } = readClusters(chunk, origin, null, false, head.segment.end, tracks)
    if (reach >= bound || enough(frames)) return { done: { chunk, frames } }

    const window = { start: reach, end: Math.min(reach + FRAMES_READ, bound) }
    reads.charge(window)
    if (heldBytes(chunks, window.start, window.end) === null) return { need: window }
    reach = window.end
  }
}

/**
 * The end of the last frame of the last Cluster in the file's last megabyte, in
 * ticks (a frame with no length of its own lasts what its track's frames do), or
 * null when the megabyte holds no Cluster. The read is not before the first
 * Cluster, and is one read.
 */
function readLastEnd(open: Open, tracks: readonly { read: MatroskaRead }[]): Step<number | null> {
  const { chunks, head, reads } = open
  const range = {
    start: Math.max(head.segment.end - TAIL_BYTES, head.firstCluster),
    end: head.segment.end,
  }
  reads.charge(range)
  const bytes = heldBytes(chunks, range.start, range.end)
  if (bytes === null) return { need: range }

  const tail = { start: range.start, bytes }
  let last: number | null = null
  for (let from = range.start; ;) {
    const found = findCluster(tail, from, head.segment.end)
    if (found === null) break
    last = found.start
    from = found.start + 1
  }
  if (last === null) return { done: null }

  const { frames } = readClusters(
    tail,
    last,
    null,
    false,
    head.segment.end,
    tracks.map((track) => track.read),
  )
  const lengths = new Map(tracks.map((track) => [track.read.number, track.read.frameTicks]))
  let end: number | null = null
  for (const frame of frames) {
    const reach = frame.pts + Math.round(frame.duration ?? lengths.get(frame.track) ?? 1)
    if (end === null || reach > end) end = reach
  }
  return { done: end }
}

/**
 * Opens the file of `fileSize` bytes from the chunks the caller holds, the first
 * of which starts at 0 (the head, a megabyte as for an MP4): gives the index, or
 * the next range of the file that it needs, which the caller reads, adds as a
 * chunk and calls again with them all.
 *
 * - The picture is the first enabled picture track; a track that can't be read or can't be played, a keyframe that is not in the first 4 MiB of clusters, or an entry or names that can't be made is `Mp4Error`, said after "The picture track can't be played: " (a file with no picture is `no-picture`). Its entry is made from the first keyframe when the codec leaves its configuration to the frame (VP9 with a CodecPrivate that lacks it).
 * - The sounds are every enabled sound track, the one flagged default first (D45), each an offer: the names it plays by, or the refusal that says, after "The sound track can't be played: ", why it can't. The first plays when it can; the others are there to choose. A sound that is made from its first frame (AC-3, E-AC-3) is `damaged` when the first 4 MiB of clusters hold none.
 * - Each track has the shift of its decode times and the offset of its timestamps: a picture that reorders is decoded before it is presented, so its first decode time is before 0 by as many frames as its depth.
 * - The duration is Info's, else the end of the last frame in the last megabyte; null when it has none.
 *
 * A file that is not a Matroska or WebM one of a version this reader knows, or whose open would need more than `MAX_INDEX_READS` reads after the head, is `damaged`.
 */
export function readMatroska(chunks: readonly Chunk[], fileSize: number): Step<MatroskaIndex> {
  const headed = readHead(chunks, fileSize)
  if ('need' in headed) return headed
  const head = headed.done
  const open: Open = {
    chunks,
    head,
    reads: new Reads(head.reads, chunks[0]?.bytes.length ?? 0),
  }
  const scale = head.timestampScale

  const listed = readTrackList(open)
  if ('need' in listed) return listed
  const { video, sounds } = listed.done

  // What the tracks alone say, before a frame is read: a picture that can't play refuses the file now, and a sound that can't is out of the frames that are waited for.
  if (video.problem !== null) throw damaged(PICTURE + video.problem)
  if (video.refusal !== null) throw said(video.refusal, PICTURE)
  const { depth, stated } = saying(PICTURE, () => reorderDepth(video))
  const keyframeNeeded = needsKeyframe(video)
  const earlyEntry = keyframeNeeded ? null : saying(PICTURE, () => pictureEntry(video, null))
  const candidates = candidatesOf(video, sounds)

  // The frames are enough once the picture has a keyframe and as many frames from it as its decode runs ahead by (and one, at least, after the keyframe), and every sound that may play has a frame.
  const wanted = [
    clusterTrack(video, scale),
    ...candidates
      .filter((candidate) => candidate.refusal === null)
      .map((candidate) => clusterTrack(candidate.track, scale)),
  ]
  const framesNeeded = Math.max(depth + 1, 2)
  const first = readFirstFrames(open, wanted, (frames) => {
    const started = fromKeyframe(framesOf(frames, video.number))
    return (
      started.length >= framesNeeded &&
      candidates.every(
        (candidate) =>
          candidate.refusal !== null ||
          frames.some((frame) => frame.track === candidate.track.number),
      )
    )
  })
  if ('need' in first) return first
  const { chunk, frames } = first.done

  // The picture.
  const started = fromKeyframe(framesOf(frames, video.number))
  const keyframe = started[0]
  if (keyframe === undefined) {
    throw damaged(
      `${PICTURE}it has no keyframe in the first 4 MiB of clusters, which it is decoded from.`,
    )
  }
  const pictureTicks = frameTicksOf(video, scale, started)
  // The shift is minus the first frame's decode time, which the cursor gives as the
  // least presentation time of the first depth + 1 frames less depth frames' length.
  // When the file has fewer than that (it ends, or the 4 MiB do) the frames seen are
  // all there are for `decodeTimes`, and that is exact for a file that ends. When the
  // read ended at its bound with more of the Segment behind it, the frames that are
  // not seen may be presented before the least seen, by up to depth frames (a leading
  // picture of an open GOP is within the reorder window), so the least of the 16 can
  // be that much lower, and the first decode time depth frames below that: the shift
  // is 2 x depth frames and 1 tick below the least seen, which no stream of that depth
  // goes under. A shift that is too large only delays the timeline, which the offset
  // takes back.
  let pictureShift: number
  if (started.length < depth + 1 && head.firstCluster + FIRST_FRAMES_BYTES < head.segment.end) {
    const least = Math.min(...started.map((frame) => frame.pts))
    pictureShift = Math.max(0, Math.round(2 * depth * pictureTicks) + 1 - least)
  } else {
    const decoded = decodeTimes(startDecode(depth, pictureTicks), started, true).timed
    pictureShift = Math.max(0, -(decoded[0]?.dts ?? 0))
  }
  const pictureStart = { depth, depthStated: stated, frameTicks: pictureTicks, shift: pictureShift }
  const picture = saying(PICTURE, () =>
    playTrack(
      head,
      video,
      earlyEntry ?? pictureEntry(video, restored(video, bytesOf(chunk, keyframe))),
      pictureStart,
    ),
  )

  // The sounds, in order.
  const offers: SoundOffer[] = []
  const soundTracks: MatroskaPlayTrack[] = []
  for (const candidate of candidates) {
    const { track } = candidate
    let played: MatroskaPlayTrack | Mp4Error
    if (candidate.refusal !== null) {
      played = candidate.refusal
    } else {
      try {
        const mine = framesOf(frames, track.number)
        const firstFrame = mine[0]
        let entry = candidate.entry
        if (entry === null) {
          if (firstFrame === undefined) {
            throw damaged(
              `its configuration is made from its first frame, and there is no frame of the track in the first 4 MiB of clusters.`,
            )
          }
          entry = matroskaSoundEntry(track, restored(track, bytesOf(chunk, firstFrame)))
        }
        played = playTrack(head, track, entry, {
          depth: 0,
          depthStated: true,
          frameTicks: frameTicksOf(track, scale, mine),
          shift: Math.max(0, -(firstFrame?.pts ?? 0)),
        })
      } catch (error) {
        if (!(error instanceof Mp4Error)) throw error
        played = said(error, SOUND)
      }
    }
    if (played instanceof Mp4Error) {
      offers.push({ id: track.number, language: track.language, refusal: played })
    } else {
      offers.push({
        id: track.number,
        language: track.language,
        codecNames: played.codecNames,
        codec: played.codec,
      })
      soundTracks.push(played)
    }
  }
  const firstOffer = offers[0]
  const sound =
    firstOffer !== undefined && !('refusal' in firstOffer) ? (soundTracks[0] ?? null) : null

  // The duration.
  let durationSeconds: number | null = null
  if (head.durationTicks !== null && head.durationTicks > 0) {
    durationSeconds = (head.durationTicks * scale) / 1e9
  } else {
    const last = readLastEnd(open, [picture, ...soundTracks])
    if ('need' in last) return last
    if (last.done !== null) durationSeconds = (last.done * scale) / 1e9
  }

  return {
    done: {
      container: 'matroska',
      docType: head.docType,
      timestampScale: scale,
      segment: head.segment,
      firstCluster: head.firstCluster,
      cues: head.cues,
      durationSeconds,
      video: picture,
      sounds: offers,
      sound,
      soundTracks,
    },
  }
}
