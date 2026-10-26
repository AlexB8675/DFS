import { Mp4Error } from '../errors.ts'
import { children, readBytes, readUint } from './ebml.ts'
import type { Element } from './ebml.ts'
import { ID } from './ids.ts'

// The blocks of a Matroska or WebM file (DESIGN.md §10.4, D45): a SimpleBlock, or
// the Block inside a BlockGroup, holds one frame of one track, or a lace of
// several (RFC 9559 §10.3), and says which track they are of, when they are
// (relative to their cluster) and, here, where each frame is in the file. Like
// the rest of the reader this one finds out where things are and copies nothing:
// a frame is a range of the file, which the caller reads when it wants it.
//
// A block starts with its track number (an EBML vint), a timecode (a signed 16-bit
// number of ticks from the cluster's) and a byte of flags. Bits 0x06 of the flags
// say how the frames are laced: not at all, or by Xiph's lacing (the sizes of all
// frames but the last as runs of 255 and a last byte), by EBML's (the first size
// as a vint, then each next size as a signed difference from the last) or by
// fixed-size lacing (no sizes: what remains, divided by the count). In every
// lacing the last frame is what remains, so that a block can't lie about its
// length, and so every size is checked: a frame is at least 1 byte (a frame of
// none is nothing a decoder can use, and a size of 0 or less is no size), and the
// sizes given leave at least 1 byte for the last frame.
//
// A frame, a size and a track number are checked against the block they are in,
// and a block that is cut short, or whose numbers don't add up, is a damaged file
// (`Mp4Error`) and never a wrong frame or an exception of the language's own.

/** What a block says: its frames are ranges of the file, with offsets in the file and not in the bytes the block was read from. */
export interface BlockFrames {
  /** The TrackNumber of the track the frames are of. */
  track: number
  /** In ticks, signed 16 bits, from the timestamp of the cluster the block is in. */
  timecode: number
  /** A SimpleBlock's keyframe flag; a BlockGroup is a keyframe when it has no ReferenceBlock, which is how Matroska says that a frame refers to no other. */
  keyframe: boolean
  /** Where each frame is in the file, in order: one frame unless the block is laced. */
  frames: { offset: number; size: number }[]
  /** The BlockDuration of a BlockGroup, in ticks; null when it has none, which a SimpleBlock never does. */
  duration: number | null
  /** Where the block's body starts in the file: for a SimpleBlock, the element's data, and for a BlockGroup, the data of its Block (which is what ffprobe gives as the packet's `pos`). */
  body: number
}

/** The bit of a SimpleBlock's flags that says the frame is a keyframe. */
const KEYFRAME = 0x80

/** The values of the two bits of the flags (`(flags >> 1) & 3`) that say how the frames are laced; the fourth, 3, is EBML's. */
const NO_LACING = 0
const XIPH_LACING = 1
const FIXED_LACING = 2

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/**
 * Runs `read`, a reader of ebml.ts, and turns its refusal into `message`: the
 * sentences of those readers count offsets in the bytes they are given, and a
 * block's are counted in the file.
 */
function inFile<T>(read: () => T, message: string): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof Mp4Error) throw damaged(message)
    throw error
  }
}

/**
 * A variable-size integer (RFC 8794 §4) at `at` of `block`: its first byte says
 * how many bytes it takes (1 to 8) by its leading 0 bits, then a 1 bit that
 * isn't part of the value, and the value is the bits after that. Null when the
 * block ends before the integer does. A first byte of 0 says more than 8 bytes,
 * and a value above 2^53 - 1 is not one a number holds exactly: both are a
 * damaged file. `ones` is whether every bit of the value is 1.
 */
