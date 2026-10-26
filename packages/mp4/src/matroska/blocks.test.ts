import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import { concat } from '../testing/build.ts'
import type { Part } from '../testing/build.ts'
import {
  blockGroup,
  element,
  elementSized,
  int,
  simpleBlock,
  uint,
  unknownSize,
} from '../testing/ebml.ts'
import type { Lacing } from '../testing/ebml.ts'
import { readBlockGroup, readSimpleBlock } from './blocks.ts'
import type { BlockFrames } from './blocks.ts'
import { readHeader } from './ebml.ts'
import type { Element } from './ebml.ts'
import { ID } from './ids.ts'

// The blocks are read from the bytes the builder writes, which lays each lacing
// out as RFC 9559 §10.3 does, and from bytes written here by hand, so that the
// reader is held to the standard and not only to the builder (DESIGN.md §10.4).

/** Where the first byte of the bytes read is in the file, so that no offset is its own by luck. */
const BASE = 1000

/** Bytes that stand before the element read, so that it doesn't start at 0. */
const PREFIX = [9, 9, 9]

/** What `run` throws, which must be an `Mp4Error` that calls the file damaged. */
function damaged(run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe('damaged')
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error')
}

interface Read {
  out: BlockFrames
  bytes: Uint8Array
  el: Element
  /** The bytes of each frame, as they stand in the file. */
  payloads: number[][]
}

/** An element placed after the prefix, with its header read back. */
function placed(whole: Uint8Array): { bytes: Uint8Array; el: Element } {
  const bytes = concat(PREFIX, whole)
  const el = readHeader(bytes, PREFIX.length, bytes.length)
  if (el === null) throw new Error('expected a whole header')
  return { bytes, el }
}

/**
 * Reads with `reader`, and holds what it finds to the rules of any block: its
 * frames follow one another from the first byte after the head to the end of the
 * block (the end of the element, for a SimpleBlock), with none empty, and they are
 * offsets in the file (counted from BASE).
 */
function readWith(
  reader: (bytes: Uint8Array, el: Element, base: number) => BlockFrames,
  whole: Uint8Array,
  endsWithElement: boolean,
): Read {
  const { bytes, el } = placed(whole)
  const out = reader(bytes, el, BASE)
  expect(out.frames.length).toBeGreaterThan(0)
  const first = out.frames[0]
  if (first === undefined) throw new Error('expected a frame')
  expect(first.offset).toBeGreaterThan(out.body)
  let at = first.offset
  for (const frame of out.frames) {
    expect(frame.offset).toBe(at)
    expect(frame.size).toBeGreaterThanOrEqual(1)
    at += frame.size
  }
  // A SimpleBlock ends where its element does; a Block may be followed in its group by other children.
  if (endsWithElement) expect(at).toBe(BASE + el.end)
  else expect(at).toBeLessThanOrEqual(BASE + el.end)
  const payloads = out.frames.map((frame) =>
    Array.from(bytes.subarray(frame.offset - BASE, frame.offset - BASE + frame.size)),
  )
  return { out, bytes, el, payloads }
}

function simple(whole: Uint8Array): Read {
  return readWith(readSimpleBlock, whole, true)
}

function group(whole: Uint8Array): Read {
  return readWith(readBlockGroup, whole, false)
}

/** A frame of `size` bytes that are all `fill`, which is told from the others by its content. */
function frame(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill)
}

/** The bytes of a frame, as numbers, which show in a failure as the values they are. */
function content(frames: Uint8Array[]): number[][] {
  return frames.map((one) => Array.from(one))
}

/** A SimpleBlock of the body it is given by hand, which need not be one a file holds. */
function raw(...body: Part[]): Uint8Array {
  return element(ID.SimpleBlock, ...body)
}

/** The least of a block: the track 1, the timecode 0 and flags that say `lacing` (0x02 Xiph, 0x04 fixed-size, 0x06 EBML). */
function head(flags = 0): number[] {
  return [0x81, 0x00, 0x00, flags]
}

/** What a refused SimpleBlock says, which must name the offset of its body in the file (BASE and where its data starts). */
function refused(whole: Uint8Array): Mp4Error {
  const { bytes, el } = placed(whole)
  const error = damaged(() => readSimpleBlock(bytes, el, BASE))
  expect(error.message).toContain(String(BASE + el.data))
  return error
}

