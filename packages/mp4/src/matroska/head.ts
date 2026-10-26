import { Mp4Error } from '../errors.ts'
import { heldBytes, heldPrefix } from '../source.ts'
import type { ByteRange, Chunk, Step } from '../source.ts'
import { children, readBytes, readFloat, readHeader, readString, readUint } from './ebml.ts'
import type { Element } from './ebml.ts'
import { ID } from './ids.ts'
import { HEADER_READ, MAX_INDEX_READS } from './limits.ts'

// The head of a Matroska or WebM file (DESIGN.md §10.4, D45): its EBML header,
// its Segment, the SeekHead and Info at the start of that, and where its Tracks,
// its Cues and its first Cluster are. Like `locateMoov` for an MP4, it is called
// with the parts of the file that the caller holds and gives either the head or
// the next range of the file that it needs, which the caller reads and adds
// before it calls again. The first call is with the first bytes of the file
// (1 MiB, as for an MP4) and nearly every file is done with those: ffmpeg writes
// the SeekHead, Info and Tracks first and a megabyte of Tags at most, and
// mkvmerge much the same. What takes another read is a first Cluster behind a
// large Tags or Attachments, and a Cues or a second SeekHead named by the first
// that stands after the Clusters.
//
// Tracks and Cues are only located here, from where their headers are to where
// the elements end; a later step reads them. SeekHead and Info are read, which
// needs them whole.

/** What the head of a Matroska file says, with every offset an offset in the file. */
export interface MatroskaHead {
  docType: 'matroska' | 'webm'
  /** Where the Segment's data starts, which a SeekPosition counts from, and where the Segment ends (the file's end when its size is unknown, or more than the file holds). */
  segment: { data: number; end: number }
  /** Nanoseconds in a tick of the file's timestamps. */
  timestampScale: number
  /** The duration, in ticks; null when Info has none. */
  durationTicks: number | null
  /** The Tracks element, from its header to its end. */
  tracks: ByteRange
  /** The Cues element, from its header to its end; null when the file says of none where it is. */
  cues: ByteRange | null
  /** Where the first Cluster's header is. */
  firstCluster: number
  /** How many reads, after the head, the walk needed: each range it needed beyond the first chunk, whether it found it held in another chunk or asked for it. */
  reads: number
}

/** The most bytes that a header takes: an ID of 4 bytes and a size of 8. */
const MAX_HEADER = 12

/** What TimestampScale is when Info has none, as RFC 9559 gives it: a millisecond. */
const DEFAULT_SCALE = 1_000_000

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/**
 * A header that is no header, or that the end of its parent cuts short. Anywhere
 * in a walk it is the file that is damaged; only the position that an entry of a
 * SeekHead gives may be stale and leave one, and then the entry is left out.
 */
class BadHeader extends Mp4Error {
  constructor(message: string) {
    super('damaged', message)
  }
}

/** The walk lacks bytes: thrown from where it finds that out, and caught by `readHead`, so that the walk reads straight on. It never leaves this module. */
class Need extends Error {
  readonly range: ByteRange

  constructor(range: ByteRange) {
    super(`The head needs the bytes from ${range.start} to ${range.end}.`)
    this.range = range
  }
}

/** Whether [start, end) lies in the ranges, which may touch or overlap, taken together. */
function covers(ranges: readonly ByteRange[], start: number, end: number): boolean {
  let at = start
  while (at < end) {
    let reach = at
    for (const range of ranges) {
      if (range.start <= at && range.end > reach) reach = range.end
    }
    if (reach === at) return false
    at = reach
  }
  return true
}

/**
 * What the walk holds, and what it has needed of what it doesn't.
 *
 * A read is counted for each requirement of the walk (an element's header, or
 * the whole of one) that the first chunk, the head, doesn't hold, whether the
 * walk then finds the bytes in another chunk or asks the caller for them. The
 * count is of what a caller who is asked for exactly what the walk needs, and
 * gives that, would have read: a header that isn't held is asked for as
 * `[pos, pos + HEADER_READ)`, so the headers within that range are not another
 * read; an element that has to be whole is asked for from its header to its end.
 * So the count is the walk's, the same however much a caller has read ahead,
 * and the chunks that the walk never needed count for nothing. A walk that has
 * needed `MAX_INDEX_READS` and needs another is refused.
 */
class Held {
  /** The reads that the walk has needed so far. */
  reads = 0
  private readonly chunks: readonly Chunk[]
  private readonly fileSize: number
  /** The ranges of the file that the walk has had so far: the head, and what each read it has needed would have given. */
  private readonly covered: ByteRange[]

  constructor(chunks: readonly Chunk[], fileSize: number) {
    this.chunks = chunks
    this.fileSize = fileSize
    this.covered = [{ start: 0, end: Math.min(chunks[0]?.bytes.length ?? 0, fileSize) }]
  }

