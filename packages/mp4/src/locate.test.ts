import { describe, expect, it } from 'vitest'
import { Mp4Error } from './errors.ts'
import type { Mp4Refusal } from './errors.ts'
import { MAX_MOOV_BYTES, locateMoov, moovIn } from './locate.ts'
import { readMovie } from './movie.ts'
import { openSource } from './source.ts'
import { box, concat, fourcc, movie, u32, u64 } from './testing/build.ts'

/** What `run` throws, which must be an `Mp4Error` of this reason. */
function refusal(reason: Mp4Refusal, run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe(reason)
    expect((error as Mp4Error).message).not.toBe('')
    return error as Mp4Error
  }
  throw new Error(`expected an Mp4Error (${reason})`)
}

/** A box of this type and `body` zero bytes after its 8-byte header. */
function plain(type: string, body: number): Uint8Array {
  return box(type, new Uint8Array(body))
}

/** The header of a box that claims `size` bytes in all, with only `body` bytes of it present: a box that the end of the head cuts off. */
function open(type: string, size: number, body = 0): Uint8Array {
  return concat(u32(size), fourcc(type), new Uint8Array(body))
}

/** The same with a 64-bit size: a size of 1, the type, then the size in 8 bytes. */
function wide(type: string, size: number | bigint, body = 0): Uint8Array {
  return concat(u32(1), fourcc(type), u64(size), new Uint8Array(body))
}

/** A header whose size field is 0: the box runs to the end of the file. */
function toTheEnd(type: string, body = 0): Uint8Array {
  return concat(u32(0), fourcc(type), new Uint8Array(body))
}

const FTYP = plain('ftyp', 24) // 32 bytes

