// A rewriter for Matroska files, for the derived files of the corpus (DESIGN.md
// §10.4, D45): a file made by ffmpeg is read by the module and written again with
// one change that ffmpeg has no option to make, so that the reader is checked on
// every way a Matroska file can hold its frames and not only on the one ffmpeg
// writes. The changes are the lacing of one track's frames (Xiph's, EBML's or
// fixed-size), header stripping (the first bytes of every frame of a track taken
// out of it, which a ContentEncoding says were), Dolby Vision's configuration
// record (a BlockAdditionMapping of the picture), and Clusters of unknown size.
//
// A file is rebuilt from the elements the module reads: the EBML header as it is,
// then a Segment of known size with Info and Tracks (each re-written from its
// children, with the changes asked for) and the Clusters (each with its Timestamp
// and its blocks). Everything else is dropped: the SeekHead, Tags, Void, CRC-32
// and Cues (the sizes and positions they hold are no longer true), and a Cluster's
// other children, so that a derived file has nothing to seek by and its seeks
// search. A block of a track that is not changed is copied as it is. The rewrite
// of unknown sizes is the exception: the file is copied and only the size of each
// Cluster is written over, in the same width.
//
// A lace puts the frames of a track that follow one another in a Cluster, `count`
// to a block, in the place of the first of them; the block has that frame's
// timecode and flags, and the last lace in a Cluster may hold fewer frames (one
// frame is a block with no lacing). A BlockGroup of the track ends the lace before
// it and is copied as it is. Only blocks of one frame are laced: a source that is
// laced already is refused, as is a fixed lace of frames of different sizes (the
// source was not constant in bit rate). Tests and scripts only: the package
// itself does no I/O (the wrappers that read and write files are at the end).

import { readFileSync, writeFileSync } from 'node:fs'
import { readBlockGroup, readSimpleBlock } from '../matroska/blocks.ts'
import { children, readHeader } from '../matroska/ebml.ts'
import type { Element } from '../matroska/ebml.ts'
import { ID, TOP_LEVEL } from '../matroska/ids.ts'
import { readTracks } from '../matroska/tracks.ts'
import { concat } from './build.ts'
import { binary, element, simpleBlock, sizeBytes, uint, unknownSize } from './ebml.ts'
import type { Lacing } from './ebml.ts'

/** A Matroska file walked: its EBML header, its Segment and the elements inside it. */
export interface SegmentWalk {
  /** The EBML header, which starts the file. */
  header: Element
  /** The Segment: `sized` is false for the unknown size, and its `end` is then the file's. */
  segment: Element
  /**
   * The elements directly inside the Segment, in order, but for the CRC-32 and
   * Void elements. A Cluster of unknown size is among them, with `sized` false, and
   * ends where the next element of the Segment starts (or the Segment does).
   */
  parts: Element[]
}

/** Where a Cluster of unknown size ends: at the first of its children that is an element of the Segment's own, else where the Segment does. */
function endOfUnsizedCluster(bytes: Uint8Array, cluster: Element, limit: number): number {
  let at = cluster.data
  while (at < limit) {
    const child = readHeader(bytes, at, limit)
    if (child === null) throw new Error(`An element at ${at} is cut short by the end of the file.`)
    if (TOP_LEVEL.has(child.id)) return at
    if (!child.sized || child.end > limit) {
      throw new Error(`The element at ${at} inside a Cluster of unknown size has no size to go by.`)
    }
    at = child.end
  }
  return limit
}

/**
 * The elements of a Matroska file's Segment, read with the module's `readHeader`
 * over the file's bytes: the EBML header, the Segment (of known or unknown size)
 * and its children. Throws an `Error` for a file that is not whole enough to walk
 * (an element cut short or running past the Segment, or one of unknown size that
 * is not a Cluster).
 */
export function walkSegment(bytes: Uint8Array): SegmentWalk {
  const header = readHeader(bytes, 0, bytes.length)
  if (header?.id !== ID.EBML || header.end > bytes.length) {
    throw new Error('The file does not start with an EBML header.')
  }
  const segment = readHeader(bytes, header.end, bytes.length)
  if (segment?.id !== ID.Segment) throw new Error('The EBML header is not followed by a Segment.')

  const limit = Math.min(segment.end, bytes.length)
  const parts: Element[] = []
  let at = segment.data
  while (at < limit) {
    const part = readHeader(bytes, at, limit)
    if (part === null) throw new Error(`An element at ${at} is cut short by the end of the file.`)
    let end = part.end
    if (!part.sized) {
      if (part.id !== ID.Cluster) {
        throw new Error(`The element at ${at} has an unknown size, which only a Cluster may have.`)
      }
      end = endOfUnsizedCluster(bytes, part, limit)
    } else if (part.end > limit) {
      throw new Error(`The element at ${at} runs past the end of the Segment, at ${limit}.`)
    }
    if (part.id !== ID.CRC32 && part.id !== ID.Void) parts.push({ ...part, end })
    at = end
  }
  return { header, segment, parts }
}

