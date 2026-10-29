import { Mp4Error } from '../errors.ts'
import { heldBytes } from '../source.ts'
import type { ByteRange, Chunk, Step } from '../source.ts'
import { findCluster, readClusters } from './clusters.ts'
import type { ClusterPlace, ClusterRead } from './clusters.ts'
import { readHeader, readUint, walkChildren } from './ebml.ts'
import type { Element } from './ebml.ts'
import { covers } from './head.ts'
import { ID, TOP_LEVEL } from './ids.ts'
import {
  CUES_LIMIT,
  FIRST_FRAMES_BYTES,
  HEADER_READ,
  MAX_CUE_FIELDS,
  MAX_CUE_POINTS,
  MAX_SEEK_READS,
  SEARCH_READ,
  TAIL_BYTES,
} from './limits.ts'
import type { MatroskaIndex } from './read.ts'
import { matroskaStart } from './spans.ts'
import type { MatroskaCursor } from './spans.ts'

// Seeking in a Matroska or WebM file (DESIGN.md §10.4, D45): given a time, where
// to start reading so that the picture starts at a keyframe at or before it, which
// is the cursor that `matroskaFrames` plays from. Like the index and the head it is
// a function of the parts of the file the caller holds, and gives either the cursor
// or the next range of the file that it needs, which the caller reads, adds as a
// chunk and asks again with; each call goes through the seek again from its start,
// so that it keeps no state of its own.
//
// By the Cues when the file has them. The Cues are the file's index of its
// keyframes: a point is a time and where the cluster is, and often the block in it.
// They are read once, whole, from where the index says (the head met them before
// the first Cluster, or only a SeekHead names the place, and then the header is read
// first, since the entry may be stale), or else from the last megabyte of the Segment,
// where writers put them, as the Cues element that ends where the Segment does or
// where another of its own elements starts. A point is trusted no further than the
// bytes it names: its cluster must be there, and the picture's first keyframe from
// the block (or the cluster) must be presented no later than the time, else the
// point before it is used, for a writer may date a cue by its cluster and not by the
// keyframe in it. With no point before it (the time is before the first, or the first
// is the one that lies) the seek goes to the file's first cluster, which is at or
// before any time, unless the point's own cluster is it.
//
// By a search of the clusters when it has none (a recording that was cut off, one
// written as it was shot, Cues too long to read). It starts at the file's first
// cluster, whose header says when it is presented and, if its size was written, how
// long it is; a time at or before it is the first cluster's, and the search ends
// there. Else the Segment is narrowed by guesses: each reads forward from an offset
// and takes the first cluster in the read, whose Timestamp says which side of it the
// time is. The first read of a guess is as long as the first cluster, or the read
// that last found a cluster (the clusters of one file are alike; 256 KiB at least),
// and a guess that finds none (a cluster is longer than a read, as a cluster of a
// recording at an ordinary bitrate is) goes on reading forward, each read twice the
// one before up to 4 MiB, until it finds one or reaches the end of the range. No
// guess is inside a cluster whose size is known, for none starts there. A guess is
// made by time where the file says the time of its end (the last cluster, which the
// open found when Info has no Duration, else the duration), on the line between the
// two clusters that bound the range, and by the byte, in the middle, where it cannot
// and at least every second guess, so that a file of any shape costs no more than
// twice a bisection's guesses. When what is left is no more than about two clusters
// (twice the longest distance from a guess to the cluster it found, or a cluster's
// length, at least a read and at most 4 MiB), it is read at once, from the last
// cluster at or before the time to where no cluster starts, and the clusters in that
// read are the candidates: the latest of them that holds a keyframe at or before the
// time is where reading starts. When none does, the search is made again for a
// cluster before the first of them. A file with no such cluster is read from its
// first. Cues too long to read that run to the Segment's end are left out of the
// range, for no cluster is in them.
//
// A keyframe is looked for in the bytes read, and a picture block that the bytes
// stop short of is read whole, from where they start to its end, in one more read
// (its header says how long it is), when that is no more than `FIRST_FRAMES_BYTES`
// (a keyframe of 4K can be a megabyte); a SimpleBlock longer than that is judged by
// its first bytes, which say its track, its time and whether it is a keyframe.
//
// Every read is counted as the head's and the index's are (`MAX_SEEK_READS`): for
// each range the seek needs that it has not needed already, whether it finds it held
// or asks for it, so that the count (and with it the cursor) is the same however
// much a caller has read ahead. A seek that would need another stops at the first
// cluster, which is always at or before the time. Every window the seek reads is a
// fixed one, from a place the walk has found to a number of bytes it chooses
// (`HEADER_READ`, `SEARCH_READ`, the whole Cues, the last `TAIL_BYTES`), cut at the
// Segment's end, and every decision is made from those bytes and no others. What a
// search learns of the clusters (how long a read to start a guess with, how far a
// guess is from a cluster) is learned in the walk, from the bytes it has taken, and
// is not kept from one call to the next.