describe('a SimpleBlock (§10.4)', () => {
  it('reads the track, the timecode, the keyframe flag and the frame of an unlaced block', () => {
    const data = new Uint8Array([4, 5, 6, 7])
    const { out, el, payloads } = simple(
      simpleBlock({ track: 1, timecode: 33, keyframe: true, frames: [data] }),
    )
    // The head is the track (1 byte), the timecode (2) and the flags (1).
    expect(out).toEqual({
      track: 1,
      timecode: 33,
      keyframe: true,
      frames: [{ offset: BASE + el.data + 4, size: 4 }],
      duration: null,
      body: BASE + el.data,
    })
    expect(payloads).toEqual([[4, 5, 6, 7]])
  })

  it('reads a block without the keyframe flag as no keyframe', () => {
    const { out } = simple(simpleBlock({ track: 1, timecode: 0, keyframe: false, frames: [[1]] }))
    expect(out.keyframe).toBe(false)
    expect(simple(simpleBlock({ track: 1, timecode: 0, frames: [[1]] })).out.keyframe).toBe(false)
  })

  it('takes the flag from bit 0x80 alone, leaving the other flags (invisible, discardable) out of it', () => {
    // 0x08 invisible and 0x01 discardable do not make a keyframe; 0x80 with them does.
    expect(simple(raw(head(0x09), [1, 2])).out.keyframe).toBe(false)
    const { out, payloads } = simple(raw(head(0x89), [1, 2]))
    expect(out.keyframe).toBe(true)
    // And they do not lace it.
    expect(payloads).toEqual([[1, 2]])
  })

  it("says where the block's body starts: the element's data, in the file", () => {
    const { out, el } = simple(simpleBlock({ track: 1, timecode: 0, frames: [[1, 2, 3]] }))
    expect(out.body).toBe(BASE + el.data)
    expect(el.data).toBeGreaterThan(PREFIX.length)
    // Counted from the base it is given, whatever that is.
    const { bytes } = placed(simpleBlock({ track: 1, timecode: 0, frames: [[1, 2, 3]] }))
    const again = readSimpleBlock(bytes, el, 0)
    expect(again.body).toBe(el.data)
    expect(again.frames).toEqual([{ offset: el.data + 4, size: 3 }])
    const far = readSimpleBlock(bytes, el, 2 ** 40)
    expect(far.body).toBe(2 ** 40 + el.data)
    expect(far.frames).toEqual([{ offset: 2 ** 40 + el.data + 4, size: 3 }])
  })

  it('reads a track number of 1 to 8 bytes, as a vint with its length marker taken off', () => {
    // Track 200 is the 2-byte vint 0x40C8: its frame starts a byte later.
    const wide = simple(simpleBlock({ track: 200, timecode: 0, frames: [[1]] }))
    expect(wide.out.track).toBe(200)
    expect(wide.out.frames).toEqual([{ offset: BASE + wide.el.data + 5, size: 1 }])

    // 127 is a vint of 2 bytes, since 0xFF is the one byte of all 1 bits.
    expect(simple(simpleBlock({ track: 127, timecode: 0, frames: [[1]] })).out.track).toBe(127)
    expect(simple(simpleBlock({ track: 128, timecode: 0, frames: [[1]] })).out.track).toBe(128)

    // A writer may give a number more bytes than it needs: track 1 as 0x4001 and as 8 bytes.
    const padded = simple(raw([0x40, 0x01, 0, 0, 0], [7]))
    expect(padded.out.track).toBe(1)
    expect(padded.out.frames).toEqual([{ offset: BASE + padded.el.data + 5, size: 1 }])
    const longest = simple(raw([0x01, 0, 0, 0, 0, 0, 0, 0x05, 0, 0, 0], [7]))
    expect(longest.out.track).toBe(5)
    expect(longest.out.frames).toEqual([{ offset: BASE + longest.el.data + 11, size: 1 }])

    // The widths between, up to the 7 bytes that the builder writes, and then the 8 of 2^53 - 1.
    for (const track of [16383, 2 ** 21, 2 ** 28, 2 ** 35, 2 ** 42, 2 ** 49 - 2]) {
      expect(simple(simpleBlock({ track, timecode: 0, frames: [[1]] })).out.track).toBe(track)
    }
    const top = simple(raw([0x01, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0], [7]))
    expect(top.out.track).toBe(2 ** 53 - 1)
  })

  it('reads the timecode as a signed 16-bit number, big-endian', () => {
    for (const timecode of [0, 1, 256, -1, -5, 33, 32767, -32768]) {
      const { out } = simple(simpleBlock({ track: 1, timecode, frames: [[1]] }))
      expect(out.timecode).toBe(timecode)
    }
    // By hand: 0xFFFB is -5, 0x0100 is 256 and not 1, 0x8000 is -32768.
    expect(simple(raw([0x81, 0xff, 0xfb, 0x80], [1])).out.timecode).toBe(-5)
    expect(simple(raw([0x81, 0x01, 0x00, 0x80], [1])).out.timecode).toBe(256)
    expect(simple(raw([0x81, 0x80, 0x00, 0x80], [1])).out.timecode).toBe(-32768)
  })

  it('reads a block from bytes that are a view onto more, as the bytes of a read chunk are', () => {
    const whole = simpleBlock({ track: 1, timecode: 2, keyframe: true, frames: [[8, 9]] })
    const backing = new Uint8Array(40)
    backing.set(whole, 11)
    // The view starts 8 bytes in, so the element starts 3 bytes into it.
    const view = backing.subarray(8, 11 + whole.length)
    const el = readHeader(view, 3, view.length)
    if (el === null) throw new Error('expected a header')
    const out = readSimpleBlock(view, el, BASE)
    expect(out).toEqual({
      track: 1,
      timecode: 2,
      keyframe: true,
      frames: [{ offset: BASE + el.data + 4, size: 2 }],
      duration: null,
      body: BASE + el.data,
    })
  })
})