/** What a file's top level is made of: the Segment's children by name, in order, each run of the same said once. */
export interface Layout {
  names: string[]
  /** False for a Segment of unknown size, as a recording that is still being written has it. */
  segmentSized: boolean
  /** False when any Cluster has the unknown size. */
  clustersSized: boolean
}

const NAMES = new Map<number, string>(Object.entries(ID).map(([name, id]) => [id, name]))

/** The layout of a Matroska file (`walkSegment`), with the elements named as the module names them and an ID it has no name for in hex. */
export function layoutOf(bytes: Uint8Array): Layout {
  const { segment, parts } = walkSegment(bytes)
  const names: string[] = []
  for (const part of parts) {
    const name = NAMES.get(part.id) ?? `0x${part.id.toString(16)}`
    if (names.at(-1) !== name) names.push(name)
  }
  return {
    names,
    segmentSized: segment.sized,
    clustersSized: parts.every((part) => part.id !== ID.Cluster || part.sized),
  }
}

/** The changes a rewrite makes. */
export interface Changes {
  /** The frames of every track with this CodecID, `count` (2 to 256) to a block, laced as `lacing` says. */
  lace?: { codec: string; count: number; lacing: Lacing }
  /** Header stripping: `prefix` is taken off the start of every frame of every track with this CodecID, and the track says so in a ContentEncoding. */
  strip?: { codec: string; prefix: Uint8Array }
  /** A Dolby Vision configuration record (`dolbyVisionRecord`) added to the first HEVC picture. */
  dolbyVision?: { profile: number; compatibility: number }
}

/** The ID of a ContentEncoding's order, which the module doesn't read. */
const CONTENT_ENCODING_ORDER = 0x5031

/** The ContentCompAlgo of header stripping, and the BlockAddIDType of Dolby Vision's `dvcC`: the four characters as a number. */
const HEADER_STRIPPING = 3
const DVCC = 0x64766343

/** The bits of a block's flags that say how the frames are laced. */
const LACING_BITS = 0x06

/** The CodecID of HEVC. */
const HEVC = 'V_MPEGH/ISO/HEVC'

/**
 * A DOVIDecoderConfigurationRecord (Dolby Vision Streams Within the ISO Base
 * Media File Format, 24 bytes): version 1.0, then the profile (7 bits), the level
 * (6), the flags that say an RPU and a base layer are present and no enhancement
 * layer, the base layer's signal compatibility (4 bits), and zeros.
 */
export function dolbyVisionRecord(profile: number, compatibility: number, level = 6): Uint8Array {
  if (!Number.isInteger(profile) || profile < 0 || profile > 127) {
    throw new RangeError(`${profile} is not a Dolby Vision profile (7 bits).`)
  }
  if (!Number.isInteger(compatibility) || compatibility < 0 || compatibility > 15) {
    throw new RangeError(`${compatibility} is not a signal compatibility ID (4 bits).`)
  }
  if (!Number.isInteger(level) || level < 0 || level > 63) {
    throw new RangeError(`${level} is not a Dolby Vision level (6 bits).`)
  }
  const out = new Uint8Array(24)
  out[0] = 1
  // The profile, the level, rpu_present_flag 1, el_present_flag 0 and bl_present_flag 1.
  const word = (profile << 9) | (level << 3) | 0b101
  out[2] = word >> 8
  out[3] = word & 0xff
  out[4] = compatibility << 4
  return out
}

/** A lace being filled: the frames that follow one another in a Cluster, and the first one's timecode and flags. */
interface Lace {
  track: number
  timecode: number
  flags: number
  frames: Uint8Array[]
}

/** The bytes of an element as the file has them. */
function raw(bytes: Uint8Array, el: Element): Uint8Array {
  return bytes.subarray(el.start, el.end)
}

/** How many bytes a block's track number takes (a vint, told by its first byte). */
function trackWidth(bytes: Uint8Array, block: Element): number {
  return Math.clz32(bytes[block.data] ?? 0) - 23
}

/** The ContentEncodings of header stripping (RFC 9559 §ContentCompAlgo 3): the first encoding, of the frames, a compression that takes `prefix` off. */
function contentEncodings(prefix: Uint8Array): Uint8Array {
  return element(
    ID.ContentEncodings,
    element(
      ID.ContentEncoding,
      uint(CONTENT_ENCODING_ORDER, 0),
      uint(ID.ContentEncodingScope, 1),
      uint(ID.ContentEncodingType, 0),
      element(
        ID.ContentCompression,
        uint(ID.ContentCompAlgo, HEADER_STRIPPING),
        binary(ID.ContentCompSettings, prefix),
      ),
    ),
  )
}

