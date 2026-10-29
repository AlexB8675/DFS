import { Mp4Error } from '../errors.ts'
import type { ByteRange, Chunk } from '../source.ts'
import { readBlockGroup, readSimpleBlock } from './blocks.ts'
import type { BlockFrames } from './blocks.ts'
import { readHeader, readUint } from './ebml.ts'
import type { Element } from './ebml.ts'
import { AFTER_BLOCK, ID, TOP_LEVEL } from './ids.ts'
import { HEADER_READ, MAX_BLOCK } from './limits.ts'

// The clusters of a Matroska or WebM file (DESIGN.md §10.4, D45): the part of the
// Segment that holds the frames. A Cluster has a Timestamp, in ticks, and blocks
// (SimpleBlocks, or BlockGroups) whose timecodes are counted from it. Like the
// head's walk this one is called with the part of the file the caller holds, a
// chunk, and a cursor (where to start, and the cluster it is inside) and gives the
// frames that the chunk completes and where to go on, so that a file is read span
// by span and a frame is read once. It finds out where things are and copies
// nothing: a frame is a range of the file.
//
// It stops before the first element that is not whole in the chunk, and says
// where that is, so that reading on from there with a chunk that starts there
// gives what one read of everything would. An element it has no use for is passed
// over by its size and needn't be held: a block of a track nobody asked for (all
// that is needed of it is its header and the track number that follows), or any
// element that is not a block, and so `next` may be past the end of the chunk. (A
// block in a cluster of unknown size is the exception, see below.)
//
// A file's damage is never thrown from here: a writer that was cut off, a block
// that lies about its lacing or a stretch of garbage is skipped, to the next
// cluster that is a cluster. That is told by what a cluster has to have (its
// header reads, and a Timestamp is among its first children), since the bytes of
// its ID can be anywhere, in the payload of a frame for one. When the chunk holds
// no cluster after the damage the search goes on in the next call (`searching`).
//
// A cluster of unknown size is bounded by the Segment alone, so a size that damage
// has made larger inside it would be waited for as a download, or passed over with
// the frames it covers lost without a word, and a caller that holds one chunk from
// the cursor can't skip a block it hasn't read. So the bound is kept here, in three
// checks that a cluster of its own size never needs (it bounds every claim): an
// element of such a cluster that claims more than `MAX_BLOCK` is damaged; a block
// is taken only when the bytes where it claims to end start an element that can
// follow it (or are the Segment's end), the bytes of a block of a track nobody
// asked for included, which are then held whole; and between clusters an element
// that no Segment holds is damaged and is not passed over by its size. A damage
// is skipped from the element, or the block, that shows it.

/** One frame of a track asked for, as the file has it: a range of the file, and when it is. */
export interface RawFrame {
  /** The TrackNumber of the track it is of. */
  track: number
  /** Where its bytes start in the file, and how many they are. */
  offset: number
  size: number
  /** In ticks: the cluster's Timestamp plus the block's timecode, and for a frame of a lace, the durations of the frames before it. */
  pts: number
  keyframe: boolean
  /** In ticks, perhaps not a whole number: the BlockDuration divided among the frames of the block, else the track's DefaultDuration, else null. The length that a codec's frame header gives is not put here: the last frame of a track is timed by the timing step, which knows what follows it. */
  duration: number | null
  /** Where the block's body starts in the file (see `BlockFrames`). */
  body: number
}

/** Where a cluster is, as far as reading it goes on from the middle: its Timestamp, where it ends and whether its size was written. A cluster of unknown size ends where the Segment does, or earlier, at the first element of the Segment's own. */
export interface ClusterPlace {
  timestamp: number
  end: number
  sized: boolean
}

/** A track whose frames are asked for. */
export interface ClusterTrack {
  /** The TrackNumber. */
  number: number
  /** The track's DefaultDuration in ticks, perhaps not a whole number; null when it has none. */
  defaultDuration: number | null
  /** How many ticks a frame lasts by its own bytes (a sound frame's header says how many samples it holds); null when they don't say. Called only for the frames of a laced block that has no other duration, and for none that is the last of its block. */
  lace: (frame: Uint8Array) => number | null
}

/** What one call reads. Every offset is an offset in the file. */
export interface ClusterRead {
  /** The frames of the tracks asked for that the chunk completes, in file order. */
  frames: RawFrame[]
  /** Where to go on: the start of the first element not whole in the chunk, or past the chunk's end where an element was passed over by its size; while searching, where the search is to go on. */
  next: number
  /** The cluster `next` is inside, null between clusters and while searching. */
  cluster: ClusterPlace | null
  /** The ranges skipped as damaged, in order. */
  skipped: ByteRange[]
  /** True when the damage left no cluster in the chunk to go on in: the next call starts by looking for one. */
  searching: boolean
  /** True when `next` is the Segment's end. */
  ended: boolean
}