describe('lacing (§10.4)', () => {
  it('reads Xiph lacing: each size but the last as runs of 255 and a last byte, the last frame the rest', () => {
    const frames = [frame(300, 1), frame(255, 2), frame(10, 3)]
    const { out, el, payloads } = simple(
      simpleBlock({ track: 1, timecode: 0, lacing: 'xiph', frames }),
    )
    expect(out.frames.map((one) => one.size)).toEqual([300, 255, 10])
    // The head (4 bytes), the count (1) and the sizes of 300 (255, 45) and 255 (255, 0).
    expect(out.frames[0]?.offset).toBe(BASE + el.data + 4 + 1 + 4)
    expect(payloads).toEqual(content(frames))
  })

  it('reads EBML lacing: the first size as a vint, then each next size as the last plus a signed difference', () => {
    const frames = [frame(800, 1), frame(500, 2), frame(1000, 3), frame(20, 4)]
    const { out, el, payloads } = simple(
      simpleBlock({ track: 1, timecode: 0, lacing: 'ebml', frames }),
    )
    // 800 is 2 bytes; -300 and 500 are 2 bytes each, offset by 8191: the second is a negative difference.
    expect(out.frames.map((one) => one.size)).toEqual([800, 500, 1000, 20])
    expect(out.frames[0]?.offset).toBe(BASE + el.data + 4 + 1 + 6)
    expect(payloads).toEqual(content(frames))
  })

  it('reads EBML differences of every width, positive and negative', () => {
    // A difference of one byte (-10 and 5), of three (+8990 and -8990) and of one that is 0.
    for (const sizes of [
      [100, 90, 95, 5],
      [10, 9000, 20],
      [9000, 10, 20],
      [64, 64, 64, 64, 64],
      [1, 64, 1, 64],
      [63, 1, 64, 2],
    ]) {
      const frames = sizes.map((size, index) => frame(size, index + 1))
      const { out, payloads } = simple(
        simpleBlock({ track: 1, timecode: 0, lacing: 'ebml', frames }),
      )
      expect(out.frames.map((one) => one.size)).toEqual(sizes)
      expect(payloads).toEqual(content(frames))
    }
  })

  it('reads fixed-size lacing: what remains, divided by the count', () => {
    const frames = [1, 2, 3, 4].map((fill) => frame(192, fill))
    const { out, el, payloads } = simple(
      simpleBlock({ track: 1, timecode: 0, lacing: 'fixed', frames }),
    )
    expect(out.frames.map((one) => one.size)).toEqual([192, 192, 192, 192])
    // The head (4 bytes) and the count (1): no sizes.
    expect(out.frames[0]?.offset).toBe(BASE + el.data + 5)
    expect(payloads).toEqual(content(frames))
  })

  it('reads a laced block of one frame, whose count byte is 0, in every lacing', () => {
    for (const lacing of ['xiph', 'ebml', 'fixed'] as Lacing[]) {
      const { out, el, payloads } = simple(
        simpleBlock({ track: 1, timecode: 0, lacing, frames: [[7, 8, 9]] }),
      )
      expect(out.frames).toEqual([{ offset: BASE + el.data + 5, size: 3 }])
      expect(payloads).toEqual([[7, 8, 9]])
    }
  })

  it('reads a count byte of 255 as 256 frames', () => {
    for (const lacing of ['xiph', 'ebml', 'fixed'] as Lacing[]) {
      const frames = Array.from({ length: 256 }, (_, index) =>
        frame(1 + (lacing === 'fixed' ? 0 : index % 3), index),
      )
      const { out, payloads } = simple(simpleBlock({ track: 1, timecode: 0, lacing, frames }))
      expect(out.frames).toHaveLength(256)
      expect(payloads).toEqual(content(frames))
    }
  })

  it('reads the lacing from bits 0x06 of the flags, whether or not the keyframe flag is set', () => {
    // Flags 0x82 are a keyframe and Xiph; 0x84 a keyframe and fixed-size; 0x86 a keyframe and EBML.
    const xiph = simple(raw(head(0x82), [2, 1, 3], [1, 2, 3, 4, 5, 6]))
    expect(xiph.out.keyframe).toBe(true)
    expect(xiph.payloads).toEqual([[1], [2, 3, 4], [5, 6]])
    const fixed = simple(raw(head(0x84), [3], [1, 2, 3, 4, 5, 6, 7, 8]))
    expect(fixed.payloads).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ])
    // 0x82 is the first size 2, and 0xBF the difference 0: three frames of 2.
    const ebml = simple(raw(head(0x86), [2, 0x82, 0xbf], [1, 2, 3, 4, 5, 6]))
    expect(ebml.out.keyframe).toBe(true)
    expect(ebml.payloads).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ])
  })
})