/** A BlockAdditionMapping of the `dvcC` type, around a configuration record. */
function dolbyVisionMapping(record: Uint8Array): Uint8Array {
  return element(
    ID.BlockAdditionMapping,
    uint(ID.BlockAddIDType, DVCC),
    binary(ID.BlockAddIDExtraData, record),
  )
}

/** The frame without the bytes that header stripping took, which it must start with. */
function unprefixed(frame: Uint8Array, prefix: Uint8Array, at: number): Uint8Array {
  if (frame.length <= prefix.length || prefix.some((byte, i) => frame[i] !== byte)) {
    throw new Error(
      `The frame in the block at ${at} doesn't start with the ${prefix.length} bytes to strip, or holds nothing after them.`,
    )
  }
  return frame.subarray(prefix.length)
}

/**
 * The file rewritten with the changes (see the top of this file). Throws an
 * `Error` when it can't be: a file that can't be walked, a track that can't be
 * read, a CodecID that no track has, blocks that are laced already, a frame that
 * doesn't start with the bytes to strip, or frames of different sizes under fixed
 * lacing; and a `RangeError` for a change that makes no sense (a lace of one
 * frame or of more than 256, an empty prefix, a number that doesn't fit its field).
 */
export function remux(source: Uint8Array, changes: Changes): Uint8Array {
  const { lace, strip, dolbyVision } = changes
  if (lace !== undefined && (!Number.isInteger(lace.count) || lace.count < 2 || lace.count > 256)) {
    throw new RangeError(`A lace of ${lace.count} frames: it holds 2 to 256.`)
  }
  if (strip?.prefix.length === 0) {
    throw new RangeError('There are no bytes to strip.')
  }
  const record =
    dolbyVision === undefined
      ? null
      : dolbyVisionRecord(dolbyVision.profile, dolbyVision.compatibility)

  const { header, parts } = walkSegment(source)
  const infoEl = parts.find((part) => part.id === ID.Info)
  const tracksEl = parts.find((part) => part.id === ID.Tracks)
  if (infoEl === undefined) throw new Error('The file has no Info element.')
  if (tracksEl === undefined) throw new Error('The file has no Tracks element.')

  const read = readTracks(source, tracksEl)
  if (read.damage !== null) throw read.damage
  const entries = children(source, tracksEl).filter((el) => el.id === ID.TrackEntry)
  const tracks = read.tracks
  const unreadable = tracks.find((track) => track.problem !== null)
  if (unreadable !== undefined) {
    throw new Error(`Track ${unreadable.number} can't be read: ${unreadable.problem}`)
  }

  /** The numbers of the tracks with this CodecID, at least one. */
  const numbersOf = (codec: string, to: string): Set<number> => {
    const numbers = tracks.filter((track) => track.codecId === codec).map((track) => track.number)
    if (numbers.length === 0)
      throw new Error(`The file has no track with the CodecID ${codec} to ${to}.`)
    return new Set(numbers)
  }
  const lacing = lace === undefined ? new Set<number>() : numbersOf(lace.codec, 'lace')
  const stripping = strip === undefined ? new Set<number>() : numbersOf(strip.codec, 'strip')
  const prefix = strip?.prefix ?? new Uint8Array(0)
  const dolbyAt =
    record === null
      ? -1
      : tracks.findIndex((track) => track.kind === 'video' && track.codecId === HEVC)
  if (record !== null && dolbyAt < 0) {
    throw new Error(`The file has no HEVC picture (${HEVC}) to give a Dolby Vision record.`)
  }

  const rebuiltEntries = entries.map((entry, at) => {
    const kids = children(source, entry)
    const added: Uint8Array[] = []
    const number = tracks[at]?.number ?? -1
    if (stripping.has(number)) {
      if (kids.some((kid) => kid.id === ID.ContentEncodings)) {
        throw new Error(`Track ${number} has ContentEncodings already, and is not stripped twice.`)
      }
      added.push(contentEncodings(prefix))
    }
    if (record !== null && at === dolbyAt) added.push(dolbyVisionMapping(record))
    return element(ID.TrackEntry, ...kids.map((kid) => raw(source, kid)), ...added)
  })

  /** The body of a Block or SimpleBlock with the stripped bytes taken off its frame, which it holds alone. */
  const strippedBody = (block: Element): Uint8Array => {
    const headEnd = block.data + trackWidth(source, block) + 3
    if (((source[headEnd - 1] ?? 0) & LACING_BITS) !== 0) {
      throw new Error(
        `The block at ${block.start} is laced already, and only blocks of one frame are rewritten.`,
      )
    }
    return concat(
      source.subarray(block.data, headEnd),
      unprefixed(source.subarray(headEnd, block.end), prefix, block.start),
    )
  }

  /** A SimpleBlock or BlockGroup of a track, with the stripped bytes taken off when the track is stripped. */
  const copy = (el: Element, track: number): Uint8Array => {
    if (!stripping.has(track)) return raw(source, el)
    if (el.id === ID.SimpleBlock) return element(ID.SimpleBlock, strippedBody(el))
    return element(
      ID.BlockGroup,
      ...children(source, el).map((kid) =>
        kid.id === ID.Block ? element(ID.Block, strippedBody(kid)) : raw(source, kid),
      ),
    )
  }

  /** The block of a lace: the first frame's timecode and flags, with the lacing in the flags. */
  const laced = (one: Lace): Uint8Array => {
    const block = simpleBlock({
      track: one.track,
      timecode: one.timecode,
      ...(one.frames.length > 1 && lace ? { lacing: lace.lacing } : {}),
      frames: one.frames,
    })
    const flagsAt =
      (readHeader(block, 0, block.length)?.data ?? 0) + sizeBytes(one.track).length + 2
    block[flagsAt] = (block[flagsAt] ?? 0) | (one.flags & ~LACING_BITS)
    return block
  }

  const rebuiltClusters = parts
    .filter((part) => part.id === ID.Cluster)
    .map((one) => {
      const items: (Uint8Array | Lace)[] = []
      const open = new Map<number, Lace>()
      let timestamp: Uint8Array | null = null
      for (const child of children(source, one)) {
        if (child.id === ID.Timestamp) {
          timestamp = raw(source, child)
          continue
        }
        if (child.id !== ID.SimpleBlock && child.id !== ID.BlockGroup) continue
        const block =
          child.id === ID.SimpleBlock
            ? readSimpleBlock(source, child, 0)
            : readBlockGroup(source, child, 0)
        const changed = lacing.has(block.track) || stripping.has(block.track)
        const [frame] = block.frames
        if (changed && (block.frames.length !== 1 || frame === undefined)) {
          throw new Error(
            `The block at ${child.start} is laced already, and only blocks of one frame are rewritten.`,
          )
        }
        if (
          !lacing.has(block.track) ||
          child.id === ID.BlockGroup ||
          frame === undefined ||
          !lace
        ) {
          // A BlockGroup ends the lace before it, and is copied as it is.
          open.delete(block.track)
          items.push(copy(child, block.track))
          continue
        }
        let current = open.get(block.track)
        if (current === undefined) {
          const flagsAt = child.data + trackWidth(source, child) + 2
          current = {
            track: block.track,
            timecode: block.timecode,
            flags: source[flagsAt] ?? 0,
            frames: [],
          }
          open.set(block.track, current)
          items.push(current)
        }
        const bytes = source.subarray(frame.offset, frame.offset + frame.size)
        current.frames.push(
          stripping.has(block.track) ? unprefixed(bytes, prefix, child.start) : bytes,
        )
        if (current.frames.length === lace.count) open.delete(block.track)
      }
      if (timestamp === null) throw new Error(`The Cluster at ${one.start} has no Timestamp.`)
      for (const item of items) {
        if (!(item instanceof Uint8Array) && lace?.lacing === 'fixed') {
          const [first] = item.frames
          if (item.frames.some((frame) => frame.length !== first?.length)) {
            throw new Error(
              `The frames of track ${item.track} are not all of the same size, which fixed lacing needs: the source was not constant in bit rate.`,
            )
          }
        }
      }
      return element(
        ID.Cluster,
        timestamp,
        ...items.map((item) => (item instanceof Uint8Array ? item : laced(item))),
      )
    })

  const segment = element(
    ID.Segment,
    element(ID.Info, ...children(source, infoEl).map((kid) => raw(source, kid))),
    element(ID.Tracks, ...rebuiltEntries),
    ...rebuiltClusters,
  )
  return concat(raw(source, header), segment)
}

/**
 * The file copied with the size of every Cluster written over as the unknown size,
 * in the same width, so that the file is as long as it was and nothing else is
 * touched (a Segment of unknown size stays so).
 */
export function withUnknownClusters(source: Uint8Array): Uint8Array {
  const out = Uint8Array.from(source)
  for (const part of walkSegment(source).parts) {
    if (part.id !== ID.Cluster) continue
    // The ID takes 4 bytes, and the size the rest of the header.
    const sizeAt = part.start + 4
    out.set(unknownSize(part.data - sizeAt), sizeAt)
  }
  return out
}

/** `remux` from a file to a file. */
export function remuxFile(from: string, to: string, changes: Changes): void {
  writeFileSync(to, remux(Uint8Array.from(readFileSync(from)), changes))
}

/** `withUnknownClusters` from a file to a file. */
export function withUnknownClustersFile(from: string, to: string): void {
  writeFileSync(to, withUnknownClusters(Uint8Array.from(readFileSync(from))))
}