function readVint(
  block: Uint8Array,
  at: number,
  start: number,
): { value: number; width: number; ones: boolean } | null {
  const first = block[at]
  if (first === undefined) return null
  if (first === 0) {
    throw damaged(
      `The block at offset ${start} has a number wider than 8 bytes: the byte at offset ${start + at} is 0.`,
    )
  }
  const width = Math.clz32(first) - 23
  if (at + width > block.length) return null
  let value = first & (0xff >> width)
  for (let i = at + 1; i < at + width; i += 1) value = value * 256 + (block[i] ?? 0)
  // Once above 2^53 - 1 it stays there, and a sum that is rounded is never back
  // below it, so this test is exact.
  if (value > Number.MAX_SAFE_INTEGER) {
    throw damaged(
      `The block at offset ${start} has a number at offset ${start + at} above 2^53 - 1, which no file has.`,
    )
  }
  return { value, width, ones: value === 2 ** (7 * width) - 1 }
}

/** The refusal for a block that ends before the sizes of its lace do. */
function sizesCutShort(start: number): Mp4Error {
  return damaged(`The block at offset ${start} ends in the middle of the sizes of its frames.`)
}

/** A frame size of 0 or less is no size, and no frame is empty. */
function checkSize(size: number, start: number): void {
  if (size < 1) {
    throw damaged(
      `The block at offset ${start} has a frame of ${size} bytes, where the least a frame has is 1.`,
    )
  }
}

/**
 * The sizes of the frames of a laced block, from the count byte at `at` of
 * `block`, and where the frames start (an offset in `block`). Each is at least
 * 1. The last frame is what remains after the sizes that are written, so that
 * the sizes can't go past the block: the others must leave it a byte at least.
 */
function lacedSizes(
  block: Uint8Array,
  at: number,
  lacing: number,
  start: number,
): { sizes: number[]; data: number } {
  const count = block[at]
  if (count === undefined) {
    throw damaged(`The block at offset ${start} is laced but ends before the count of its frames.`)
  }
  // The byte is the number of frames less 1: 0 is one frame and 255 is 256.
  const frames = count + 1
  let data = at + 1

  if (lacing === FIXED_LACING) {
    const remaining = block.length - data
    if (remaining % frames !== 0) {
      throw damaged(
        `The block at offset ${start} has ${remaining} bytes that don't divide into the ${frames} frames of its fixed-size lacing.`,
      )
    }
    const size = remaining / frames
    checkSize(size, start)
    return { sizes: new Array<number>(frames).fill(size), data }
  }

  // Every size but the last is written: Xiph's as a run of bytes of 255 and the
  // byte below 255 that ends it, EBML's as a vint for the first and then, for each
  // next, a vint less 2^(7n - 1) - 1 (n being its width in bytes), which is how it
  // says a difference that may be negative. A vint of all 1 bits is an ordinary
  // number here: the reserved one is the unknown size of an element, which a lace
  // has none of.
  const sizes: number[] = []
  for (let index = 0; index < frames - 1; index += 1) {
    let size = 0
    if (lacing === XIPH_LACING) {
      let byte = 255
      while (byte === 255) {
        const next = block[data]
        if (next === undefined) throw sizesCutShort(start)
        byte = next
        size += byte
        data += 1
      }
    } else {
      const vint = readVint(block, data, start)
      if (vint === null) throw sizesCutShort(start)
      data += vint.width
      size =
        index === 0
          ? vint.value
          : (sizes[index - 1] ?? 0) + vint.value - (2 ** (7 * vint.width - 1) - 1)
    }
    checkSize(size, start)
    sizes.push(size)
  }

  const remaining = block.length - data
  const taken = sizes.reduce((sum, size) => sum + size, 0)
  if (taken >= remaining) {
    throw damaged(
      `The block at offset ${start} has frames whose sizes leave none for its last: ${taken} bytes of the ${remaining} that follow the sizes.`,
    )
  }
  sizes.push(remaining - taken)
  return { sizes, data }
}

/**
 * The head and the frames of the block in `block`, whose first byte is at offset
 * `start` of the file. Returns the flags too, which a SimpleBlock reads its
 * keyframe from and a Block does not.
 */