describe('lacing written by hand as RFC 9559 §10.3 has it (§10.4)', () => {
  it('reads Xiph lacing', () => {
    // Flags 0x02; the count 2 is 3 frames; the sizes 3 and 2; the last frame is what is left.
    const { out, payloads } = simple(
      raw(head(0x02), [2, 3, 2], [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
    )
    expect(out.frames.map((one) => one.size)).toEqual([3, 2, 1])
    expect(payloads).toEqual([[0xaa, 0xbb, 0xcc], [0xdd, 0xee], [0xff]])
  })

  it('reads Xiph lacing whose size is 255 and then a byte of 0, and one of two runs of 255', () => {
    const big = concat([2, 255, 0, 5], frame(255, 1), frame(5, 2), frame(3, 3))
    expect(simple(raw(head(0x02), big)).out.frames.map((one) => one.size)).toEqual([255, 5, 3])
    // 510 is 255, 255 and 0; 511 is 255, 255 and 1.
    const two = concat([1, 255, 255, 0], frame(510, 1), frame(2, 2))
    expect(simple(raw(head(0x02), two)).out.frames.map((one) => one.size)).toEqual([510, 2])
    const three = concat([1, 255, 255, 1], frame(511, 1), frame(2, 2))
    expect(simple(raw(head(0x02), three)).out.frames.map((one) => one.size)).toEqual([511, 2])
  })

  it('reads EBML lacing, with the example sizes of the standard', () => {
    // 800 is 0x4320, -300 is 0x5ED3 and 500 is 0x61F3; the last frame, of 20, is the rest.
    const body = concat([3, 0x43, 0x20, 0x5e, 0xd3, 0x61, 0xf3], new Uint8Array(2320))
    const { out } = simple(raw(head(0x06), body))
    expect(out.frames.map((one) => one.size)).toEqual([800, 500, 1000, 20])

    // One byte: 3 is 0x83, and a difference of -1 is 62, which is 0xBE: the sizes are 3, 2 and the rest.
    const { payloads } = simple(raw(head(0x06), [2, 0x83, 0xbe], [1, 2, 3, 4, 5, 6]))
    expect(payloads).toEqual([[1, 2, 3], [4, 5], [6]])
  })

  it('reads EBML sizes in the width their first byte says, and takes the value with its marker off', () => {
    // 3 as a vint of 2 bytes (0x4003) and of 3 (0x200003): a writer may use more than it needs.
    const { payloads } = simple(raw(head(0x06), [1, 0x40, 0x03], [1, 2, 3, 4]))
    expect(payloads).toEqual([[1, 2, 3], [4]])
    expect(simple(raw(head(0x06), [1, 0x20, 0x00, 0x03], [1, 2, 3, 4])).payloads).toEqual([
      [1, 2, 3],
      [4],
    ])
    // A difference of 0 in 2 bytes is 8191 = 0x1FFF, with the marker 0x5FFF.
    expect(simple(raw(head(0x06), [2, 0x82, 0x5f, 0xff], [1, 2, 3, 4, 5])).payloads).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ])
  })

  it('reads fixed-size lacing', () => {
    // Flags 0x04; the count 2 is 3 frames; no sizes: the six bytes that remain are three frames of two.
    const { payloads } = simple(raw(head(0x04), [2, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]))
    expect(payloads).toEqual([
      [0x11, 0x22],
      [0x33, 0x44],
      [0x55, 0x66],
    ])
  })
})