/** One point of the Cues for a track: a keyframe's time in ticks, where the cluster that holds it starts in the file, and where its block is counted from the cluster's data (null when the point has no CueRelativePosition). */
export interface CuePoint {
  time: number
  cluster: number
  relative: number | null
}

/** The most that the header of an element takes: an ID of 4 bytes and a size of 8. */
const MAX_HEADER = 12

/** The bytes of a Cues element's ID. */
const CUES_ID = [0x1c, 0x53, 0xbb, 0x6b]

/** The elements that a cluster's frames are in. */
const BLOCKS: ReadonlySet<number> = new Set<number>([ID.SimpleBlock, ID.BlockGroup])

/** The CueTrack, CueClusterPosition and CueRelativePosition of a CueTrackPositions of `track`; undefined for another track's or one with no position. */
function positionsOf(
  bytes: Uint8Array,
  positions: Element,
  track: number,
): { cluster: number; relative: number | null } | undefined {
  let which: number | undefined
  let cluster: number | undefined
  let relative: number | undefined
  for (const field of walkChildren(bytes, positions, MAX_CUE_FIELDS)) {
    if (field.id === ID.CueTrack) which ??= readUint(bytes, field)
    else if (field.id === ID.CueClusterPosition) cluster ??= readUint(bytes, field)
    else if (field.id === ID.CueRelativePosition) relative ??= readUint(bytes, field)
  }
  return which === track && cluster !== undefined
    ? { cluster, relative: relative ?? null }
    : undefined
}

/**
 * The points of a Cues element for the picture's `track`, in order of time (those
 * of one time as they came). `cues` is the element in `bytes`, which hold it
 * whole, and `base` is where `bytes` start in the file; the positions are counted
 * from `segmentData`, where the Segment's data starts, and come out as offsets in
 * the file. A CuePoint with no CueTime, none of its CueTrackPositions for the track
 * or no CueClusterPosition in that one is left out, and so is a position at or past
 * `segmentEnd` (there is no cluster there). Children that do not walk (one that
 * claims more than its parent has, or a number wider than a number is) are a
 * damaged file, the sentence of which says where the Cues are. The walk is lazy,
 * a header at a time, and bounded by count: Cues of more than `MAX_CUE_POINTS`
 * children, or a CuePoint or a CueTrackPositions of more than `MAX_CUE_FIELDS`,
 * are damaged too, so that children of a few bytes each, which each step of a seek
 * walks again, cost no more than the bound. The points are never cut short at it:
 * a seek by points that stop early would land far too early, so the seek that
 * gets the damage searches the clusters instead.
 */
export function readCues(
  bytes: Uint8Array,
  cues: Element,
  base: number,
  segmentData: number,
  track: number,
  segmentEnd = Infinity,
): CuePoint[] {
  const found: CuePoint[] = []
  try {
    for (const point of walkChildren(bytes, cues, MAX_CUE_POINTS)) {
      if (point.id !== ID.CuePoint) continue
      let time: number | undefined
      let place: { cluster: number; relative: number | null } | undefined
      for (const field of walkChildren(bytes, point, MAX_CUE_FIELDS)) {
        if (field.id === ID.CueTime) time ??= readUint(bytes, field)
        else if (field.id === ID.CueTrackPositions) place ??= positionsOf(bytes, field, track)
      }
      if (time === undefined || place === undefined) continue
      const cluster = segmentData + place.cluster
      if (!Number.isSafeInteger(cluster) || cluster >= segmentEnd) continue
      found.push({ time, cluster, relative: place.relative })
    }
  } catch (error) {
    if (!(error instanceof Mp4Error)) throw error
    throw new Mp4Error(
      error.reason,
      `The Cues element at offset ${base + cues.start} can't be read: ${error.message}`,
    )
  }
  return found.sort((a, b) => a.time - b.time)
}

/** The seek lacks bytes: thrown from where it finds that out, and caught by `matroskaSeek`, so that the walk reads straight on. It never leaves this module. */
class Need extends Error {
  readonly range: ByteRange

  constructor(range: ByteRange) {
    super(`The seek needs the bytes from ${range.start} to ${range.end}.`)
    this.range = range
  }
}

/** The seek has needed `MAX_SEEK_READS` reads and needs another: it stops. It never leaves this module. */
class Capped extends Error {
  constructor() {
    super(`The seek has needed ${MAX_SEEK_READS} reads, which is the most that one takes.`)
  }
}

/** Where a seek goes: where reading starts, and the cluster that offset is inside, if the seek has read its header. */
interface Landing {
  at: number
  cluster: ClusterPlace | null
}

