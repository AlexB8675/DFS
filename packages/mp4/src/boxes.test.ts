import { describe, expect, it } from 'vitest'
import { child, childBoxes, Reader } from './boxes.ts'
import { Mp4Error } from './errors.ts'
import { box, concat, fourcc, fullBox, i16, i32, i64, u16, u32, u64 } from './testing/build.ts'

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

describe('the boxes in a range (§10.4)', () => {
  it('walks the boxes in a range, with 64-bit and to-the-end sizes', () => {
    // A few bytes before the first box, so no offset is 0 by luck.
    const prefix = [9, 9, 9]
    const ftyp = box('ftyp', fourcc('isom'), u32(0))
    // `size 1`: the size is a u64 after the type, and counts the 16-byte header.
    const free = concat(u32(1), fourcc('free'), u64(16 + 5), [1, 2, 3, 4, 5])
    const moov = box('moov', box('trak'))
    // `size 0`: the box runs to the end of the range.
    const mdat = concat(u32(0), fourcc('mdat'), [7, 7, 7, 7])
    const bytes = concat(prefix, ftyp, free, moov, mdat)

    const ftypAt = 3
    const freeAt = ftypAt + ftyp.length
    const moovAt = freeAt + free.length
    const mdatAt = moovAt + moov.length
    expect(childBoxes(bytes, 3, bytes.length)).toEqual([
      { type: 'ftyp', start: ftypAt, body: ftypAt + 8, end: freeAt },
      { type: 'free', start: freeAt, body: freeAt + 16, end: moovAt },
      { type: 'moov', start: moovAt, body: moovAt + 8, end: mdatAt },
      { type: 'mdat', start: mdatAt, body: mdatAt + 8, end: bytes.length },
    ])
  })

  it('stops a to-the-end box at the end of the range, not of the bytes', () => {
    const bytes = concat(u32(0), fourcc('mdat'), [1, 2, 3, 4], [0xff, 0xff])
    expect(childBoxes(bytes, 0, 12)).toEqual([{ type: 'mdat', start: 0, body: 8, end: 12 }])
  })

  it('lists nothing in an empty range', () => {
    expect(childBoxes(box('free'), 8, 8)).toEqual([])
  })

  it('walks the boxes inside a box, and finds the first child of a type, or null', () => {
    const bytes = concat(
      [0],
      box('moov', fullBox('mvhd', 0, 0, u32(1)), box('trak', [1]), box('trak', [2]), box('udta')),
    )
    const [moov] = childBoxes(bytes, 1, bytes.length)
    expect(moov?.type).toBe('moov')
    if (!moov) return
    expect(childBoxes(bytes, moov.body, moov.end).map((entry) => entry.type)).toEqual([
      'mvhd',
      'trak',
      'trak',
      'udta',
    ])
    // The moov starts at 1, its header takes 8, and the mvhd is 8 + 4 + 4 bytes.
    const trakAt = 1 + 8 + 16
    expect(child(bytes, moov, 'trak')).toEqual({
      type: 'trak',
      start: trakAt,
      body: trakAt + 8,
      end: trakAt + 9,
    })
    expect(child(bytes, moov, 'mdia')).toBeNull()
    expect(child(bytes, moov, 'udta')?.end).toBe(moov.end)
  })

  it('reads the bytes of a view onto a larger buffer where they really are', () => {
    const inside = box('moov', box('trak'))
    const wide = concat([1, 2, 3, 4, 5], inside, [6, 6])
    const view = wide.subarray(5, 5 + inside.length)
    expect(view.byteOffset).toBe(5)
    expect(childBoxes(view, 0, view.length)).toEqual([
      { type: 'moov', start: 0, body: 8, end: inside.length },
    ])
    expect(new Reader(view, 0, 8).u32()).toBe(inside.length)
  })

  it('refuses a box that claims more than the range holds, or a header cut short', () => {
    // A box that claims 100 bytes where 20 are left.
    const long = concat(u32(100), fourcc('moov'), new Array<number>(12).fill(0))
    const claimed = damaged(() => childBoxes(long, 0, long.length))
    expect(claimed.message).toContain("'moov'")
    expect(claimed.message).toContain('offset 0')

    // The same, in a 64-bit size, after a box that is fine.
    const first = box('ftyp')
    const wide = concat(first, u32(1), fourcc('mdat'), u64(1000), [1, 2, 3])
    const wideError = damaged(() => childBoxes(wide, 0, wide.length))
    expect(wideError.message).toContain("'mdat'")
    expect(wideError.message).toContain(`offset ${first.length}`)

    // A box that is whole in the bytes but runs past the range it is read in.
    const inner = concat(box('free', [1, 2, 3, 4]), box('free', [1, 2, 3, 4]))
    damaged(() => childBoxes(inner, 0, inner.length - 1))

    // Headers cut short: no room for the 8 bytes, or for the 16 of a `size 1` box.
    damaged(() => childBoxes(concat(box('free'), [0, 0, 0, 8, 102]), 0, 13))
    damaged(() => childBoxes(concat(u32(1), fourcc('free'), [0, 0, 0, 0]), 0, 12))

    // A size smaller than its own header, in either form.
    const small = damaged(() => childBoxes(concat(u32(4), fourcc('free')), 0, 8))
    expect(small.message).toContain("'free'")
    damaged(() => childBoxes(concat(u32(1), fourcc('free'), u64(12)), 0, 16))

    // A 64-bit size that no number holds.
    damaged(() => childBoxes(concat(u32(1), fourcc('free'), u64(2n ** 63n)), 0, 16))
  })

  it('refuses a range that is not inside the bytes', () => {
    const bytes = box('free')
    damaged(() => childBoxes(bytes, 0, bytes.length + 1))
    damaged(() => childBoxes(bytes, 9, 8))
  })
})