describe('where the index is (§10.4)', () => {
  it('finds the moov in the head or after the mdat, and refuses a top-level moof', () => {
    // An index first (faststart): the moov is in the head, whole.
    const faststart = concat(FTYP, plain('moov', 100), open('mdat', 5000, 40))
    expect(locateMoov(faststart, 32 + 108 + 5000)).toEqual({ start: 32, end: 140 })

    // An index last: the head ends inside the mdat, and the moov is right after it, to the end of the file.
    const last = concat(FTYP, open('mdat', 1_000_000, 100))
    expect(locateMoov(last, 1_000_032 + 70_000)).toEqual({ start: 1_000_032, end: 1_070_032 })

    // A file in fragments has a moof at its top level, which is no file to split.
    const fragmented = concat(FTYP, plain('moov', 100), plain('moof', 50), open('mdat', 5000, 40))
    expect(refusal('fragmented', () => locateMoov(fragmented, 6000)).message).toContain('moof')
  })

  it('finds a moov that begins in the head and runs past it, from its header alone', () => {
    const head = concat(FTYP, open('moov', 100_000, 100))
    expect(locateMoov(head, 500_000)).toEqual({ start: 32, end: 100_032 })
  })

  it('finds a moov that has a 64-bit size', () => {
    const head = concat(FTYP, wide('moov', 20_000, 100))
    expect(locateMoov(head, 500_000)).toEqual({ start: 32, end: 20_032 })
  })

  it('finds a moov after small boxes, and after an mdat that is wholly in the head', () => {
    const head = concat(FTYP, plain('free', 12), plain('mdat', 200), plain('moov', 60))
    expect(locateMoov(head, head.length)).toEqual({ start: 32 + 20 + 208, end: head.length })
  })

  it('takes a moov with no size to run to the end of the file', () => {
    expect(locateMoov(concat(FTYP, toTheEnd('moov', 12)), 1000)).toEqual({ start: 32, end: 1000 })
  })

  it('finds a moov after an mdat that has a 64-bit size', () => {
    // The mdat is 5 GiB: a size that 32-bit arithmetic would take for 1 GiB.
    const size = 5 * 2 ** 30
    const head = concat(FTYP, wide('mdat', size, 100))
    expect(locateMoov(head, 32 + size + 70_000)).toEqual({
      start: 32 + size,
      end: 32 + size + 70_000,
    })
  })

  it('finds a moov after the wide, free and mdat that QuickTime writes', () => {
    // A head of 64 KiB that ends inside the mdat, as a recording from a phone does.
    const size = 899_776_512 - 56 // the mdat starts at 56, after the ftyp, the wide and the free
    const header = concat(FTYP, plain('wide', 0), plain('free', 8), wide('mdat', size))
    const head = new Uint8Array(65_536)
    head.set(header)
    expect(locateMoov(head, 899_853_995)).toEqual({ start: 899_776_512, end: 899_853_995 })
    // The skip box is another that is put there.
    const skipped = concat(FTYP, plain('skip', 4), open('mdat', 10_000, 20))
    expect(locateMoov(skipped, 20_000)).toEqual({ start: 32 + 12 + 10_000, end: 20_000 })
  })

  it('reads a head that is a view onto the middle of other bytes', () => {
    const head = concat(FTYP, open('mdat', 4096, 100))
    const padded = concat([9, 9, 9, 9, 9], head, [7, 7, 7])
    expect(locateMoov(padded.subarray(5, 5 + head.length), 5000)).toEqual({
      start: 32 + 4096,
      end: 5000,
    })
  })

  it('has no moov after an mdat with no size, which runs to the end of the file', () => {
    expect(locateMoov(concat(FTYP, toTheEnd('mdat', 12)), 1000)).toBeNull()
  })

  it('has no moov after an mdat that ends at or past the end of the file', () => {
    const head = concat(FTYP, open('mdat', 1000, 40))
    // It ends at the file's end (1032): nothing follows it.
    expect(locateMoov(head, 1032)).toBeNull()
    // It claims more than the file has: nothing can follow it either.
    expect(locateMoov(head, 900)).toBeNull()
  })

  it('has no moov in a file with neither a moov nor an mdat', () => {
    expect(locateMoov(FTYP, 32)).toBeNull()
    expect(locateMoov(concat(FTYP, plain('free', 100)), 140)).toBeNull()
  })

  it('has no moov after a box that is not an mdat', () => {
    // The head ends in a free box, not an mdat: what follows it is not known to be the index.
    expect(locateMoov(concat(FTYP, open('free', 1_000_000, 100)), 2_000_000)).toBeNull()
    // And the last box of the head is whole, and not an mdat.
    expect(locateMoov(concat(FTYP, plain('mdat', 100), plain('free', 100)), 5000)).toBeNull()
  })

  it('has no moov in a head that is shorter than one box header', () => {
    expect(locateMoov(new Uint8Array(0), 1000)).toBeNull()
    expect(locateMoov(new Uint8Array(7), 1000)).toBeNull()
    expect(locateMoov(FTYP.subarray(0, 4), 1000)).toBeNull()
    // A header with a 64-bit size that is cut short is not read.
    expect(locateMoov(wide('mdat', 2000).subarray(0, 12), 5000)).toBeNull()
    // A header that is just whole is listed, and its body runs on past the head.
    expect(locateMoov(open('mdat', 2000), 5000)).toEqual({ start: 2000, end: 5000 })
  })

  it('stops at a header that is damaged, and finds nothing after it', () => {
    // A box smaller than its own header.
    const small = u32(4)
    expect(locateMoov(concat(FTYP, small, fourcc('free'), plain('moov', 100)), 5000)).toBeNull()
    // A 64-bit size smaller than the header, and one that no file has.
    expect(locateMoov(concat(FTYP, wide('free', 12), plain('moov', 100)), 5000)).toBeNull()
    expect(locateMoov(concat(FTYP, wide('mdat', 2n ** 60n, 100)), 5000)).toBeNull()
    // The boxes before the damage are still listed: a moov ahead of it is found.
    expect(locateMoov(concat(FTYP, plain('moov', 100), small, fourcc('free')), 5000)).toEqual({
      start: 32,
      end: 140,
    })
  })

  it('refuses a moov that claims more than the file holds as damaged', () => {
    const head = concat(FTYP, open('moov', 100_000, 100))
    expect(refusal('damaged', () => locateMoov(head, 50_000)).message).toContain('moov')
    // By one byte.
    refusal('damaged', () => locateMoov(head, 100_031))
    expect(locateMoov(head, 100_032)).toEqual({ start: 32, end: 100_032 })
  })

  it('refuses a moof wherever it is among the boxes that are listed, even after the moov', () => {
    refusal('fragmented', () => locateMoov(concat(FTYP, plain('moof', 100)), 5000))
    refusal('fragmented', () =>
      locateMoov(concat(FTYP, plain('moov', 100), plain('moof', 100)), 5000),
    )
    refusal('fragmented', () =>
      locateMoov(concat(FTYP, plain('styp', 8), plain('sidx', 20), open('moof', 9000, 10)), 20_000),
    )
    // A moof with a 64-bit size, or one that has none.
    refusal('fragmented', () => locateMoov(concat(FTYP, wide('moof', 500, 40)), 5000))
    refusal('fragmented', () => locateMoov(concat(FTYP, toTheEnd('moof', 40)), 5000))
  })

  it('does not take a moof past a damaged header for one', () => {
    expect(locateMoov(concat(FTYP, u32(2), fourcc('free'), plain('moof', 100)), 5000)).toBeNull()
  })

  it('refuses a size of the file that is no count of bytes, which only a caller that miscounted gives', () => {
    for (const size of [-1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => locateMoov(FTYP, size)).toThrow(RangeError)
    }
    expect(locateMoov(FTYP, 0)).toBeNull()
  })
})