/** The header of the element at `at` in `bytes`, or null when it is not whole there or is no header at all. */
function headerAt(bytes: Uint8Array, at = 0): Element | null {
  try {
    return readHeader(bytes, at, bytes.length)
  } catch (error) {
    if (error instanceof Mp4Error) return null
    throw error
  }
}

/** The header of the Cues element at `at` in `bytes` when it is one of a known size (it may reach past the bytes), else null. */
function cuesHeader(bytes: Uint8Array, at = 0): Element | null {
  const el = headerAt(bytes, at)
  return el !== null && el.id === ID.Cues && el.sized ? el : null
}

/** A cluster that bounds a search: where it starts, when it is presented in seconds on the playback timeline (null when that is not known), and where it ends when its size says (no cluster starts inside it; else null). */
interface Anchor {
  at: number
  seconds: number | null
  end: number | null
}

/** A picture keyframe that a seek has found: when it is presented in ticks, and where. */
interface Key {
  pts: number
  offset: number
}

/** What the first bytes of a SimpleBlock say: its track, its time from its cluster's, and whether it is a keyframe. */
interface BlockHead {
  track: number
  timecode: number
  keyframe: boolean
}

/** A block of the picture that the bytes stop short of: where it starts and ends in the file, the cluster it is in, and for a SimpleBlock whose first bytes are held, what they say. */
interface Cut {
  at: number
  end: number
  place: ClusterPlace
  head: BlockHead | null
}

/** The track, the time and the flags of the SimpleBlock whose header is `el` in `bytes`; null when the bytes end first. */
function blockHead(bytes: Uint8Array, el: Element): BlockHead | null {
  const first = bytes[el.data]
  if (first === undefined || first === 0) return null
  const width = Math.clz32(first) - 23
  const flags = el.data + width + 2
  if (flags >= bytes.length) return null
  let track = first & (0xff >> width)
  for (let at = el.data + 1; at < el.data + width; at += 1) track = track * 256 + (bytes[at] ?? 0)
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.data + width, 2)
  return { track, timecode: view.getInt16(0), keyframe: ((bytes[flags] ?? 0) & 0x80) !== 0 }
}

/**
 * The block that a `readClusters` over `bytes` (starting at `base` in the file)
 * stopped at because the bytes end before it does: its end is read from its header.
 * Null when the read went to the end of the bytes, or stopped at something else
 * (the header of an element is cut by the bytes' end too, and says nothing).
 */
function cutOf(read: ClusterRead, bytes: Uint8Array, base: number): Cut | null {
  const at = read.next - base
  if (read.cluster === null || read.searching || at < 0 || at >= bytes.length) return null
  const el = headerAt(bytes, at)
  if (el === null || !el.sized || !BLOCKS.has(el.id) || el.end <= bytes.length) return null
  return {
    at: read.next,
    end: base + el.end,
    place: read.cluster,
    head: el.id === ID.SimpleBlock ? blockHead(bytes, el) : null,
  }
}

/** One seek, from the beginning. */
class Seeking {
  private reads = 0
  /** The ranges the seek has needed so far. */
  private readonly covered: ByteRange[] = []
  private readonly index: MatroskaIndex
  private readonly seconds: number
  private readonly chunks: readonly Chunk[]
  /** Where the clusters can end: the Segment's end, or the start of a Cues element that is too long to be read and runs to it (a search is then made without it). */
  private clusters: number
  /** The picture's CodecDelay in seconds, which RFC 9559 takes off every timestamp. The index's offset is that and the shift of the decode times, which presents nothing earlier. */
  private readonly delay: number
  /** The size of the first read of a guess of the search: `SEARCH_READ`, then the size of the read that last found a cluster in this seek (the clusters of one file are alike). */
  private firstRead = SEARCH_READ
  /** The longest distance that the search has seen from a guess to the cluster it found, or from a cluster that it found to the next one (where its size says it ends): about the length of a cluster at the most. */
  private gap = 0

  constructor(index: MatroskaIndex, seconds: number, chunks: readonly Chunk[]) {
    this.index = index
    this.seconds = seconds
    this.chunks = chunks
    this.clusters = index.segment.end
    const { timing, read, header } = index.video
    this.delay = -timing.offsetSeconds - read.shift / header.timescale
  }

  /**
   * The bytes of `range`, which the seek needs. It counts as a read when the seek
   * has not needed those bytes already (the one that would be past the cap stops
   * the seek, whether the caller holds them or not), and what the caller does not
   * hold is asked for.
   */
  private take(range: ByteRange): Uint8Array {
    if (!covers(this.covered, range.start, range.end)) {
      if (this.reads >= MAX_SEEK_READS) throw new Capped()
      this.reads += 1
      this.covered.push(range)
    }
    const bytes = heldBytes(this.chunks, range.start, range.end)
    if (bytes === null) throw new Need(range)
    return bytes
  }