function readBlock(
  block: Uint8Array,
  start: number,
): Pick<BlockFrames, 'track' | 'timecode' | 'frames'> & { flags: number } {
  const track = readVint(block, 0, start)
  if (track === null) {
    throw damaged(`The block at offset ${start} ends in the middle of its track number.`)
  }
  if (track.value === 0 || track.ones) {
    throw damaged(
      `The block at offset ${start} has a track number of ${track.value === 0 ? '0' : 'all 1 bits'}, which is no track's.`,
    )
  }

  // The timecode (2 bytes) and the flags (1) follow the track number.
  let at = track.width
  if (at + 3 > block.length) {
    throw damaged(`The block at offset ${start} ends before its timecode and its flags do.`)
  }
  const timecode = ((((block[at] ?? 0) << 8) | (block[at + 1] ?? 0)) << 16) >> 16
  const flags = block[at + 2] ?? 0
  at += 3

  // A block with no lacing is one frame, the rest of it.
  const lacing = (flags >> 1) & 3
  let laced: { sizes: number[]; data: number }
  if (lacing === NO_LACING) {
    checkSize(block.length - at, start)
    laced = { sizes: [block.length - at], data: at }
  } else {
    laced = lacedSizes(block, at, lacing, start)
  }
  const frames: { offset: number; size: number }[] = []
  let offset = start + laced.data
  for (const size of laced.sizes) {
    frames.push({ offset, size })
    offset += size
  }
  return { track: track.value, timecode, frames, flags }
}

/**
 * The block of a SimpleBlock element `el` in `bytes`, whose first byte is at
 * offset `base` of the file: its track, its timecode, its keyframe flag and where
 * its frames are in the file. Its `body` is the element's data. A SimpleBlock
 * holds no BlockDuration, so `duration` is null.
 */
export function readSimpleBlock(bytes: Uint8Array, el: Element, base: number): BlockFrames {
  const body = base + el.data
  if (!el.sized) {
    throw damaged(
      `The block at offset ${body} has an unknown size, which only a Segment or a Cluster may have.`,
    )
  }
  const block = inFile(
    () => readBytes(bytes, el),
    `The block at offset ${body} is not all in the bytes that were read: they end at offset ${base + bytes.length} and the block at ${base + el.end}.`,
  )
  const { track, timecode, frames, flags } = readBlock(block, body)
  return { track, timecode, keyframe: (flags & KEYFRAME) !== 0, frames, duration: null, body }
}

/**
 * The block of a BlockGroup element `el` in `bytes`, whose first byte is at offset
 * `base` of the file: the frames of its Block, and its BlockDuration (null when it
 * has none). It is a keyframe when it has no ReferenceBlock: the keyframe bit of
 * the Block's own flags is not used. Only the first Block, BlockDuration and
 * ReferenceBlock of the group count, and its other children (BlockAdditions,
 * DiscardPadding and the rest) are passed over. Its `body` is the data of the
 * Block, not of the group.
 */
export function readBlockGroup(bytes: Uint8Array, el: Element, base: number): BlockFrames {
  if (!el.sized) {
    throw damaged(
      `The block group at offset ${base + el.start} has an unknown size, which only a Segment or a Cluster may have.`,
    )
  }
  const found = inFile(
    () => children(bytes, el),
    `The block group at offset ${base + el.start} is damaged inside: one of its elements is malformed, is cut short or runs past the group's end.`,
  )
  const block = found.find((child) => child.id === ID.Block)
  if (block === undefined) {
    throw damaged(`The block group at offset ${base + el.start} has no Block.`)
  }
  const duration = found.find((child) => child.id === ID.BlockDuration)
  const body = base + block.data
  const { track, timecode, frames } = readBlock(readBytes(bytes, block), body)
  return {
    track,
    timecode,
    keyframe: !found.some((child) => child.id === ID.ReferenceBlock),
    frames,
    duration:
      duration === undefined
        ? null
        : inFile(
            () => readUint(bytes, duration),
            `The block duration at offset ${base + duration.start} is no integer a number holds: it is wider than 8 bytes or above 2^53 - 1.`,
          ),
    body,
  }
}