describe('a BlockGroup (§10.4)', () => {
  it('is a keyframe when it has no ReferenceBlock, and is not when it has one', () => {
    const frames = [[1, 2, 3]]
    const none = group(blockGroup({ track: 1, timecode: 0, frames }))
    expect(none.out.keyframe).toBe(true)
    for (const reference of [-33, 33, 0]) {
      const some = group(blockGroup({ track: 1, timecode: 0, reference, frames }))
      expect(some.out.keyframe).toBe(false)
    }
  })

  it("does not use the Block's own keyframe bit: the reference decides", () => {
    // A Block whose flags say 0x80 is not a keyframe with a reference, and one whose flags don't is one without.
    const flagged = element(ID.Block, head(0x80), [1])
    const unflagged = element(ID.Block, head(0x00), [1])
    const reference = int(ID.ReferenceBlock, -2)
    expect(group(element(ID.BlockGroup, flagged, reference)).out.keyframe).toBe(false)
    expect(group(element(ID.BlockGroup, flagged)).out.keyframe).toBe(true)
    expect(group(element(ID.BlockGroup, unflagged)).out.keyframe).toBe(true)
    expect(group(element(ID.BlockGroup, unflagged, reference)).out.keyframe).toBe(false)
  })

  it('reads the BlockDuration, and says null when it has none', () => {
    const sixty = group(blockGroup({ track: 1, timecode: 0, duration: 60, frames: [[1]] }))
    expect(sixty.out.duration).toBe(60)
    expect(group(blockGroup({ track: 1, timecode: 0, frames: [[1]] })).out.duration).toBeNull()
    // A duration of 0 is a duration; one of 8 bytes is read in full.
    expect(
      group(blockGroup({ track: 1, timecode: 0, duration: 0, frames: [[1]] })).out.duration,
    ).toBe(0)
    const wide = element(
      ID.BlockGroup,
      element(ID.Block, head(), [1]),
      uint(ID.BlockDuration, 2 ** 40),
    )
    expect(group(wide).out.duration).toBe(2 ** 40)
  })

  it("reads the track, the timecode and the frame of its Block, and gives the Block's data as the body", () => {
    const whole = blockGroup({
      track: 200,
      timecode: -5,
      duration: 40,
      reference: -2,
      frames: [[4, 5, 6]],
    })
    const { out, bytes, el } = group(whole)
    // The body is the Block's data and not the group's: the Block's header is 2 bytes (0xA1, then its size).
    expect(out.body).toBe(BASE + el.data + 2)
    expect(out).toEqual({
      track: 200,
      timecode: -5,
      keyframe: false,
      frames: [{ offset: out.body + 5, size: 3 }],
      duration: 40,
      body: out.body,
    })
    expect(Array.from(bytes.subarray(out.body - BASE, out.body - BASE + 5))).toEqual([
      0x40, 0xc8, 0xff, 0xfb, 0x00,
    ])
  })

  it('splits the frames of a laced Block', () => {
    for (const lacing of ['xiph', 'ebml', 'fixed'] as Lacing[]) {
      const frames = [frame(192, 1), frame(192, 2), frame(192, 3)]
      const { out, payloads } = group(
        blockGroup({ track: 1, timecode: 0, duration: 90, lacing, frames }),
      )
      expect(out.frames.map((one) => one.size)).toEqual([192, 192, 192])
      expect(out.duration).toBe(90)
      expect(payloads).toEqual(content(frames))
    }
  })

  it('reads the Block, the duration and the reference wherever they stand in the group', () => {
    const block = element(ID.Block, head(), [1, 2])
    const duration = uint(ID.BlockDuration, 7)
    const reference = int(ID.ReferenceBlock, -1)
    const { out } = group(element(ID.BlockGroup, reference, duration, block))
    expect(out.duration).toBe(7)
    expect(out.keyframe).toBe(false)
    expect(out.frames).toHaveLength(1)
  })

  it('passes over the other children of a group, and the Void and CRC-32 ones', () => {
    const block = element(ID.Block, head(), [1, 2])
    const additions = element(0x75a1, element(0xa6, element(0xee, [1]), element(0xa5, [9, 9])))
    const discard = element(0x75a2, [0xff, 0xff])
    const { out, payloads } = group(
      element(
        ID.BlockGroup,
        element(ID.CRC32, [0, 0, 0, 0]),
        element(ID.Void, [0, 0]),
        additions,
        block,
        discard,
        element(ID.Void),
        uint(ID.BlockDuration, 3),
      ),
    )
    expect(out.duration).toBe(3)
    expect(out.keyframe).toBe(true)
    expect(payloads).toEqual([[1, 2]])
  })

  it('counts only the first Block, the first BlockDuration and the first ReferenceBlock', () => {
    const first = element(ID.Block, head(), [1])
    const second = element(ID.Block, [0x82, 0x00, 0x00, 0x00], [2, 2])
    const { out, payloads } = group(
      element(
        ID.BlockGroup,
        first,
        second,
        uint(ID.BlockDuration, 5),
        uint(ID.BlockDuration, 99),
        int(ID.ReferenceBlock, -1),
        int(ID.ReferenceBlock, -2),
      ),
    )
    expect(out.track).toBe(1)
    expect(out.duration).toBe(5)
    expect(out.keyframe).toBe(false)
    expect(payloads).toEqual([[1]])
  })

  it('does not read the ReferenceBlock, which says only that the block refers to another', () => {
    // Its value is nothing the reader needs, so a reference that is no integer does not turn the file away.
    const bad = element(ID.ReferenceBlock, new Uint8Array(9))
    const { out } = group(element(ID.BlockGroup, element(ID.Block, head(), [1]), bad))
    expect(out.keyframe).toBe(false)
  })
})