  /** A time in ticks, in seconds on the playback timeline. */
  private timeOf(ticks: number): number {
    return (ticks * this.index.timestampScale) / 1e9 - this.delay
  }

  /** Where reading starts for the time. */
  landing(): Landing {
    const points = this.cuePoints()
    if (points !== null && points.length > 0) {
      const landed = this.byCues(points)
      if (landed !== null) return landed
    }
    return this.bySearch()
  }

  // The Cues.

  /** The picture's points of the file's Cues, or null when it has none that can be used (a search is then to be made). */
  private cuePoints(): CuePoint[] | null {
    const { cues } = this.index
    if (cues !== null) {
      const here = this.cuesAt(cues)
      if (here === 'unusable') return null
      if (here !== 'absent') return here
    }
    return this.cuesInTail()
  }

  /**
   * The points of the Cues where the index says they are: 'absent' when no Cues
   * element is there (an entry of a SeekHead may be stale), and 'unusable' when
   * there is one that is too long to be read (`CUES_LIMIT`) or whose children do
   * not walk.
   */
  private cuesAt(cues: { start: number; end: number | null }): CuePoint[] | 'absent' | 'unusable' {
    const { segment } = this.index
    let bytes: Uint8Array
    if (cues.end !== null) {
      if (cues.end - cues.start > CUES_LIMIT) return this.tooLong(cues.start, cues.end)
      bytes = this.take({ start: cues.start, end: cues.end })
    } else {
      const window = this.take({
        start: cues.start,
        end: Math.min(cues.start + HEADER_READ, segment.end),
      })
      const el = cuesHeader(window)
      if (el === null || cues.start + el.end > segment.end) return 'absent'
      if (el.end > CUES_LIMIT) return this.tooLong(cues.start, cues.start + el.end)
      bytes =
        el.end <= window.length
          ? window.subarray(0, el.end)
          : this.take({ start: cues.start, end: cues.start + el.end })
    }
    const el = cuesHeader(bytes)
    if (el?.end !== bytes.length) return 'absent'
    try {
      return readCues(
        bytes,
        el,
        cues.start,
        segment.data,
        this.index.video.read.number,
        segment.end,
      )
    } catch (error) {
      if (error instanceof Mp4Error) return 'unusable'
      throw error
    }
  }

  /** The Cues that are from `start` to `end` are too long to be read. When they run to the Segment's end no cluster is in them, so a search need not look there. */
  private tooLong(start: number, end: number): 'unusable' {
    if (end === this.index.segment.end && start > this.index.firstCluster) this.clusters = start
    return 'unusable'
  }

  /**
   * The points of the Cues in the last `TAIL_BYTES` of the Segment (not before the
   * first Cluster), where writers put them: the first Cues element of a known size
   * that lies whole there, ends where the Segment does or exactly where an element
   * of the Segment's own starts, and whose children walk. Null when there is none.
   */
  private cuesInTail(): CuePoint[] | null {
    const { segment, firstCluster } = this.index
    const start = Math.max(segment.end - TAIL_BYTES, firstCluster)
    const bytes = this.take({ start, end: segment.end })
    for (
      let at = bytes.indexOf(CUES_ID[0] ?? 0);
      at !== -1;
      at = bytes.indexOf(CUES_ID[0] ?? 0, at + 1)
    ) {
      if (!CUES_ID.every((byte, offset) => bytes[at + offset] === byte)) continue
      const el = cuesHeader(bytes, at)
      if (el === null || el.end > bytes.length) continue
      if (el.end < bytes.length && !TOP_LEVEL.has(headerAt(bytes, el.end)?.id ?? 0)) continue
      try {
        return readCues(bytes, el, start, segment.data, this.index.video.read.number, segment.end)
      } catch (error) {
        // A candidate whose children do not walk is not Cues: it is the bytes of something else.
        if (!(error instanceof Mp4Error)) throw error
      }
    }
    return null
  }

  /**
   * Where the points lead for the time: the last point at or before it, else the
   * first, and the one before it while the point's keyframe lies later than the time.
   * Null when a point holds no cluster, where a search is to be made.
   */
  private byCues(points: readonly CuePoint[]): Landing | null {
    let at = -1
    for (const [one, point] of points.entries()) {
      if (this.timeOf(point.time) <= this.seconds) at = one
    }
    const before = at === -1
    if (before) at = 0
    // Points that begin partway into the file say nothing of what is before them: that is the file's start.
    const { firstCluster } = this.index
    if (before && (points[0]?.cluster ?? 0) > firstCluster)
      return { at: firstCluster, cluster: null }
    for (;;) {
      const point = points[at]
      if (point === undefined) return null
      const landed = this.onCue(point, before, at > 0)
      if (landed !== 'lies') return landed
      at -= 1
    }
  }