  /** A read that the walk needs, for `range`: refused when it would be one past the cap. */
  private charge(range: ByteRange): void {
    if (this.reads >= MAX_INDEX_READS) {
      throw damaged(
        `The file's head needs more than ${MAX_INDEX_READS} reads after its first bytes, which is the most that opening a file takes, so the file is refused.`,
      )
    }
    this.reads += 1
    this.covered.push(range)
  }

  /**
   * The header of the element at `pos`, with its offsets in the file, where
   * `limit` is the end of what holds the element (the Segment's, or the file's).
   * An element of unknown size has `sized: false` and ends at `limit`. A header
   * the walk doesn't hold whole is asked for, from `pos` to a `HEADER_READ`
   * later or to the file's end; one that `limit` cuts short is damaged.
   */
  header(pos: number, limit: number): Element {
    const held = heldPrefix(this.chunks, pos, Math.min(pos + MAX_HEADER, limit))
    const window = { start: pos, end: Math.min(pos + HEADER_READ, this.fileSize) }

    let found: Element | null
    try {
      found = readHeader(held, 0, held.length)
    } catch (error) {
      if (!(error instanceof Mp4Error)) throw error
      throw new BadHeader(
        `The element at offset ${pos} has a header that no element has: an ID wider than 4 bytes, a size wider than 8, or a size past 2^53 - 1.`,
      )
    }
    if (found === null) {
      if (pos + held.length >= limit) {
        throw new BadHeader(
          `The element at offset ${pos} is cut short: its header is not whole before offset ${limit}, where what holds it ends.`,
        )
      }
      this.charge(window)
      throw new Need(window)
    }

    if (!covers(this.covered, pos, pos + found.data)) this.charge(window)
    return {
      id: found.id,
      start: pos,
      data: pos + found.data,
      end: found.sized ? pos + found.end : limit,
      sized: found.sized,
    }
  }

  /**
   * The bytes of an element from its header to its end, which must be whole to
   * be read (`what` names it in a sentence). The element must be of a known
   * size, inside the file and no bigger than a read of a header, which is more
   * than any SeekHead or Info is. What the walk doesn't hold it asks for.
   */
  whole(el: Element, what: string): Uint8Array {
    if (!el.sized || el.end > this.fileSize) {
      throw damaged(
        `The ${what} at offset ${el.start} has no size, or runs past the end of the file.`,
      )
    }
    if (el.end - el.start > HEADER_READ) {
      throw damaged(
        `The ${what} at offset ${el.start} is ${el.end - el.start} bytes, where ${HEADER_READ} are the most one has.`,
      )
    }
    const range = { start: el.start, end: el.end }
    const bytes = heldBytes(this.chunks, range.start, range.end)
    if (bytes !== null && covers(this.covered, range.start, range.end)) return bytes
    this.charge(range)
    if (bytes === null) throw new Need(range)
    return bytes
  }
}

/** An element as it is in the bytes of itself, which is how its children are read: its header at 0. */
function inside(el: Element): Element {
  return { id: el.id, start: 0, data: el.data - el.start, end: el.end - el.start, sized: true }
}

/** The DocType of an EBML header, which is to be a Matroska or WebM file's and of a version this reader knows. */
function readEbmlHeader(bytes: Uint8Array, el: Element): 'matroska' | 'webm' {
  let docType: string | undefined
  let readVersion: number | undefined
  let maxIdLength: number | undefined
  let maxSizeLength: number | undefined
  let docTypeReadVersion: number | undefined
  for (const child of children(bytes, inside(el))) {
    if (child.id === ID.DocType) docType ??= readString(bytes, child)
    else if (child.id === ID.EBMLReadVersion) readVersion ??= readUint(bytes, child)
    else if (child.id === ID.EBMLMaxIDLength) maxIdLength ??= readUint(bytes, child)
    else if (child.id === ID.EBMLMaxSizeLength) maxSizeLength ??= readUint(bytes, child)
    else if (child.id === ID.DocTypeReadVersion) docTypeReadVersion ??= readUint(bytes, child)
  }

  if (docType !== 'matroska' && docType !== 'webm') {
    throw damaged(
      docType === undefined
        ? `The EBML header at the start of the file has no DocType, so it is not a Matroska or WebM file.`
        : `The file's DocType is '${docType}', and only 'matroska' and 'webm' are files this reader reads.`,
    )
  }
  // What a header leaves out is what the standard says it is: 1, 4 and 8, and 1 for the DocType.
  if ((readVersion ?? 1) !== 1) {
    throw damaged(
      `The EBML header needs a reader of version ${readVersion ?? 1}, and this reader is of version 1.`,
    )
  }
  if ((maxIdLength ?? 4) > 4 || (maxSizeLength ?? 8) > 8) {
    throw damaged(
      `The EBML header says IDs of ${maxIdLength ?? 4} bytes and sizes of ${maxSizeLength ?? 8}, where this reader reads 4 and 8 at most.`,
    )
  }
  if ((docTypeReadVersion ?? 1) > 4) {
    throw damaged(
      `The file needs a reader of version ${docTypeReadVersion ?? 1} of '${docType}', and this reader reads versions up to 4.`,
    )
  }
  return docType
}