/** The bytes of a Cluster's ID, and how many they are. */
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75]
const ID_WIDTH = CLUSTER_ID.length

/** How many bytes after a block in a cluster of unknown size a caller holds for the block to be taken: the longest ID, which tells whether what follows can follow a block. */
export const FOLLOW_BYTES = 4

/** A Cluster's Timestamp is among its first children, not counting a CRC-32 or a Void (ffmpeg writes the CRC-32 first and then the Timestamp). */
const TIMESTAMP_WITHIN = 3

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** Refuses an offset that is not in the chunk, which only a caller that miscounted can give. The chunk's end is in it: nothing is left to read there. */
function checkWithin(chunk: Chunk, at: number): void {
  const end = chunk.start + chunk.bytes.length
  if (!Number.isSafeInteger(at) || at < chunk.start || at > end) {
    throw new RangeError(`Offset ${at} is not in the chunk, which holds ${chunk.start} to ${end}.`)
  }
}

/**
 * The cluster whose header is `el` (an element of `chunk.bytes`), entered: its
 * place, and where its first child is. Null when the chunk ends before the header
 * and the children up to the Timestamp, with the Timestamp, are held (`limit` is
 * how far the chunk and the Segment go, in the file); a cluster that can't be
 * entered is a damaged file, one whose first elements claim to reach more than
 * `HEADER_READ` bytes from its start among them. A cluster of unknown size ends at the Segment's end,
 * and a sized one at its own, which `clamp` cuts to the Segment's end where it runs
 * past it, as a file cut short does: a search for a cluster takes no such cluster
 * unless it is told to (`findCluster`'s `cutShort`), for it has nothing but the
 * header to go by.
 */
function enterCluster(
  chunk: Chunk,
  el: Element,
  limit: number,
  segmentEnd: number,
  clamp: boolean,
): { place: ClusterPlace; first: number } | null {
  const base = chunk.start
  let end = segmentEnd
  if (el.sized) {
    end = base + el.end
    if (end > segmentEnd) {
      if (!clamp) {
        throw damaged(
          `The cluster at offset ${base + el.start} ends at ${end}, past the Segment's end at ${segmentEnd}.`,
        )
      }
      end = segmentEnd
    }
  }

  const held = Math.min(end, limit)
  let at = el.data
  for (let counted = 0; counted < TIMESTAMP_WITHIN;) {
    const child = readHeader(chunk.bytes, at, held - base)
    if (child === null) {
      if (end <= limit) {
        throw damaged(`The cluster at offset ${base + el.start} ends before its Timestamp.`)
      }
      return null
    }
    // A cluster of unknown size ends at the first element of the Segment's own, so
    // one that does so before a Timestamp has none; a child can't have an unknown
    // size, whichever cluster it is in.
    if (!child.sized || (!el.sized && TOP_LEVEL.has(child.id))) {
      throw damaged(`The cluster at offset ${base + el.start} has no Timestamp before its end.`)
    }
    if (base + child.end > end) {
      throw damaged(
        `The element at offset ${base + child.start} in the cluster at ${base + el.start} runs past the cluster's end.`,
      )
    }
    // What a cluster's first elements claim is bounded, so that bytes that only look
    // like a cluster, and claim more, are not waited for: a caller would read on to
    // see them whole, and a file's damage never costs a download (`HEADER_READ`).
    if (child.end > el.start + HEADER_READ) {
      throw damaged(
        `The element at offset ${base + child.start} in the cluster at ${base + el.start} ends more than ${HEADER_READ} bytes after the cluster's start, which no cluster's first elements do.`,
      )
    }
    if (base + child.end > limit) return null
    if (child.id === ID.Timestamp) {
      const timestamp = readUint(chunk.bytes, child)
      return { place: { timestamp, end, sized: el.sized }, first: base + el.data }
    }
    if (child.id !== ID.CRC32 && child.id !== ID.Void) counted += 1
    at = child.end
  }
  throw damaged(
    `The cluster at offset ${base + el.start} has no Timestamp among its first ${TIMESTAMP_WITHIN} elements.`,
  )
}

/** What a search for a cluster finds: one, or where the chunk ends before it can tell whether a candidate is one (`cut`), or none. */
type Scan = { start: number; place: ClusterPlace } | { cut: number } | null