describe('a block that is damaged (§10.4)', () => {
  it('refuses fixed-size lacing whose bytes the count does not divide', () => {
    // 7 bytes over 2 frames.
    const error = refused(raw(head(0x04), [1], [1, 2, 3, 4, 5, 6, 7]))
    expect(error.message).toMatch(/divide/)
  })

  it('refuses fixed-size lacing that has no bytes for its frames', () => {
    refused(raw(head(0x04), [3]))
    refused(raw(head(0x04), [0]))
  })

  it('refuses Xiph sizes that go past the block', () => {
    // 2 frames; the first claims 200 bytes, and 2 follow.
    refused(raw(head(0x02), [1, 200], [5, 5]))
    // The sizes 100 and 100 with 150 bytes behind them.
    refused(raw(head(0x02), [2, 100, 100], new Uint8Array(150)))
  })

  it('refuses sizes that leave no byte for the last frame', () => {
    // Xiph: the first frame takes all 3 that follow; the last has none.
    refused(raw(head(0x02), [1, 3], [1, 2, 3]))
    // The same in EBML lacing (3 is 0x83), and a size of 3 over 2 frames that fills them.
    refused(raw(head(0x06), [1, 0x83], [1, 2, 3]))
  })

  it('refuses a Xiph size of 0', () => {
    refused(raw(head(0x02), [1, 0], [1, 2, 3]))
    // The second of three is 0.
    refused(raw(head(0x02), [2, 4, 0], [1, 2, 3, 4, 5, 6]))
  })

  it('refuses Xiph sizes that the block ends in the middle of', () => {
    // The count says 3 frames and the sizes stop after the first; and a run of 255 that never ends.
    refused(raw(head(0x02), [2, 1]))
    refused(raw(head(0x02), [1, 255, 255]))
    refused(raw(head(0x02), [1]))
  })

  it('refuses an EBML size of 0, of less than 0 and past the block', () => {
    // A first size of 0 (0x80).
    refused(raw(head(0x06), [1, 0x80], [1, 2, 3]))
    // 3 and then a difference of -3 (60, 0xBC) is 0; a difference of -4 (0xBB) is -1.
    refused(raw(head(0x06), [2, 0x83, 0xbc], [1, 2, 3, 4, 5, 6]))
    refused(raw(head(0x06), [2, 0x83, 0xbb], [1, 2, 3, 4, 5, 6]))
    // A first size of 100 over a block of 10.
    refused(raw(head(0x06), [1, 0xe4], new Uint8Array(10)))
    // 3 and then +100, which in 2 bytes is 8191 + 100 = 8291 = 0x2063, so 0x6063: 103 over 8 bytes.
    refused(raw(head(0x06), [2, 0x83, 0x60, 0x63], new Uint8Array(8)))
  })

  it('refuses EBML sizes that the block ends in the middle of', () => {
    // A vint of 2 bytes whose second byte is not there, and a second size that is not there.
    expect(refused(raw(head(0x06), [1, 0x40])).message).toMatch(/sizes of its frames/)
    expect(refused(raw(head(0x06), [2, 0x83])).message).toMatch(/sizes of its frames/)
    // Sizes of 3 and 3 with nothing after them.
    refused(raw(head(0x06), [2, 0x83, 0xbf]))
    // A vint of more than 8 bytes (a first byte of 0), and one above 2^53 - 1.
    refused(raw(head(0x06), [1, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9]))
    refused(raw(head(0x06), [1, 0x01, 0x20, 0, 0, 0, 0, 0, 0], new Uint8Array(20)))
  })

  it('refuses a laced block that ends before its count', () => {
    for (const flags of [0x02, 0x04, 0x06]) refused(raw(head(flags)))
  })

  it('refuses a block of no frame at all, which has no size to be a frame', () => {
    refused(raw(head(0x00)))
    refused(raw(head(0x80)))
  })

  it('refuses a head that the block ends in the middle of', () => {
    // Nothing, or a track number and not all of the timecode and the flags after it.
    expect(refused(raw([])).message).toMatch(/track number/)
    for (const body of [[0x81], [0x81, 0x00], [0x81, 0x00, 0x00], [0x40, 0x01, 0x00]]) {
      expect(refused(raw(body)).message).toMatch(/timecode and its flags/)
    }
    // A track number whose bytes are not all there: 2 bytes with the first, and 8 with 7.
    expect(refused(raw([0x40])).message).toMatch(/track number/)
    expect(refused(raw([0x01, 0, 0, 0, 0, 0, 0])).message).toMatch(/track number/)
  })

  it('refuses a track number of 0, of all 1 bits, wider than 8 bytes or above 2^53 - 1', () => {
    refused(raw([0x80, 0x00, 0x00, 0x80], [1]))
    refused(raw([0x40, 0x00, 0x00, 0x00, 0x80], [1]))
    // All value bits 1: 0xFF, 0x7FFF, and the 8 bytes of them (which are above 2^53 - 1 as well).
    refused(raw([0xff, 0x00, 0x00, 0x80], [1]))
    refused(raw([0x7f, 0xff, 0x00, 0x00, 0x80], [1]))
    refused(raw([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x80], [1]))
    // A first byte of 0 is a number wider than 8 bytes.
    refused(raw([0x00, 0x01, 0x00, 0x00, 0x80], [1]))
    // 2^53 is one above the most a number holds exactly.
    refused(raw([0x01, 0x20, 0, 0, 0, 0, 0, 0, 0x00, 0x00, 0x80], [1]))
  })

  it('refuses a SimpleBlock of unknown size, which only a Segment or a Cluster may be', () => {
    refused(elementSized(ID.SimpleBlock, unknownSize(), head(0x80), [1, 2]))
  })

  it('names the offset of the block in the file in what it says', () => {
    const { bytes, el } = placed(raw(head(0x04), [1], [1, 2, 3]))
    const error = damaged(() => readSimpleBlock(bytes, el, 5_000_000_000))
    expect(error.message).toContain(String(5_000_000_000 + el.data))
  })

  it('refuses a BlockGroup with no Block', () => {
    const error = damaged(() => group(element(ID.BlockGroup, uint(ID.BlockDuration, 5))))
    expect(error.message).toMatch(/no Block/)
    // The group is named by where it starts in the file.
    const { bytes, el } = placed(element(ID.BlockGroup, uint(ID.BlockDuration, 5)))
    expect(damaged(() => readBlockGroup(bytes, el, BASE)).message).toContain(
      String(BASE + el.start),
    )
    // An empty group, and a group of the other children that a group has.
    damaged(() => group(element(ID.BlockGroup)))
    damaged(() => group(element(ID.BlockGroup, int(ID.ReferenceBlock, -1), element(ID.Void))))
  })

  it('refuses a BlockGroup of unknown size, and one with a child that is cut short, naming the group in the file', () => {
    // The offsets in what is said are the file's (BASE and more), and never the offsets in the bytes read.
    const named = (whole: Uint8Array): Mp4Error => {
      const { bytes, el } = placed(whole)
      const error = damaged(() => readBlockGroup(bytes, el, BASE))
      expect(error.message).toContain(String(BASE + el.start))
      return error
    }
    named(elementSized(ID.BlockGroup, unknownSize(), element(ID.Block, head(), [1])))
    // A child that claims more than the group holds, and one whose header is cut short by the group's end.
    named(element(ID.BlockGroup, element(ID.Block, head(), [1]), [0x9b, 0x84, 1]))
    named(element(ID.BlockGroup, element(ID.Block, head(), [1]), [0x9b]))
    // A child with a size of more than 8 bytes (its first byte is 0), and one of an ID of more than 4 (a first byte below 0x10).
    named(element(ID.BlockGroup, element(ID.Block, head(), [1]), [0x9b, 0x00, 1]))
    named(element(ID.BlockGroup, element(ID.Block, head(), [1]), [0x08, 0x81, 1]))
  })

  it('refuses a BlockDuration that is no integer, naming it in the file', () => {
    const block = element(ID.Block, head(), [1])
    // A duration of 9 bytes, and one above 2^53 - 1 in 8.
    for (const duration of [
      element(ID.BlockDuration, new Uint8Array(9)),
      element(ID.BlockDuration, [0x20, 0, 0, 0, 0, 0, 0, 0]),
    ]) {
      const { bytes, el } = placed(element(ID.BlockGroup, block, duration))
      const error = damaged(() => readBlockGroup(bytes, el, BASE))
      // The duration follows the Block in the group.
      expect(error.message).toContain(String(BASE + el.data + block.length))
    }
  })

  it('refuses a block that is not whole in the bytes it is read from, naming it in the file', () => {
    // An element that claims 10 bytes when 5 follow its header: the caller held too little.
    const { bytes, el } = placed(elementSized(ID.SimpleBlock, [0x8a], head(0x80), [1]))
    expect(el.end).toBeGreaterThan(bytes.length)
    const error = damaged(() => readSimpleBlock(bytes, el, BASE))
    expect(error.message).toContain(String(BASE + el.data))
  })

  it("refuses a BlockGroup whose Block is damaged, naming the Block's offset", () => {
    const whole = element(ID.BlockGroup, element(ID.Block, head(0x04), [1], [1, 2, 3, 4, 5, 6, 7]))
    const { bytes, el } = placed(whole)
    const error = damaged(() => readBlockGroup(bytes, el, BASE))
    // The Block's data starts after the group's header and the Block's own (0xA1 and a 1-byte size).
    expect(error.message).toContain(String(BASE + el.data + 2))
    damaged(() => group(element(ID.BlockGroup, element(ID.Block, [0x80, 0, 0, 0], [1]))))
    damaged(() => group(element(ID.BlockGroup, element(ID.Block, []))))
    damaged(() => group(element(ID.BlockGroup, element(ID.Block, head()))))
  })

  it('never throws anything but an Mp4Error for any cut or any broken byte of a block', () => {
    const laced: Lacing[] = ['xiph', 'ebml', 'fixed']
    const wholes = [
      simpleBlock({ track: 200, timecode: -5, keyframe: true, frames: [frame(5, 1)] }),
      ...laced.map((lacing) =>
        simpleBlock({
          track: 3,
          timecode: 7,
          lacing,
          frames: [frame(6, 1), frame(lacing === 'fixed' ? 6 : 300, 2), frame(6, 3)],
        }),
      ),
      ...laced.map((lacing) =>
        blockGroup({
          track: 3,
          timecode: 7,
          duration: 5,
          reference: -1,
          lacing,
          frames: [frame(4, 1), frame(4, 2)],
        }),
      ),
    ]
    let refusals = 0
    let reads = 0
    /** Reads the element of `id` around `body`, which must be read or refused as damaged and nothing else. */
    function attempt(id: number, body: Uint8Array): void {
      const bytes = concat(PREFIX, element(id, body))
      const el = readHeader(bytes, PREFIX.length, bytes.length)
      if (el === null) throw new Error('expected a header')
      try {
        if (id === ID.BlockGroup) readBlockGroup(bytes, el, BASE)
        else readSimpleBlock(bytes, el, BASE)
        reads += 1
      } catch (error) {
        expect(error).toBeInstanceOf(Mp4Error)
        expect((error as Mp4Error).reason).toBe('damaged')
        refusals += 1
      }
    }
    for (const whole of wholes) {
      const { bytes, el } = placed(whole)
      const body = bytes.subarray(el.data)
      // Every cut of the body, written back with the size of what is left.
      for (let cut = 0; cut <= body.length; cut += 1) attempt(el.id, body.subarray(0, cut))
      // Each of the first bytes set to a few values: IDs, sizes, the head and the sizes of the lace.
      for (let at = 0; at < Math.min(body.length, 24); at += 1) {
        for (const value of [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]) {
          const changed = Uint8Array.from(body)
          changed[at] = value
          attempt(el.id, changed)
        }
      }
    }
    // The test sees both: reads that go through and reads that are refused.
    expect(reads).toBeGreaterThan(50)
    expect(refusals).toBeGreaterThan(50)
  })
})