describe('where the index is when the head ends close to the end of the mdat (§10.4)', () => {
  it('finds the moov after an mdat that ends exactly at the end of the head', () => {
    const head = concat(FTYP, plain('mdat', 100))
    expect(head.length).toBe(140)
    expect(locateMoov(head, 5000)).toEqual({ start: 140, end: 5000 })
  })

  it("finds the moov after an mdat that ends within 8 bytes of the head's end, where the next header isn't whole", () => {
    for (const cut of [1, 3, 4, 7]) {
      const head = concat(FTYP, plain('mdat', 100), new Uint8Array(cut))
      expect(locateMoov(head, 5000), `${cut} bytes`).toEqual({ start: 140, end: 5000 })
    }
    // A 64-bit header is not whole until 16 bytes of it are there.
    const wideCut = concat(FTYP, plain('mdat', 100), u32(1), fourcc('moov'), [0, 0, 0, 0])
    expect(locateMoov(wideCut, 5000)).toEqual({ start: 140, end: 5000 })
  })

  it('does not take a damaged header after an mdat for the start of the moov', () => {
    // The head goes on after the mdat, but with a box that is smaller than its own header: no moov begins there.
    const head = concat(FTYP, plain('mdat', 100), u32(4), fourcc('free'), new Uint8Array(40))
    expect(locateMoov(head, 5000)).toBeNull()
    const huge = concat(FTYP, plain('mdat', 100), wide('moov', 2n ** 60n, 20))
    expect(locateMoov(huge, 5000)).toBeNull()
  })

  it('finds the moov after an mdat that ends at the head and is the last box, though a free or skip comes before it', () => {
    const head = concat(FTYP, plain('free', 12), plain('skip', 4), plain('mdat', 100))
    expect(locateMoov(head, 5000)).toEqual({ start: head.length, end: 5000 })
  })

  it('has no moov after an mdat that is the whole of the file, or that leaves less than a header', () => {
    const head = concat(FTYP, plain('mdat', 100))
    expect(locateMoov(head, head.length)).toBeNull()
    // A tail of 3 bytes holds no header, and neither do 7; 8 are a header.
    expect(locateMoov(head, head.length + 3)).toBeNull()
    expect(locateMoov(head, head.length + 7)).toBeNull()
    expect(locateMoov(head, head.length + 8)).toEqual({ start: 140, end: 148 })
    // The same for an mdat that runs past the head.
    const past = concat(FTYP, open('mdat', 1000, 40))
    expect(locateMoov(past, 1032 + 7)).toBeNull()
    expect(locateMoov(past, 1032 + 8)).toEqual({ start: 1032, end: 1040 })
  })

  it('reads only as much of a head as the file has', () => {
    // The head is longer than the file, which is only its first 36 bytes: the moov header at 32 is not whole in them.
    const head = concat(FTYP, toTheEnd('moov', 4))
    expect(head.length).toBe(44)
    expect(locateMoov(head, 36)).toBeNull()
    // With 8 bytes it is whole, and the moov is those 8 bytes; no more than that.
    expect(locateMoov(head, 40)).toEqual({ start: 32, end: 40 })
    // A moov that the file cuts short is damaged, not found with an end past the file.
    refusal('damaged', () => locateMoov(concat(FTYP, plain('moov', 100)), 100))
    // A moof that the file cuts off is not listed either.
    expect(locateMoov(concat(FTYP, plain('moof', 100)), 36)).toBeNull()
    // And an mdat that the file cuts short has no moov after it.
    expect(locateMoov(concat(FTYP, open('mdat', 1000, 100)), 100)).toBeNull()
  })

  it("has no moov in a range of the file that is shorter than a box's header", () => {
    expect(locateMoov(concat(FTYP, toTheEnd('moov')), 40)).toEqual({ start: 32, end: 40 })
    expect(locateMoov(concat(FTYP, toTheEnd('moov')), 39)).toBeNull()
  })
})