/**
 * Looks for a cluster in the chunk from offset `from` of the file, by its ID: a
 * candidate is a cluster when its header reads, it ends within the Segment (or is of
 * unknown size, or, with `cutShort`, is sized and runs past the Segment's end, which
 * then ends it) and a Timestamp is among its first children and reads. A candidate
 * that the chunk ends too soon to tell about is reported (`cut`) when more of the
 * Segment may come, and is passed otherwise.
 */
function scan(chunk: Chunk, from: number, segmentEnd: number, cutShort: boolean): Scan {
  const base = chunk.start
  const bytes = chunk.bytes
  const limit = Math.min(base + bytes.length, segmentEnd)
  const more = base + bytes.length < segmentEnd
  const last = limit - base - ID_WIDTH

  let at = from - base
  for (;;) {
    at = bytes.indexOf(CLUSTER_ID[0] ?? 0, at)
    if (at === -1 || at > last) return null
    if (CLUSTER_ID.every((byte, index) => bytes[at + index] === byte)) {
      try {
        const el = readHeader(bytes, at, limit - base)
        const entered = el === null ? null : enterCluster(chunk, el, limit, segmentEnd, cutShort)
        if (entered !== null) return { start: base + at, place: entered.place }
        if (more) return { cut: base + at }
      } catch (error) {
        // A candidate that is damaged is not a cluster: it is the bytes of something else.
        if (!(error instanceof Mp4Error)) throw error
      }
    }
    at += 1
  }
}

/**
 * The first cluster in the chunk from offset `from` of the file, and its place (its
 * Timestamp read). A cluster is taken only when its ID is there, its size is
 * unknown or ends within the Segment (`segmentEnd`), and a Timestamp is among its
 * first 3 children and reads, all within the chunk. Null when there is none: the
 * bytes of an ID in the payload of a frame are no cluster for lacking the rest.
 *
 * With `cutShort` a sized cluster whose size runs past the Segment's end is taken
 * too, with its end at the Segment's: the last cluster of a file that was cut off
 * is one, and the search for the file's end looks for it. Every other search leaves
 * it out (the frame walk's resync, a seek's), for it has nothing but the header to
 * go by.
 */
export function findCluster(
  chunk: Chunk,
  from: number,
  segmentEnd: number,
  cutShort = false,
): { start: number; place: ClusterPlace } | null {
  checkWithin(chunk, from)
  const found = scan(chunk, from, segmentEnd, cutShort)
  return found !== null && 'place' in found ? found : null
}

/**
 * The track number a block is of, from the bytes of it that are held (`held`, an
 * offset in `bytes`): a SimpleBlock starts with it, and a BlockGroup's Block, which
 * is not always its first child, does. Null when the bytes that tell are not held.
 */
function peekTrack(bytes: Uint8Array, el: Element, held: number): number | null {
  const stop = Math.min(el.end, held)
  if (el.id === ID.SimpleBlock) return trackAt(bytes, el.data, stop)
  let at = el.data
  while (at < stop) {
    const child = readHeader(bytes, at, stop)
    if (child === null) return null
    if (!child.sized || child.end > el.end) {
      throw damaged(`The block group at offset ${el.start} has an element that runs past its end.`)
    }
    if (child.id === ID.Block) return trackAt(bytes, child.data, Math.min(child.end, stop))
    at = child.end
  }
  return null
}

/**
 * Whether the element that starts at `at` of `bytes` (read no further than `stop`) is
 * one that can follow a block in a cluster of unknown size (`AFTER_BLOCK`), from its
 * ID alone: null when the ID is not all held. An ID wider than 4 bytes, a first byte
 * below 0x10, is none that any element has.
 */
function canFollow(bytes: Uint8Array, at: number, stop: number): boolean | null {
  const first = bytes[at]
  if (first === undefined || at >= stop) return null
  if (first < 0x10) return false
  const width = Math.clz32(first) - 23
  if (at + width > stop) return null
  let id = 0
  for (let i = at; i < at + width; i += 1) id = id * 256 + (bytes[i] ?? 0)
  return AFTER_BLOCK.has(id)
}

/** The vint at `at` of `bytes`, read no further than `stop`: null when it isn't all there. A first byte of 0 is a number wider than 8 bytes. */
function trackAt(bytes: Uint8Array, at: number, stop: number): number | null {
  const first = bytes[at]
  if (first === undefined || at >= stop) return null
  if (first === 0) throw damaged('A block has a track number wider than 8 bytes.')
  const width = Math.clz32(first) - 23
  if (at + width > stop) return null
  let value = first & (0xff >> width)
  for (let i = at + 1; i < at + width; i += 1) value = value * 256 + (bytes[i] ?? 0)
  return value
}