/** What Info says that the reader needs: the scale of the timestamps, and the duration in them. */
interface Timing {
  scale: number
  duration: number | null
}

function readInfo(bytes: Uint8Array, el: Element): Timing {
  let scale: number | undefined
  let duration: number | undefined
  for (const child of children(bytes, inside(el))) {
    if (child.id === ID.TimestampScale) scale ??= readUint(bytes, child)
    else if (child.id === ID.Duration) duration ??= readFloat(bytes, child)
  }
  if (scale === 0) {
    throw damaged(`Info at offset ${el.start} has a TimestampScale of 0, so no time passes in it.`)
  }
  // A time is a number of ticks that is not less than 0 (a float may be NaN or infinite).
  if (duration !== undefined && !(Number.isFinite(duration) && duration >= 0)) {
    throw damaged(`Info at offset ${el.start} has a Duration that is not a time: ${duration}.`)
  }
  return { scale: scale ?? DEFAULT_SCALE, duration: duration ?? null }
}

/** An element that a SeekHead names: its ID, and where it is in the file. */
interface Seek {
  id: number
  at: number
}

/**
 * The entries of a SeekHead, whole in `bytes`, with their positions made
 * offsets in the file. An entry that lacks its ID or its position, or has an ID
 * that no element has (over 4 bytes, or none), names nothing and is left out,
 * and so is one whose position is past the Segment's end: there is nothing there
 * to find, and a recording that is cut off is a file whose SeekHead says more
 * than it holds.
 */
function readSeekHead(
  bytes: Uint8Array,
  el: Element,
  segment: { data: number; end: number },
): Seek[] {
  const found: Seek[] = []
  for (const seek of children(bytes, inside(el))) {
    if (seek.id !== ID.Seek) continue
    let id: Uint8Array | undefined
    let position: number | undefined
    for (const field of children(bytes, seek)) {
      if (field.id === ID.SeekID) id ??= readBytes(bytes, field)
      else if (field.id === ID.SeekPosition) position ??= readUint(bytes, field)
    }
    if (id === undefined || position === undefined || id.length < 1 || id.length > 4) continue
    const at = segment.data + position
    if (at >= segment.end) continue
    found.push({ id: id.reduce((value, byte) => value * 256 + byte, 0), at })
  }
  return found
}

/** The Segment, the first element after the EBML header that is not a Void. */
function segmentAfter(held: Held, from: number, fileSize: number): Element {
  let at = from
  while (at < fileSize) {
    const el = held.header(at, fileSize)
    if (el.id === ID.Segment) return el
    if (el.id !== ID.Void) {
      throw damaged(
        `The element after the EBML header, at offset ${at}, has the ID 0x${el.id.toString(16)}, where a Segment is.`,
      )
    }
    if (!el.sized || el.end > fileSize) {
      throw damaged(`The Void at offset ${at} has no size, or runs past the end of the file.`)
    }
    at = el.end
  }
  throw damaged(`The file has no Segment after its EBML header.`)
}