  /**
   * Where a point leads. Its cluster is read (its header, the first `HEADER_READ`
   * bytes) and must be at the point's position. The cursor is at the block the
   * point names when that is a block of the cluster, else at the cluster, which
   * `readClusters` enters; for a time before the first point, whose cluster is then the
   * file's first, it is at the cluster (the start of the file, as a start has it). The picture's first keyframe from
   * there is looked for in the header's bytes and then in `SEARCH_READ` bytes from
   * the cursor, and 'lies' says it is presented after the time while there is a
   * point before this one (`back`); with none, the cursor is at the first cluster
   * (the point's own when that is it). A keyframe that the bytes do not show leaves
   * the point as it is.
   */
  private onCue(point: CuePoint, before: boolean, back: boolean): Landing | 'lies' | null {
    const { segment } = this.index
    const header = {
      start: point.cluster,
      bytes: this.take({
        start: point.cluster,
        end: Math.min(point.cluster + HEADER_READ, segment.end),
      }),
    }
    const found = findCluster(header, point.cluster, segment.end)
    const el = headerAt(header.bytes)
    if (found?.start !== point.cluster || el === null) return null

    const own: Landing = { at: point.cluster, cluster: null }
    if (before) return own
    const named = point.relative === null ? null : point.cluster + el.data + point.relative
    const landings: { landing: Landing; named: boolean }[] = []
    if (named !== null && named < found.place.end) {
      landings.push({ landing: { at: named, cluster: found.place }, named: true })
    }
    landings.push({ landing: own, named: false })

    for (const { landing, named: byName } of landings) {
      const seen = this.keyframeFrom(landing, byName, header)
      if (!seen.block) continue
      if (seen.key !== null && this.timeOf(seen.key.pts) > this.seconds) {
        if (back) return 'lies'
        // Nothing is before this point to go back to: the file's start, if its cluster is not that.
        const { firstCluster } = this.index
        if (point.cluster > firstCluster) return { at: firstCluster, cluster: null }
      }
      return landing
    }
    return own
  }

  /**
   * The picture's first keyframe from the landing, as playing from it finds it, in
   * the bytes of the cluster's header when they hold the landing and have one, else
   * in `SEARCH_READ` bytes from it; a block that those bytes stop short of is read
   * whole (`wholeBlock`). `block` is false when the landing was named by a point
   * and is not at a block of its cluster.
   */
  private keyframeFrom(
    landing: Landing,
    named: boolean,
    header: Chunk,
  ): { block: boolean; key: Key | null } {
    const { segment, video } = this.index
    // `final` says that no longer read from the landing is to come: the bytes of the cluster's header may end before a header does, and then the read that follows them tells.
    const from = (
      bytes: Uint8Array,
      final: boolean,
    ): { block: boolean; key: Key | null; cut: Cut | null } => {
      if (named && landing.cluster !== null) {
        const el = headerAt(bytes)
        // No header to read there is no block, as much as one that is another element.
        const missing = el === null && (final || bytes.length >= MAX_HEADER)
        if (
          missing ||
          (el !== null &&
            !(BLOCKS.has(el.id) && el.sized && landing.at + el.end <= landing.cluster.end))
        ) {
          return { block: false, key: null, cut: null }
        }
      }
      const read = readClusters(
        { start: landing.at, bytes },
        landing.at,
        landing.cluster,
        false,
        segment.end,
        [video.read],
      )
      const key = read.frames.find((frame) => frame.keyframe) ?? null
      return { block: true, key, cut: key === null ? cutOf(read, bytes, landing.at) : null }
    }

    const headerEnd = header.start + header.bytes.length
    const whole = { start: landing.at, end: Math.min(landing.at + SEARCH_READ, segment.end) }
    let cut: Cut | null = null
    if (landing.at >= header.start && landing.at < headerEnd) {
      const seen = from(header.bytes.subarray(landing.at - header.start), whole.end <= headerEnd)
      if (!seen.block || seen.key !== null) return seen
      cut = seen.cut
      if (cut === null && whole.end <= headerEnd) return { block: true, key: null }
    }
    // A block that the header's bytes stop short of and that runs past the read from the landing is read whole instead of that read, which it holds.
    if (cut === null || cut.end <= whole.end) {
      const seen = from(this.take(whole), true)
      if (!seen.block || seen.key !== null) return seen
      cut = seen.cut
    }
    return { block: true, key: cut === null ? null : this.wholeBlock(landing, cut) }
  }