/**
 * The frames of a block of a track asked for, with their times. The frames of a lace
 * share the block's timecode and follow one another: each starts one duration after
 * the one before, the durations added as the fractions they are and the sum rounded
 * once for each frame, so that a rounding never builds up. The duration of a frame
 * is the BlockDuration divided among the frames, else the track's DefaultDuration,
 * else what its own bytes say (`lace`); a laced block that has none of these is
 * damaged. Only the frames that another follows are asked: the last frame's length
 * moves no time.
 */
function timed(
  block: BlockFrames,
  track: ClusterTrack,
  chunk: Chunk,
  timestamp: number,
): RawFrame[] {
  const count = block.frames.length
  const duration = block.duration === null ? track.defaultDuration : block.duration / count
  const first = timestamp + block.timecode
  const out: RawFrame[] = []
  let elapsed = 0
  for (const [index, frame] of block.frames.entries()) {
    out.push({
      track: block.track,
      offset: frame.offset,
      size: frame.size,
      pts: first + Math.round(elapsed),
      keyframe: block.keyframe,
      duration,
      body: block.body,
    })
    if (index === count - 1) break
    const at = frame.offset - chunk.start
    const ticks = duration ?? track.lace(chunk.bytes.subarray(at, at + frame.size))
    if (ticks === null) {
      throw damaged(
        `The frames of the block at offset ${block.body} have no duration to follow one another by: it has no BlockDuration, the track no DefaultDuration, and a frame's header doesn't say.`,
      )
    }
    elapsed += ticks
  }
  return out
}

/**
 * Reads the clusters in `chunk` (the part of the file held, starting at offset
 * `chunk.start`) from offset `at`, for the frames of `tracks`, and says where to go
 * on. `cluster` is the cluster `at` is inside, at the start of one of its children,
 * or null when `at` is between clusters, at an element of the Segment's own. While
 * `searching`, `at` is where to start looking for a cluster, after damage. The
 * Segment ends at `segmentEnd`. An `at` that is not in the chunk is a RangeError.
 *
 * What a file claims is bounded here, for the caller can't bound it: it holds one
 * chunk from the cursor and has no way to skip a block. A sized cluster bounds every
 * size inside it. In a cluster of unknown size (only the Segment bounds it) an
 * element whose data claims more than `MAX_BLOCK` is damaged, and a block, of a track
 * asked for or not, is taken only when the bytes where it claims to end are held
 * and start an element that can follow it (`AFTER_BLOCK`), or it ends at the
 * Segment's end; until they are held the call stops before the block, as it does for
 * one that is cut. Between clusters an element that is not the Segment's own (nor a
 * Void or a CRC-32) is damaged. All of these are skipped from the element, as a
 * damage is.
 */