describe('reading a box body (§10.4)', () => {
  it('reads big-endian integers and refuses a read past the end', () => {
    const body = concat(
      [0xff],
      u16(0x0102),
      [0x01, 0x02, 0x03],
      u32(0xfffffffe),
      i16(-2),
      i32(-3),
      u64(2 ** 40 + 5),
      i64(-(2n ** 40n) - 5n),
      fourcc('avc1'),
      [1, 2, 3, 4, 5],
    )
    // Inside a larger buffer, so the reader must honour the view's own offset.
    const wide = concat([0xaa, 0xbb, 0xcc], body, [0xdd])
    const bytes = wide.subarray(2)
    const reader = new Reader(bytes, 1, 1 + body.length)

    expect(reader.position).toBe(1)
    expect(reader.remaining).toBe(body.length)
    expect(reader.u8()).toBe(0xff)
    expect(reader.u16()).toBe(0x0102)
    expect(reader.u24()).toBe(0x010203)
    expect(reader.u32()).toBe(0xfffffffe)
    expect(reader.i16()).toBe(-2)
    expect(reader.i32()).toBe(-3)
    expect(reader.u64()).toBe(2 ** 40 + 5)
    expect(reader.i64()).toBe(-(2 ** 40) - 5)
    expect(reader.fourcc()).toBe('avc1')
    expect(reader.position).toBe(1 + body.length - 5)
    reader.skip(1)
    expect(reader.bytes(3)).toEqual(Uint8Array.of(2, 3, 4))
    expect(reader.remaining).toBe(1)

    // A read past the end is refused, and moves nothing.
    const at = reader.position
    damaged(() => reader.u16())
    damaged(() => reader.u32())
    damaged(() => reader.u64())
    damaged(() => reader.fourcc())
    damaged(() => reader.bytes(2))
    damaged(() => {
      reader.skip(2)
    })
    expect(reader.position).toBe(at)
    expect(reader.u8()).toBe(5)
    expect(reader.remaining).toBe(0)
    damaged(() => reader.u8())
  })

  it('refuses a count that is not a whole number of bytes to take', () => {
    const reader = new Reader(Uint8Array.of(1, 2, 3, 4), 0, 4)
    damaged(() => {
      reader.skip(-1)
    })
    damaged(() => reader.bytes(-1))
    damaged(() => reader.bytes(1.5))
    damaged(() => {
      reader.skip(Number.NaN)
    })
    expect(reader.position).toBe(0)
  })

  it('stops at the end of its range, not of the bytes', () => {
    const reader = new Reader(Uint8Array.of(1, 2, 3, 4, 5, 6), 1, 3)
    expect(reader.u16()).toBe(0x0203)
    damaged(() => reader.u8())
  })

  it('refuses a range that is not inside the bytes', () => {
    const bytes = Uint8Array.of(1, 2, 3, 4)
    damaged(() => new Reader(bytes, 0, 5))
    damaged(() => new Reader(bytes, 3, 2))
    damaged(() => new Reader(bytes, -1, 2))
  })

  it('refuses a 64-bit value above the largest safe integer', () => {
    const largest = BigInt(Number.MAX_SAFE_INTEGER)
    const readU64 = (bytes: number[]) => new Reader(Uint8Array.from(bytes), 0, 8).u64()
    const readI64 = (bytes: number[]) => new Reader(Uint8Array.from(bytes), 0, 8).i64()

    expect(readU64(u64(largest))).toBe(Number.MAX_SAFE_INTEGER)
    expect(readI64(i64(largest))).toBe(Number.MAX_SAFE_INTEGER)
    expect(readI64(i64(-largest))).toBe(-Number.MAX_SAFE_INTEGER)

    damaged(() => readU64(u64(largest + 1n)))
    damaged(() => readU64(u64(2n ** 64n - 1n)))
    damaged(() => readI64(i64(largest + 1n)))
    damaged(() => readI64(i64(-largest - 1n)))
    damaged(() => readI64(i64(-(2n ** 63n))))
    // All ones is a value of 64 bits for `u64`, and -1 for `i64`.
    expect(readI64(u64(2n ** 64n - 1n))).toBe(-1)
  })
})