  /**
   * The picture's keyframe in the block `cut` that the bytes read from `landing`
   * stop short of, if it is one: the block is read whole, from the landing to its
   * end (one read), when that is no more than `FIRST_FRAMES_BYTES` and inside the
   * Segment; else a SimpleBlock is judged by its first bytes (its track, its time
   * and its keyframe flag), and any other block says nothing.
   */
  private wholeBlock(landing: Landing, cut: Cut): Key | null {
    const { segment, video } = this.index
    if (cut.end > segment.end || cut.end - landing.at > FIRST_FRAMES_BYTES) {
      const { head } = cut
      return head !== null && head.track === video.read.number && head.keyframe
        ? { pts: cut.place.timestamp + head.timecode, offset: cut.at }
        : null
    }
    const bytes = this.take({ start: landing.at, end: cut.end })
    const read = readClusters(
      { start: landing.at, bytes },
      landing.at,
      landing.cluster,
      false,
      segment.end,
      [video.read],
    )
    return read.frames.find((frame) => frame.keyframe) ?? null
  }

  // The search.

  /**
   * Where reading starts, by a search of the clusters. The first cluster's header is
   * read (`firstPlace`): a time at or before the first cluster's is its. Else the
   * Segment is narrowed down to a stretch of a cluster or two (`bisect`), the stretch
   * is read at once, and in it the latest cluster that holds a keyframe at or before
   * the time is chosen (`holding`). When none does, the search is made again for a
   * cluster before the first of them, and so on; the first cluster is where it ends.
   */
  private bySearch(): Landing {
    const { segment, firstCluster } = this.index
    const first: Landing = { at: firstCluster, cluster: null }
    // A time at or before the first cluster's is the first cluster's: no cluster comes before it.
    const start = this.firstPlace()
    if (start !== null && this.timeOf(start.timestamp) >= this.seconds) return first
    // The clusters of a file are alike: how long the first is says how long a read to start a guess with is, and how long a cluster is.
    if (start?.sized === true) {
      const length = start.end - firstCluster
      this.gap = Math.max(this.gap, length)
      this.firstRead = Math.min(Math.max(length, SEARCH_READ), FIRST_FRAMES_BYTES)
    }
    let below = Infinity
    for (let round = 0; round < MAX_SEEK_READS; round += 1) {
      const { best, from, to } = this.bisect(below, start)
      // From the best cluster to a header's length past where no cluster starts any more, and at least as far as a keyframe is looked for (`SEARCH_READ`): one read, which `narrow` keeps within `FIRST_FRAMES_BYTES`.
      const end = Math.min(segment.end, Math.max(to + HEADER_READ, from + SEARCH_READ))
      const chunk = { start: from, bytes: this.take({ start: from, end }) }
      const chosen = this.holding(chunk, below)
      if (chosen !== null) return { at: chosen, cluster: null }
      if (best === null) return first
      below = best.timestamp
    }
    return first
  }

  /** The first cluster's place (its Timestamp, and where it ends), read from its header (the first `HEADER_READ` bytes of it, which the open's head usually holds). Null when the bytes there are no cluster's header, as in a damaged file. */
  private firstPlace(): ClusterPlace | null {
    const { segment, firstCluster } = this.index
    const bytes = this.take({
      start: firstCluster,
      end: Math.min(firstCluster + HEADER_READ, segment.end),
    })
    const found = findCluster({ start: firstCluster, bytes }, firstCluster, segment.end)
    return found?.start === firstCluster ? found.place : null
  }

  /** The anchor of the cluster at `at` whose place is `place`. */
  private anchorAt(at: number, place: ClusterPlace): Anchor {
    return {
      at,
      seconds: this.timeOf(place.timestamp),
      end: place.sized ? place.end : null,
    }
  }

  /** Whether a cluster is one to land at as far as its time goes: before `below` ticks and at or before the time. */
  private early(timestamp: number, below: number): boolean {
    return timestamp < below && this.timeOf(timestamp) <= this.seconds
  }

  /** How wide the range may be when the search stops: twice the longest cluster it has seen, but never less than `SEARCH_READ`, and no more than one read of `FIRST_FRAMES_BYTES` takes with a header's length past it. */
  private narrow(): number {
    return Math.min(Math.max(SEARCH_READ, 2 * this.gap), FIRST_FRAMES_BYTES - HEADER_READ)
  }