export function readClusters(
  chunk: Chunk,
  at: number,
  cluster: ClusterPlace | null,
  searching: boolean,
  segmentEnd: number,
  tracks: readonly ClusterTrack[],
): ClusterRead {
  checkWithin(chunk, at)
  const base = chunk.start
  const bytes = chunk.bytes
  const limit = Math.min(base + bytes.length, segmentEnd)
  const complete = segmentEnd <= base + bytes.length
  const wanted = new Map(tracks.map((track) => [track.number, track]))
  const frames: RawFrame[] = []
  const skipped: ByteRange[] = []

  let pos = at
  let place = cluster
  let seeking = searching

  /**
   * Skips the damage that starts at `damage` to the next cluster at or after
   * `from`, where reading goes on. When the chunk holds none, the search goes on in
   * the next call (`seeking`) from where a cluster could still start in what is not
   * yet held: 3 bytes before the end of the chunk, or the start of a candidate that
   * the chunk ends too soon to tell about. When the chunk holds the Segment to its
   * end no cluster is left, and the rest is skipped.
   */
  const resync = (damage: number, from: number): void => {
    place = null
    const found = scan(chunk, from, segmentEnd, false)
    if (found !== null && 'place' in found) {
      if (found.start > damage) skipped.push({ start: damage, end: found.start })
      pos = found.start
      seeking = false
      return
    }
    if (found === null && complete) {
      if (segmentEnd > damage) skipped.push({ start: damage, end: segmentEnd })
      pos = segmentEnd
      seeking = false
      return
    }
    const next = found === null ? Math.max(from, limit - (ID_WIDTH - 1)) : found.cut
    if (next > damage) skipped.push({ start: damage, end: next })
    pos = next
    seeking = true
  }

  /** Reads the element at `pos`, and gives false when it isn't all held and so reading stops. A damaged file is thrown. */
  const step = (): boolean => {
    const rel = pos - base
    if (place === null) {
      const el = readHeader(bytes, rel, limit - base)
      if (el === null) {
        if (complete) throw damaged(`The Segment ends in the middle of an element at ${pos}.`)
        return false
      }
      if (el.id !== ID.Cluster) {
        // The rest of the Segment's own elements (Cues, Tags and the others) are
        // passed over by their size, which needn't be held. An element that is not
        // one of them is no element of the Segment, and its size is not to be trusted.
        if (!el.sized) throw damaged(`The element at offset ${pos} has an unknown size.`)
        if (!TOP_LEVEL.has(el.id) && el.id !== ID.Void && el.id !== ID.CRC32) {
          throw damaged(`The element at offset ${pos} is none that a Segment holds.`)
        }
        pos = Math.min(base + el.end, segmentEnd)
        return true
      }
      const entered = enterCluster(chunk, el, limit, segmentEnd, true)
      if (entered === null) return false
      place = entered.place
      pos = entered.first
      return true
    }

    const held = Math.min(place.end, limit)
    const el = readHeader(bytes, rel, held - base)
    if (el === null) {
      if (place.end <= limit)
        throw damaged(`The cluster ends in the middle of an element at ${pos}.`)
      return false
    }
    // A cluster of unknown size ends at the first element of the Segment's own, which
    // is the next cluster's header for one that is followed by another.
    if (!place.sized && TOP_LEVEL.has(el.id)) {
      place = null
      return true
    }
    if (!el.sized) throw damaged(`The element at offset ${pos} has an unknown size.`)
    const end = base + el.end
    if (end > place.end) {
      throw damaged(
        `The element at offset ${pos} runs past the end of its cluster, at ${place.end}.`,
      )
    }
    // Nothing but the Segment bounds an element of a cluster of unknown size, so the
    // size of one is bounded here (`MAX_BLOCK`).
    if (!place.sized && el.end - el.data > MAX_BLOCK) {
      throw damaged(
        `The element at offset ${pos} in a cluster of unknown size claims ${el.end - el.data} bytes, more than the ${MAX_BLOCK} that one may.`,
      )
    }
    if (el.id !== ID.SimpleBlock && el.id !== ID.BlockGroup) {
      pos = end
      return true
    }

    // A block of a track nobody asked for is passed over by its size without being
    // held, but a block of one asked for, or whose track the held bytes don't tell,
    // is read, and so must be whole.
    const track = peekTrack(bytes, el, held - base)
    // In a cluster of unknown size a block is taken, or passed over, only where the
    // bytes at its end are held and start an element that can follow it, so that a
    // size that damage has made wrong is found at the block and not by what it
    // covers; so a block of a track nobody asked for is held to its end, then.
    if (!place.sized && end !== place.end) {
      const follows = canFollow(bytes, end - base, limit - base)
      if (follows === null) {
        if (complete) {
          throw damaged(`The Segment ends in the middle of the element after the block at ${pos}.`)
        }
        return false
      }
      if (!follows) {
        throw damaged(
          `The block at offset ${pos} is not followed by an element that can follow it.`,
        )
      }
    }
    if (track !== null && !wanted.has(track)) {
      pos = end
      return true
    }
    if (end > limit) return false
    const block =
      el.id === ID.SimpleBlock ? readSimpleBlock(bytes, el, base) : readBlockGroup(bytes, el, base)
    const asked = wanted.get(block.track)
    if (asked !== undefined) frames.push(...timed(block, asked, chunk, place.timestamp))
    pos = end
    return true
  }

  // A call that is searching starts with the search; one that finds a cluster then
  // reads it as any other, and one that doesn't ends with the search still under way.
  if (seeking) resync(at, at)
  while (!seeking) {
    if (place !== null && pos >= place.end) place = null
    if (place === null && pos >= segmentEnd) {
      return { frames, next: pos, cluster: null, skipped, searching: false, ended: true }
    }
    if (pos >= limit) break

    const start = pos
    try {
      if (!step()) break
    } catch (error) {
      if (!(error instanceof Mp4Error)) throw error
      // The damage starts at the element, and the search for a cluster after it starts
      // one byte on, so that the element isn't found again.
      resync(start, start + 1)
    }
  }
  return { frames, next: pos, cluster: place, skipped, searching: seeking, ended: false }
}