describe('the moov in the range that was read (§10.4)', () => {
  const index = movie({ tracks: [{ handler: 'vide' }, { handler: 'soun' }] })

  it('is the first box when the range starts with the moov', () => {
    expect(moovIn(index)).toEqual(index)
    // And what follows the moov, such as the trailer a writer leaves, is not part of it.
    expect(moovIn(concat(index, plain('free', 30)))).toEqual(index)
  })

  it('walks past the free, skip, wide and udta boxes before it, and any others', () => {
    for (const before of [
      [plain('free', 12)],
      [plain('wide', 0), plain('skip', 3), plain('udta', 40), plain('free', 0)],
      [plain('mdat', 100)],
      [wide('free', 20, 4)],
    ]) {
      const range = concat(...before, index)
      const found = moovIn(range)
      expect(found, String(before.length)).toEqual(index)
      // A view onto the range that was read, not a copy.
      expect(found.buffer).toBe(range.buffer)
      expect(readMovie(found).tracks).toHaveLength(2)
    }
  })

  it('takes a moov with no size to run to the end of the range', () => {
    const toTheRangeEnd = toTheEnd('moov', 100)
    expect(moovIn(concat(plain('free', 8), toTheRangeEnd))).toEqual(toTheRangeEnd)
  })

  it('is damaged when the range holds no moov, is empty, or is damaged before the moov', () => {
    refusal('damaged', () => moovIn(new Uint8Array(0)))
    refusal('damaged', () => moovIn(concat(plain('free', 100), plain('mdat', 20))))
    expect(refusal('damaged', () => moovIn(plain('free', 100))).message).toContain('moov')
    // A box that claims more than the range holds, and one smaller than its header, before the moov.
    refusal('damaged', () => moovIn(concat(open('free', 1000, 8), index)))
    refusal('damaged', () => moovIn(concat(u32(4), fourcc('free'), index)))
    // Bytes that are cut off in the middle of a header.
    refusal('damaged', () => moovIn(index.subarray(0, 5)))
  })

  it('is found, whatever comes after it', () => {
    // A damaged box after the moov is not looked at: the moov is what was asked for.
    expect(moovIn(concat(index, u32(3), fourcc('free')))).toEqual(index)
  })
})

describe('the most a moov may hold (§10.4)', () => {
  const MIB = 1024 * 1024

  it('is 256 MiB', () => {
    expect(MAX_MOOV_BYTES).toBe(256 * MIB)
  })

  it('takes a moov of the bound and refuses one byte more as damaged, with the size and the bound in the sentence', () => {
    const fileSize = 2 * 1024 * MIB
    expect(locateMoov(concat(FTYP, open('moov', MAX_MOOV_BYTES)), fileSize)).toEqual({
      start: 32,
      end: 32 + MAX_MOOV_BYTES,
    })
    const error = refusal('damaged', () =>
      locateMoov(concat(FTYP, open('moov', MAX_MOOV_BYTES + 1)), fileSize),
    )
    expect(error.message).toContain(String(MAX_MOOV_BYTES + 1))
    expect(error.message).toContain(String(MAX_MOOV_BYTES))
  })

  it('refuses a moov of 257 MiB at the end of the file, and one that opening the file meets', () => {
    const size = 257 * MIB
    const head = concat(FTYP, open('mdat', 1000))
    const fileSize = 32 + 1000 + size
    // The moov follows the mdat, to the end of the file.
    refusal('damaged', () => locateMoov(head, fileSize))
    const error = refusal('damaged', () =>
      openSource([{ start: 0, bytes: concat(FTYP, open('moov', size)) }], 32 + size),
    )
    expect(error.message).toContain(String(size))
    expect(error.message).toContain(String(MAX_MOOV_BYTES))
  })
})