  /**
   * The offset of the next guess in the range that is left, from where the low
   * anchor's cluster ends to `hi` (no cluster starts inside a cluster; one whose size
   * is not known is taken to end with its first byte), and whether it is made by
   * time. By time when both anchors say theirs and the time `aim` lies between them:
   * the place on the line from one anchor to the other, no nearer to the end of the
   * range than a read, since a guess reads forward from itself, and no nearer to its
   * start than a read when the cluster there is of unknown size. By the byte, the
   * middle of the range, when an anchor has no time, when the time lies outside them,
   * when the range is too narrow to keep a read from both ends, and when the guess
   * before was by time and did not at least halve the range (`was` is the range's
   * width before it): the range halves at least every second guess, so that the
   * search is logarithmic in the worst case. A range no wider than a stretch
   * (`narrow`) after a cluster of known size is guessed at its start: the cluster
   * there, if there is one, is the next, and says all that is left to find.
   */
  private guessAt(
    lo: Anchor,
    high: Anchor,
    hi: number,
    aim: number,
    was: number | null,
  ): { at: number; byTime: boolean } {
    const floor = lo.end ?? lo.at + 1
    const width = hi - floor
    const middle = floor + Math.floor(width / 2)
    if (lo.end !== null && width <= this.narrow()) return { at: floor, byTime: false }
    if (was !== null && 2 * width > was) return { at: middle, byTime: false }
    if (lo.seconds === null || high.seconds === null) return { at: middle, byTime: false }
    if (!(lo.seconds <= aim && aim < high.seconds && lo.at < high.at)) {
      return { at: middle, byTime: false }
    }
    const margin = this.firstRead
    const near = lo.end === null ? floor + margin : floor
    if (hi - margin < near) return { at: middle, byTime: false }
    const share = (aim - lo.seconds) / (high.seconds - lo.seconds)
    const at = lo.at + Math.floor((high.at - lo.at) * share)
    return { at: Math.min(Math.max(at, near), hi - margin), byTime: true }
  }

  /**
   * The search for the last cluster at or before the time, narrowed to the stretch
   * [`from`, `to`) that holds the clusters it left: `from` is the best cluster found
   * (the first cluster when none is, `best` then null), and no cluster starts at or
   * after `to`.
   *
   * The range [first cluster, Segment's end) is narrowed by guesses. A guess reads
   * forward from an offset and takes the first cluster it finds, whose Timestamp says
   * which side of it the time is. A cluster at or before the time is the best so far
   * and moves the low anchor, its offset and its time; one after moves the high
   * anchor the same way, and with none found as well the range ends at the guess. The
   * anchors are the first cluster (`start`, whose place the header gave, when the
   * bytes there are a cluster's) and the end: the file's last cluster when the open
   * found it (`lastCluster`), else the Segment's end at the file's duration, else
   * nothing. A guess is made by time between anchors that say theirs, else by the
   * byte (`guessAt`).
   *
   * A guess starts reading at the size of the read that last found a cluster (the
   * first is the first cluster's length, at least `SEARCH_READ`), and each read after
   * it is twice the one before, up to `FIRST_FRAMES_BYTES`, until a cluster is found
   * or the range ends (a cluster is longer than a read, or the guess is in a stretch
   * that has none). Clusters of one file are alike, so most guesses take one read.
   * Each read after the first starts a header's length before the end of the one
   * before, so that a cluster whose header lies across that end is seen whole. The
   * search stops when the range is no wider than about two clusters (`narrow`), or
   * when no room is left after the cluster at the low anchor, whose size is known.
   */
  private bisect(
    below: number,
    start: ClusterPlace | null,
  ): {
    best: { start: number; timestamp: number } | null
    from: number
    to: number
  } {
    const { segment, firstCluster, lastCluster, durationSeconds } = this.index
    let lo: Anchor =
      start === null
        ? { at: firstCluster, seconds: null, end: null }
        : this.anchorAt(firstCluster, start)
    let hi = this.clusters
    let high: Anchor = {
      at: hi,
      seconds: durationSeconds === null ? null : durationSeconds - this.delay,
      end: null,
    }
    let best: { start: number; timestamp: number } | null = null
    // No cluster starts after the last one: the range ends with it, and it is the best so far unless it is late.
    if (lastCluster !== null && lastCluster.start >= firstCluster && lastCluster.start < hi) {
      const anchor = {
        at: lastCluster.start,
        seconds: this.timeOf(lastCluster.timestamp),
        end: null,
      }
      if (this.early(lastCluster.timestamp, below)) {
        best = lastCluster
        lo = anchor
        hi = lastCluster.start + 1
      } else {
        high = anchor
        hi = lastCluster.start
      }
    }

    // A later round looks for a cluster before the best of the round before (`below`).
    const aim = Math.min(this.seconds, this.timeOf(below))
    let was: number | null = null
    while (hi > (lo.end ?? lo.at + 1) && hi - lo.at > this.narrow()) {
      const width = hi - (lo.end ?? lo.at + 1)
      const { at: guess, byTime } = this.guessAt(lo, high, hi, aim, was)
      was = byTime ? width : null
      let found: { start: number; place: ClusterPlace } | null = null
      let from = guess
      let size = this.firstRead
      while (found === null && from < hi) {
        const end = Math.min(from + size, segment.end)
        const chunk = { start: from, bytes: this.take({ start: from, end }) }
        found = findCluster(chunk, from, segment.end)
        if (found !== null) this.learn(size, guess, found.start, found.place)
        if (end >= segment.end) break
        from = end - HEADER_READ
        size = Math.min(2 * size, FIRST_FRAMES_BYTES)
      }
      if (found !== null && found.start < hi) {
        const anchor = this.anchorAt(found.start, found.place)
        if (this.early(found.place.timestamp, below)) {
          best = { start: found.start, timestamp: found.place.timestamp }
          lo = anchor
        } else {
          high = anchor
          hi = guess
        }
      } else {
        hi = guess
      }
    }
    // With no room left after the cluster at the low anchor, it is the only one to look at.
    return { best, from: lo.at, to: hi > (lo.end ?? lo.at + 1) ? hi : lo.at + 1 }
  }