function walkHead(held: Held, fileSize: number): MatroskaHead {
  const first = held.header(0, fileSize)
  if (first.id !== ID.EBML) {
    throw damaged(
      `The file doesn't start with an EBML header (its first element has the ID 0x${first.id.toString(16)}), so it is not a Matroska or WebM file.`,
    )
  }
  const docType = readEbmlHeader(held.whole(first, 'EBML header'), first)

  // A Segment of unknown size, or that claims more than the file holds (a recording that was cut off), runs to the file's end.
  const segmentEl = segmentAfter(held, first.end, fileSize)
  const segment = { data: segmentEl.data, end: Math.min(segmentEl.end, fileSize) }

  let tracks: ByteRange | null = null
  let cues: ByteRange | null = null
  let timing: Timing | null = null
  let firstCluster: number | null = null
  // The entries of each SeekHead that was read, in order; those of them that name a SeekHead, from the ones that the walk met; and where each SeekHead read starts.
  const named: Seek[] = []
  const heads: Seek[] = []
  const read = new Set<number>()

  // The Segment's children from its data, to the first Cluster. Every other element is passed over by its size.
  let at = segment.data
  while (at < segment.end) {
    const el = held.header(at, segment.end)
    if (el.id === ID.Cluster) {
      firstCluster = at
      break
    }
    if (!el.sized) {
      throw damaged(
        `The element at offset ${at} has an unknown size, which only a Segment or a Cluster may have.`,
      )
    }
    if (el.end > segment.end) {
      throw damaged(
        `The element at offset ${at} ends at ${el.end}, past the end of the Segment at ${segment.end}.`,
      )
    }
    if (el.id === ID.SeekHead) {
      read.add(at)
      const seeks = readSeekHead(held.whole(el, 'SeekHead'), el, segment)
      named.push(...seeks)
      heads.push(...seeks.filter((seek) => seek.id === ID.SeekHead))
    } else if (el.id === ID.Info) {
      timing ??= readInfo(held.whole(el, 'Info'), el)
    } else if (el.id === ID.Tracks) {
      tracks ??= { start: el.start, end: el.end }
    } else if (el.id === ID.Cues) {
      cues ??= { start: el.start, end: el.end }
    }
    at = el.end
  }
  if (firstCluster === null) {
    throw damaged(`The Segment has no Cluster, so the file holds no frames.`)
  }

  // What the walk did not meet, from the entries of the SeekHeads: the header at the position an entry gives is read, to see that the element is there and where it ends. An entry that doesn't lead to its element (a stale position) is left out, and the walk's own find is not looked for again.
  const locate = (id: number): Element | null => {
    for (const seek of named) {
      if (seek.id !== id) continue
      let el: Element
      try {
        el = held.header(seek.at, segment.end)
      } catch (error) {
        if (error instanceof BadHeader) continue
        throw error
      }
      if (el.id === id && el.sized && el.end <= segment.end) return el
    }
    return null
  }
  for (;;) {
    if (tracks === null) {
      const el = locate(ID.Tracks)
      if (el !== null) tracks = { start: el.start, end: el.end }
    }
    if (timing === null) {
      const el = locate(ID.Info)
      if (el !== null) timing = readInfo(held.whole(el, 'Info'), el)
    }
    if (cues === null) {
      const el = locate(ID.Cues)
      if (el !== null) cues = { start: el.start, end: el.end }
    }
    if (tracks !== null && timing !== null && cues !== null) break

    // Something is still not found: a SeekHead that the first one names may say. One level deep, and only when it is looked for.
    const next = heads.find((seek) => !read.has(seek.at))
    if (next === undefined) break
    read.add(next.at)
    let el: Element
    try {
      el = held.header(next.at, segment.end)
    } catch (error) {
      if (error instanceof BadHeader) continue
      throw error
    }
    if (el.id !== ID.SeekHead || !el.sized || el.end > segment.end) continue
    named.push(...readSeekHead(held.whole(el, 'SeekHead'), el, segment))
  }

  if (tracks === null) {
    throw damaged(
      `The Segment has no Tracks element before its first Cluster, and no SeekHead says where one is, so the file has no tracks to play.`,
    )
  }
  return {
    docType,
    segment,
    timestampScale: timing?.scale ?? DEFAULT_SCALE,
    durationTicks: timing?.duration ?? null,
    tracks,
    cues,
    firstCluster,
    reads: held.reads,
  }
}

/**
 * The head of the file of `fileSize` bytes, from the chunks the caller holds,
 * the first of which starts at 0 (a RangeError when it doesn't, or when no chunk
 * is given or `fileSize` is no count of bytes: the caller's mistake and not the
 * file's). It gives the head, or the next range of the file that it needs: one
 * that no chunk holds, between 0 and the file's end. The caller reads that, adds
 * it as a chunk and calls again with them all; each call goes through the file
 * again from its start, which costs a few headers and keeps the function free
 * of any state of its own.
 *
 * A file that isn't a Matroska or WebM one of a version this reader knows, whose
 * head is cut short or contradicts itself, that has no Tracks or no Cluster, or
 * whose head needs more than `MAX_INDEX_READS` reads after the first bytes, is
 * refused as `Mp4Error('damaged')`.
 */
export function readHead(chunks: readonly Chunk[], fileSize: number): Step<MatroskaHead> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`${fileSize} is not a size that a file has.`)
  }
  const head = chunks[0]
  if (head === undefined) {
    throw new RangeError(`There is no chunk: the first is the file's first bytes.`)
  }
  if (head.start !== 0) {
    throw new RangeError(
      `The first chunk starts at ${head.start}, where the file's first bytes do.`,
    )
  }

  try {
    return { done: walkHead(new Held(chunks, fileSize), fileSize) }
  } catch (error) {
    if (error instanceof Need) return { need: error.range }
    throw error
  }
}
