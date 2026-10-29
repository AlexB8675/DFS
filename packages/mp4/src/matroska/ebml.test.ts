import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import { concat, u64 } from '../testing/build.ts'
import { binary, element, elementSized, float, string, uint, unknownSize } from '../testing/ebml.ts'
import type { Element } from './ebml.ts'
import {
  children,
  readBytes,
  readFloat,
  readHeader,
  readInt,
  readString,
  readUint,
  walkChildren,
} from './ebml.ts'
import { ID, TOP_LEVEL } from './ids.ts'

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

/** The header at `at`, which must be whole before the end of `bytes`. */
function header(bytes: Uint8Array | number[], at = 0): Element {
  const array = Uint8Array.from(bytes)
  const found = readHeader(array, at, array.length)
  if (found === null) throw new Error('expected a whole header')
  return found
}

/** An element with the id 0xE7 around `data` (up to 126 bytes), with the element read back from it. */
function holding(data: number[] | Uint8Array): { bytes: Uint8Array; el: Element } {
  const bytes = concat([0xe7, 0x80 | data.length], data)
  return { bytes, el: header(bytes) }
}

describe('an element header (§10.4)', () => {
  it('reads an ID of each width from 1 to 4 bytes', () => {
    // Two bytes before the header, so no offset is 0 by luck.
    const prefix = [9, 9]
    const cases: [number[], number][] = [
      [[0xa3], 0xa3],
      [[0x42, 0x86], 0x4286],
      [[0x2a, 0xd7, 0xb1], 0x2ad7b1],
      [[0x1a, 0x45, 0xdf, 0xa3], 0x1a45dfa3],
    ]
    for (const [id, value] of cases) {
      const bytes = Uint8Array.from([...prefix, ...id, 0x80])
      expect(readHeader(bytes, 2, bytes.length)).toEqual({
        id: value,
        start: 2,
        data: 2 + id.length + 1,
        end: 2 + id.length + 1,
        sized: true,
      })
    }
  })

  it('reads a size of each width from 1 to 8 bytes', () => {
    // `0x81`, `0x40 0x02`, and `0x01` with seven bytes behind it, as RFC 8794 writes them.
    expect(header([0xa3, 0x81, 0xff])).toMatchObject({ data: 2, end: 3, sized: true })
    expect(header([0xa3, 0x40, 0x02, 1, 2])).toMatchObject({ data: 3, end: 5, sized: true })
    const widest = [0xa3, 0x01, 0, 0, 0, 0, 0, 0, 0x05, 1, 2, 3, 4, 5]
    expect(header(widest)).toMatchObject({ id: 0xa3, start: 0, data: 9, end: 14, sized: true })

    // The same size of 5 in every width: the marker bit moves one place per byte.
    for (let width = 1; width <= 8; width += 1) {
      const size =
        width === 1 ? [0x85] : [0x80 >> (width - 1), ...new Array<number>(width - 2).fill(0), 5]
      const bytes = [0xa3, ...size, 1, 2, 3, 4, 5]
      expect(header(bytes)).toMatchObject({ data: 1 + width, end: 1 + width + 5, sized: true })
    }
  })

  it('reads a size written wider than it needs to be', () => {
    // Writers pad a size so they can come back and fill it in; 4 bytes for 1.
    expect(header([0xa3, 0x10, 0x00, 0x00, 0x01, 7])).toMatchObject({
      data: 5,
      end: 6,
      sized: true,
    })
  })

  it('reads the largest size that an end offset can hold', () => {
    const size = Number.MAX_SAFE_INTEGER - 9
    const bytes = [0xa3, 0x01, ...u64(size).slice(1)]
    expect(header(bytes)).toMatchObject({ data: 9, end: Number.MAX_SAFE_INTEGER, sized: true })
  })

  it('reads an unknown size of every width as one that runs to the limit', () => {
    for (let width = 1; width <= 8; width += 1) {
      // The marker bit, then every other bit 1: 0xFF, 0x7F 0xFF, ... 0x01 0xFF x7.
      const size = [0xff >> (width - 1), ...new Array<number>(width - 1).fill(0xff)]
      const bytes = Uint8Array.from([0x18, 0x53, 0x80, 0x67, ...size, 1, 2, 3, 4, 5, 6])
      // The caller's limit, and not the end of the bytes, is where the element ends.
      const limit = bytes.length - 2
      expect(readHeader(bytes, 0, limit)).toEqual({
        id: 0x18538067,
        start: 0,
        data: 4 + width,
        end: limit,
        sized: false,
      })
    }
  })

  it('does not take a size with a single 0 bit for an unknown one', () => {
    // 0x7F 0xFE is 16382 in 2 bytes and 0x01 0xFF x6 0xFE is 2^56 - 2, which no file has.
    expect(header([0xa3, 0x7f, 0xfe])).toMatchObject({ sized: true, end: 3 + 16382 })
    damaged(() => header([0xa3, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]))
  })

  it('refuses an ID that is wider than 4 bytes', () => {
    damaged(() => header([0x08, 0x80]))
    damaged(() => header([0x00, 0x80]))
    damaged(() => header([0x0f, 0xff, 0x80]))
  })

  it('refuses a size whose first byte is 0, which would be wider than 8 bytes', () => {
    damaged(() => header([0xa3, 0x00, 0x01]))
  })

  it('refuses a size above 2^53 - 1', () => {
    // 2^53, in 8 bytes: the marker, then 0x20 and six 0 bytes.
    damaged(() => header([0xa3, 0x01, 0x20, 0, 0, 0, 0, 0, 0]))
    // 2^56 - 2 is the largest known size that 8 bytes can write.
    damaged(() => header([0xa3, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]))
  })

  it('refuses an element whose end is not a number that holds exactly', () => {
    // A size of 2^53 - 1 is a size, but 9 bytes of header ahead of it make an end above that.
    damaged(() => header([0xa3, 0x01, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
  })

  it('gives null for a header that the limit cuts short', () => {
    const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x82, 1, 2])
    // The ID is cut: 2 of its 4 bytes.
    expect(readHeader(bytes, 0, 2)).toBeNull()
    // The ID is whole and the size isn't there.
    expect(readHeader(bytes, 0, 4)).toBeNull()
    // The size is cut: it is 2 bytes wide and one is there.
    expect(readHeader(Uint8Array.from([0xa3, 0x40, 0x02]), 0, 2)).toBeNull()
    // Nothing at all.
    expect(readHeader(bytes, 3, 3)).toBeNull()
    expect(readHeader(bytes, 7, 7)).toBeNull()
    // Whole with the very last byte the limit lets it have.
    expect(readHeader(bytes, 0, 5)).toMatchObject({ id: 0x1a45dfa3, data: 5, end: 7 })
  })

  it('refuses a malformed header even next to the limit, once the bytes that show it are there', () => {
    // The ID byte is all that shows it is too wide.
    damaged(() => readHeader(Uint8Array.from([0x08, 0x80]), 0, 1))
    // The size byte is all that shows it is too wide.
    damaged(() => readHeader(Uint8Array.from([0xa3, 0x00, 0x80]), 0, 2))
  })

  it('refuses a range that is not inside the bytes it was given', () => {
    const bytes = Uint8Array.from([0xa3, 0x80])
    damaged(() => readHeader(bytes, 0, 3))
    damaged(() => readHeader(bytes, 2, 1))
    damaged(() => readHeader(bytes, -1, 2))
  })
})

describe('the children of a master (§10.4)', () => {
  it('leaves out CRC-32 and Void wherever they stand', () => {
    const crc = element(ID.CRC32, [1, 2, 3, 4])
    const timestamp = uint(ID.Timestamp, 7)
    const voided = element(ID.Void, new Array<number>(5).fill(0))
    const block = binary(ID.SimpleBlock, [0x81, 0, 0, 0x80, 1, 2])
    const parent = element(ID.Cluster, crc, timestamp, voided, block)
    // Bytes before the cluster, and after it, so no offset is 0 or the end by luck.
    const bytes = concat([9, 9, 9], parent, [8, 8])
    const cluster = header(bytes, 3)

    const found = children(bytes, cluster)
    expect(found.map((el) => el.id)).toEqual([ID.Timestamp, ID.SimpleBlock])
    const timestampAt = cluster.data + crc.length
    const blockAt = timestampAt + timestamp.length + voided.length
    expect(found).toEqual([
      { id: 0xe7, start: timestampAt, data: timestampAt + 2, end: timestampAt + 3, sized: true },
      { id: 0xa3, start: blockAt, data: blockAt + 2, end: blockAt + block.length, sized: true },
    ])
  })

  it('leaves them out at the start, in the middle and at the end', () => {
    const crc = element(ID.CRC32, [1, 2, 3, 4])
    const voided = element(ID.Void, [0, 0])
    const timestamp = uint(ID.Timestamp, 1)
    for (const parts of [
      [crc, timestamp],
      [timestamp, voided, timestamp],
      [timestamp, voided],
      [voided, crc, voided],
    ]) {
      const bytes = element(ID.BlockGroup, ...parts)
      const found = children(bytes, header(bytes))
      expect(found.map((el) => el.id)).toEqual(
        parts.filter((part) => part !== crc && part !== voided).map(() => ID.Timestamp),
      )
    }
  })

  it('gives no children for an empty master', () => {
    const bytes = element(ID.Cluster)
    expect(children(bytes, header(bytes))).toEqual([])
  })

  it('does not look inside the children', () => {
    const inner = element(ID.TrackEntry, uint(ID.TrackNumber, 1))
    const bytes = element(ID.Tracks, inner)
    expect(children(bytes, header(bytes)).map((el) => el.id)).toEqual([ID.TrackEntry])
  })

  it('refuses a child that runs past its parent, even where there are bytes for it after', () => {
    // BlockGroup holds 3 bytes: a Timestamp that claims 2 bytes of data, of which 1 is inside.
    const bytes = Uint8Array.from([0xa0, 0x83, 0xe7, 0x82, 0x01, 0x02, 0xff])
    damaged(() => children(bytes, header(bytes)))
  })

  it('refuses a CRC-32 or Void that runs past its parent just the same', () => {
    for (const id of [ID.CRC32, ID.Void]) {
      const bytes = Uint8Array.from([0xa0, 0x83, id, 0x82, 0x01, 0x02, 0xff])
      damaged(() => children(bytes, header(bytes)))
    }
  })

  it('refuses a child whose header the parent cuts short', () => {
    // BlockGroup holds 1 byte, which is the first of a 2-byte ID.
    const bytes = Uint8Array.from([0xa0, 0x81, 0x42, 0x86, 0x80])
    damaged(() => children(bytes, header(bytes)))
    // One that holds an ID and not its size, with the size right after it.
    const idOnly = Uint8Array.from([0xa0, 0x81, 0xe7, 0x80])
    damaged(() => children(idOnly, header(idOnly)))
  })

  it('refuses a child of unknown size, which only a Segment or a Cluster may have', () => {
    const bytes = element(ID.Segment, elementSized(ID.Info, unknownSize(1), [1, 2]))
    damaged(() => children(bytes, header(bytes)))
  })

  it('refuses a child that is damaged in its own header', () => {
    // A size that starts with a 0 byte.
    const bytes = Uint8Array.from([0xa0, 0x82, 0xe7, 0x00])
    damaged(() => children(bytes, header(bytes)))
  })

  it('refuses a parent that is not inside the bytes', () => {
    const bytes = Uint8Array.from([0xa0, 0x83, 0xe7, 0x81, 0x01])
    damaged(() => children(bytes, { id: 0xa0, start: 0, data: 2, end: 9, sized: true }))
  })
})

describe('the bounded walk of the children of a master (§10.4)', () => {
  /** What the walk gives, up to the damage that stops it. */
  function walked(bytes: Uint8Array, parent: Element, most = 100): Element[] {
    return Array.from(walkChildren(bytes, parent, most))
  }

  it('gives the elements that `children` gives, with the CRC-32 and the Void left out wherever they stand', () => {
    const crc = element(ID.CRC32, [1, 2, 3, 4])
    const voided = element(ID.Void, [0, 0])
    const timestamp = uint(ID.Timestamp, 7)
    const block = binary(ID.SimpleBlock, [0x81, 0, 0, 0x80, 1, 2])
    for (const parts of [
      [],
      [crc, timestamp, voided, block],
      [timestamp, voided],
      [voided, crc, voided],
      [timestamp, block, timestamp],
    ]) {
      const bytes = concat([9, 9], element(ID.Cluster, ...parts), [8])
      const cluster = header(bytes, 2)
      expect(walked(bytes, cluster)).toEqual(children(bytes, cluster))
    }
  })

  it('refuses what `children` refuses, as a damaged file', () => {
    const cases: Uint8Array[] = [
      // A child that runs past its parent, a CRC-32 or a Void that does.
      Uint8Array.from([0xa0, 0x83, 0xe7, 0x82, 0x01, 0x02, 0xff]),
      Uint8Array.from([0xa0, 0x83, ID.CRC32, 0x82, 0x01, 0x02, 0xff]),
      Uint8Array.from([0xa0, 0x83, ID.Void, 0x82, 0x01, 0x02, 0xff]),
      // A header that the parent cuts short, and an ID with no size.
      Uint8Array.from([0xa0, 0x81, 0x42, 0x86, 0x80]),
      Uint8Array.from([0xa0, 0x81, 0xe7, 0x80]),
      // A child of unknown size, and one damaged in its own header.
      element(ID.Segment, elementSized(ID.Info, unknownSize(1), [1, 2])),
      Uint8Array.from([0xa0, 0x82, 0xe7, 0x00]),
    ]
    for (const bytes of cases) {
      const parent = header(bytes)
      const expected = damaged(() => children(bytes, parent))
      expect(damaged(() => walked(bytes, parent)).message).toBe(expected.message)
    }
    const bytes = Uint8Array.from([0xa0, 0x83, 0xe7, 0x81, 0x01])
    damaged(() => walked(bytes, { id: 0xa0, start: 0, data: 2, end: 9, sized: true }))
  })

  it('takes `most` headers, and refuses the one after them as a damaged file that says where', () => {
    const bytes = concat(
      [7],
      element(ID.BlockGroup, ...Array.from({ length: 5 }, () => uint(ID.Timestamp, 1))),
    )
    const parent = header(bytes, 1)
    expect(walked(bytes, parent, 5)).toHaveLength(5)
    expect(walked(bytes, parent, 6)).toHaveLength(5)
    const error = damaged(() => walked(bytes, parent, 4))
    expect(error.message).toContain('offset 1 has more than 4 children')
    damaged(() => walked(bytes, parent, 0))
    // An empty master has no headers to count.
    const empty = element(ID.BlockGroup)
    expect(walked(empty, header(empty), 0)).toEqual([])
  })

  it('counts a CRC-32 and a Void among the headers, though it gives neither', () => {
    for (const id of [ID.CRC32, ID.Void]) {
      const bytes = element(
        ID.BlockGroup,
        uint(ID.Timestamp, 1),
        element(id, [0, 0]),
        element(id, [0]),
      )
      const parent = header(bytes)
      expect(walked(bytes, parent, 3).map((el) => el.id)).toEqual([ID.Timestamp])
      damaged(() => walked(bytes, parent, 2))
    }
  })

  it('gives the elements before damage before it throws, and reads no further than it is asked', () => {
    // Two whole elements, then one that claims more than the parent holds.
    const bytes = element(
      ID.BlockGroup,
      uint(ID.Timestamp, 1),
      uint(ID.Timestamp, 2),
      Uint8Array.from([0xe7, 0x85, 1]),
    )
    const parent = header(bytes)
    const seen: Element[] = []
    damaged(() => {
      for (const el of walkChildren(bytes, parent, 100)) seen.push(el)
    })
    expect(seen).toHaveLength(2)
    // Taken one at a time, the damage is not met until the walk goes on to it.
    const walk = walkChildren(bytes, parent, 100)
    expect(walk.next().done).toBe(false)
    expect(walk.next().done).toBe(false)
    damaged(() => walk.next())
    // And a caller that stops after the first never meets it.
    const lazily = walkChildren(bytes, parent, 100)
    expect(lazily.next().value).toMatchObject({ id: ID.Timestamp })
    lazily.return(undefined)
  })
})

describe('the values of an element (§10.4)', () => {
  describe('readUint', () => {
    it('reads a number of each width from 1 to 8 bytes, big-endian', () => {
      const cases: [number[], number][] = [
        [[0x05], 5],
        [[0x01, 0x00], 256],
        [[0x12, 0x34, 0x56], 0x123456],
        [[0xff, 0xff, 0xff, 0xff], 0xffffffff],
        [[0x01, 0x00, 0x00, 0x00, 0x00], 2 ** 32],
        [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc], 0x123456789abc],
        [[0x01, 0, 0, 0, 0, 0, 0], 2 ** 48],
        [[0, 0, 0, 0, 0, 0, 0, 0x2a], 42],
      ]
      for (const [data, value] of cases) {
        const { bytes, el } = holding(data)
        expect(readUint(bytes, el)).toBe(value)
      }
    })

    it('reads nothing as 0', () => {
      const { bytes, el } = holding([])
      expect(readUint(bytes, el)).toBe(0)
    })

    it('reads 2^53 - 1 and refuses what is above it', () => {
      const largest = holding([0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      expect(readUint(largest.bytes, largest.el)).toBe(Number.MAX_SAFE_INTEGER)
      const above = holding([0x20, 0, 0, 0, 0, 0, 0])
      damaged(() => readUint(above.bytes, above.el))
      const widest = holding([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      damaged(() => readUint(widest.bytes, widest.el))
      const rounding = holding([0x20, 0, 0, 0, 0, 0, 0x01])
      damaged(() => readUint(rounding.bytes, rounding.el))
    })

    it('refuses a number wider than 8 bytes, even when its extra bytes are 0', () => {
      const { bytes, el } = holding([0, 0, 0, 0, 0, 0, 0, 0, 1])
      damaged(() => readUint(bytes, el))
    })

    it('refuses an element that is not inside the bytes', () => {
      damaged(() =>
        readUint(Uint8Array.from([0xe7, 0x82, 1]), {
          id: 0xe7,
          start: 0,
          data: 2,
          end: 4,
          sized: true,
        }),
      )
    })
  })

  describe('readInt', () => {
    it('reads two-complement numbers of any width', () => {
      const cases: [number[], number][] = [
        [[0xff], -1],
        [[0x80, 0x00], -32768],
        [[0x7f], 127],
        [[0x80], -128],
        [[0x00, 0xff], 255],
        [[0xff, 0xff, 0xff], -1],
        [[0x80, 0x00, 0x00, 0x00], -(2 ** 31)],
        [[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], -1],
        [[0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], Number.MAX_SAFE_INTEGER],
        [[0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01], -Number.MAX_SAFE_INTEGER],
      ]
      for (const [data, value] of cases) {
        const { bytes, el } = holding(data)
        expect(readInt(bytes, el)).toBe(value)
      }
    })

    it('reads nothing as 0', () => {
      const { bytes, el } = holding([])
      expect(readInt(bytes, el)).toBe(0)
    })

    it('refuses what a number does not hold exactly, either way', () => {
      const above = holding([0x00, 0x20, 0, 0, 0, 0, 0, 0])
      damaged(() => readInt(above.bytes, above.el))
      const below = holding([0xff, 0xe0, 0, 0, 0, 0, 0, 0])
      damaged(() => readInt(below.bytes, below.el))
      const widest = holding([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      damaged(() => readInt(widest.bytes, widest.el))
    })

    it('refuses a number wider than 8 bytes', () => {
      const { bytes, el } = holding([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
      damaged(() => readInt(bytes, el))
    })
  })

  describe('readFloat', () => {
    it('reads 4 bytes as a single and 8 as a double', () => {
      const single = float(ID.SamplingFrequency, 48000, 4)
      expect(Array.from(single)).toEqual([0xb5, 0x84, 0x47, 0x3b, 0x80, 0x00])
      expect(readFloat(single, header(single))).toBe(48000)

      const double = float(ID.SamplingFrequency, 0.1)
      expect(readFloat(double, header(double))).toBe(0.1)
      const negative = float(ID.Duration, -1234.5)
      expect(readFloat(negative, header(negative))).toBe(-1234.5)
      // The largest and the smallest numbers a float holds are numbers, and -0 is 0.
      const largest = float(ID.Duration, Number.MAX_VALUE)
      expect(readFloat(largest, header(largest))).toBe(Number.MAX_VALUE)
      const largestSingle = float(ID.Duration, 3.4028234663852886e38, 4)
      expect(readFloat(largestSingle, header(largestSingle))).toBe(3.4028234663852886e38)
      const smallest = float(ID.Duration, Number.MIN_VALUE)
      expect(readFloat(smallest, header(smallest))).toBe(Number.MIN_VALUE)
      const negativeZero = float(ID.Duration, -0)
      expect(Object.is(readFloat(negativeZero, header(negativeZero)), -0)).toBe(true)
    })

    it('refuses a value that is not a number: NaN, or infinite either way', () => {
      for (const width of [4, 8] as const) {
        for (const value of [NaN, Infinity, -Infinity]) {
          const bytes = float(ID.Duration, value, width)
          damaged(() => readFloat(bytes, header(bytes)))
        }
      }
    })

    it('refuses a NaN of any pattern of bits, not only the one that a builder writes', () => {
      // A signalling NaN, and a negative NaN with a payload, in a single and in a double.
      const patterns = [
        [0x7f, 0xa0, 0x00, 0x01],
        [0xff, 0xc0, 0x00, 0x01],
        [0x7f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01],
        [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      ]
      for (const pattern of patterns) {
        const { bytes, el } = holding(pattern)
        damaged(() => readFloat(bytes, el))
      }
    })

    it('reads nothing as 0', () => {
      const { bytes, el } = holding([])
      expect(readFloat(bytes, el)).toBe(0)
    })

    it('refuses any other width', () => {
      for (const width of [1, 2, 3, 5, 6, 7, 9, 10]) {
        const { bytes, el } = holding(new Array<number>(width).fill(0x3f))
        damaged(() => readFloat(bytes, el))
      }
    })
  })

  describe('readString', () => {
    it('reads the text up to the first 0 byte', () => {
      const padded = string(ID.DocType, 'webm\0\0')
      expect(readString(padded, header(padded))).toBe('webm')
      const plain = string(ID.CodecID, 'V_MPEG4/ISO/AVC')
      expect(readString(plain, header(plain))).toBe('V_MPEG4/ISO/AVC')
      const after = holding([0x61, 0x00, 0x62])
      expect(readString(after.bytes, after.el)).toBe('a')
    })

    it('reads nothing, or only 0 bytes, as an empty string', () => {
      const none = holding([])
      expect(readString(none.bytes, none.el)).toBe('')
      const zeros = holding([0, 0, 0])
      expect(readString(zeros.bytes, zeros.el)).toBe('')
    })

    it('reads UTF-8, and takes what is not UTF-8 for the replacement character', () => {
      const text = string(ID.Language, 'café ☃')
      expect(readString(text, header(text))).toBe('café ☃')
      const broken = holding([0x61, 0xff, 0x62])
      expect(readString(broken.bytes, broken.el)).toBe('a�b')
    })

    it('reads only the element, whatever bytes are around it', () => {
      const bytes = concat([0x61, 0x61], string(ID.Language, 'eng'), [0x62, 0x62])
      expect(readString(bytes, header(bytes, 2))).toBe('eng')
    })
  })

  describe('readBytes', () => {
    it('is a view of the bytes of the element, not a copy of them', () => {
      const bytes = concat([9, 9], binary(ID.CodecPrivate, [1, 2, 3, 4]), [8, 8])
      const el = header(bytes, 2)
      const view = readBytes(bytes, el)
      expect(Array.from(view)).toEqual([1, 2, 3, 4])
      expect(view.buffer).toBe(bytes.buffer)
      expect(view.byteOffset).toBe(bytes.byteOffset + el.data)
      bytes[el.data] = 77
      expect(view[0]).toBe(77)
    })

    it('gives no bytes for an empty element', () => {
      const bytes = binary(ID.CodecPrivate, [])
      expect(readBytes(bytes, header(bytes)).length).toBe(0)
    })

    it('refuses an element that is not inside the bytes', () => {
      damaged(() =>
        readBytes(Uint8Array.from([0xe7, 0x82, 1]), {
          id: 0xe7,
          start: 0,
          data: 2,
          end: 4,
          sized: true,
        }),
      )
    })
  })
})

describe('the value of an element of unknown size (§10.4)', () => {
  /**
   * An element of unknown size that holds `data`, read up to the end of the bytes.
   * Its end is that limit and no more, so what is in front of it would be read as
   * a value if a reader took it for one: only a Segment or a Cluster may be of
   * unknown size, and neither has a value.
   */
  function unknown(data: number[]): { bytes: Uint8Array; el: Element } {
    const bytes = elementSized(ID.Timestamp, unknownSize(1), data)
    const el = header(bytes)
    expect(el.sized).toBe(false)
    expect(el.end).toBe(bytes.length)
    return { bytes, el }
  }

  it('is refused by readUint', () => {
    const { bytes, el } = unknown([5])
    damaged(() => readUint(bytes, el))
  })

  it('is refused by readInt', () => {
    const { bytes, el } = unknown([0xff])
    damaged(() => readInt(bytes, el))
  })

  it('is refused by readFloat', () => {
    // 4 bytes that are 1.0, which would be read as a number.
    const { bytes, el } = unknown([0x3f, 0x80, 0x00, 0x00])
    damaged(() => readFloat(bytes, el))
  })

  it('is refused by readString', () => {
    const { bytes, el } = unknown([0x77, 0x65, 0x62, 0x6d])
    damaged(() => readString(bytes, el))
  })

  it('is refused by readBytes', () => {
    const { bytes, el } = unknown([1, 2, 3])
    damaged(() => readBytes(bytes, el))
  })

  it('is refused even when it has no bytes, which a sized element would read as empty', () => {
    const { bytes, el } = unknown([])
    for (const read of [readUint, readInt, readFloat, readString, readBytes]) {
      damaged(() => read(bytes, el))
    }
  })
})

describe('the IDs (§10.4)', () => {
  it('are RFC 8794 and RFC 9559 IDs that no two elements share', () => {
    const values = Object.values(ID)
    expect(new Set(values).size).toBe(values.length)
    for (const value of values) {
      // An ID's first byte says how wide it is, and 4 bytes is the most (the first byte 0x10 or more).
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThanOrEqual(0x1fffffff)
      const bytes = element(value)
      expect(header(bytes).id).toBe(value)
    }
  })

  it('have the values that the standard gives', () => {
    expect(ID.EBML).toBe(0x1a45dfa3)
    expect(ID.Segment).toBe(0x18538067)
    expect(ID.Cluster).toBe(0x1f43b675)
    expect(ID.Tracks).toBe(0x1654ae6b)
    expect(ID.TrackEntry).toBe(0xae)
    expect(ID.CodecPrivate).toBe(0x63a2)
    expect(ID.SimpleBlock).toBe(0xa3)
    expect(ID.CRC32).toBe(0xbf)
    expect(ID.Void).toBe(0xec)
    expect(ID.TimestampScale).toBe(0x2ad7b1)
  })

  it('name the children of a Segment as the top level', () => {
    expect([...TOP_LEVEL].sort((a, b) => a - b)).toEqual(
      [
        ID.SeekHead,
        ID.Info,
        ID.Tracks,
        ID.Cluster,
        ID.Cues,
        ID.Tags,
        ID.Chapters,
        ID.Attachments,
      ].sort((a, b) => a - b),
    )
  })
})