  /** What the read of `size` bytes from `guess`, which found the cluster at `start` (`place`), teaches about the file's clusters: how long a read to start with, and the longest distance from a guess to a cluster and from a cluster to the next (a cluster of unknown size says nothing of where the next starts). */
  private learn(size: number, guess: number, start: number, place: ClusterPlace): void {
    this.firstRead = size
    this.gap = Math.max(this.gap, start - guess, place.sized ? place.end - start : 0)
  }

  /**
   * The latest cluster in the read that is early enough and holds a picture
   * keyframe, presented at or before the time, within the bytes of the read; null
   * when there is none. A cluster is held to the frames from its start to the next
   * cluster's (or its own end).
   */
  private holding(chunk: Chunk, below: number): number | null {
    const { segment, video } = this.index
    const starts: { start: number; place: ClusterPlace }[] = []
    for (let from = chunk.start; ;) {
      const found = findCluster(chunk, from, segment.end)
      if (found === null) break
      starts.push(found)
      from = found.start + 1
    }
    const read = readClusters(chunk, chunk.start, null, false, segment.end, [video.read])

    let chosen: number | null = null
    for (const [one, cluster] of starts.entries()) {
      if (!this.early(cluster.place.timestamp, below)) continue
      const end = Math.min(
        starts[one + 1]?.start ?? Infinity,
        cluster.place.sized ? cluster.place.end : Infinity,
      )
      const key = read.frames.find(
        (frame) => frame.keyframe && frame.offset >= cluster.start && frame.offset < end,
      )
      if (key !== undefined && this.timeOf(key.pts) <= this.seconds) chosen = cluster.start
    }

    // The last cluster in the read may have a block that the read stops short of, and its keyframe be that block: it is read whole, from the cluster's start.
    const last = starts[starts.length - 1]
    const cut = cutOf(read, chunk.bytes, chunk.start)
    if (
      last !== undefined &&
      cut !== null &&
      cut.at >= last.start &&
      this.early(last.place.timestamp, below) &&
      !read.frames.some((frame) => frame.keyframe && frame.offset >= last.start)
    ) {
      const key = this.wholeBlock({ at: last.start, cluster: null }, cut)
      if (key !== null && this.timeOf(key.pts) <= this.seconds) chosen = last.start
    }
    return chosen
  }
}

/**
 * Where to start reading the file for the time `seconds`, on the playback timeline
 * (a picture's CodecDelay is taken off the times of the file), for the sound with
 * the id `sound` (one of `index.soundTracks`) or none: a cursor for `matroskaFrames`
 * with fresh decode states, at a keyframe cluster of the picture at or before the
 * time, or the next range of the file that the seek needs, which the caller reads,
 * adds as a chunk and calls again with them all.
 *
 * - With Cues, the cursor is at the block of the last point at or before the time,
 *   with its cluster read; without a block position, at the cluster. A point whose
 *   keyframe is presented after the time gives way to the point before it, and the
 *   first point's, or a time before it, to the first cluster (the point's own, when
 *   that is it); a block position that is not a block of its cluster gives the
 *   cluster's start. A time past the last point is the last point's.
 * - Without them, or with Cues too long to read (`CUES_LIMIT`), that do not walk, that have no point
 *   of the picture or that lead to something that is no cluster, the cursor is at
 *   the start of a cluster found by a search, with `cluster` null, for the first
 *   cluster when there is none at or before the time.
 * - A picture block that a read stops short of, where the keyframe is looked for, is
 *   read whole (up to `FIRST_FRAMES_BYTES`, else its first bytes judge it).
 * - A seek that has needed `MAX_SEEK_READS` reads stops at the first cluster.
 *
 * A sound that is not one of the index's, or a time that is no number, is a
 * RangeError, the caller's miscount; a file's damage is never thrown from here.
 */
export function matroskaSeek(
  index: MatroskaIndex,
  seconds: number,
  sound: number | null,
  chunks: readonly Chunk[],
): Step<MatroskaCursor> {
  const start = matroskaStart(index, sound)
  if (Number.isNaN(seconds)) throw new RangeError(`${seconds} is not a time.`)
  try {
    const landing = new Seeking(index, seconds, chunks).landing()
    return {
      done: {
        ...start,
        at: landing.at,
        cluster: landing.cluster === null ? null : { ...landing.cluster },
      },
    }
  } catch (error) {
    if (error instanceof Need) return { need: error.range }
    if (error instanceof Capped) return { done: start }
    throw error
  }
}
