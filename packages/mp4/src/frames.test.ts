import { describe, expect, it } from 'vitest'
import { Mp4Error } from './errors.ts'
import { frameTable } from './frames.ts'
import { readMovie } from './movie.ts'
import type { TrackHeader } from './movie.ts'
import {
  co64,
  ctts,
  fullBox,
  movie,
  sampleEntry,
  stco,
  stsc,
  stss,
  stsz,
  stts,
  stz2,
  u32,
} from './testing/build.ts'

/** What `run` throws, which must be an `Mp4Error`. */
function refusal(run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error')
}

/**
 * The first track of a movie built with these tables, read back by `readMovie`:
 * each table is then a view onto the moov at an offset of its own, as it is
 * when the reader is used, which a `TrackHeader` written out by hand wouldn't be.
 */
function trackWith(tables: readonly Uint8Array[], timescale = 1000): TrackHeader {
  const track = readMovie(movie({ tracks: [{ timescale, tables }] })).tracks[0]
  if (!track) throw new Error('expected a track')
  expect(track.problem).toBeNull()
  return track
}

/** The tables of a track of 4 samples in 2 chunks, with `changes` in place of some of them, or with `null` to leave one out. */
function tablesOf(
  changes: Partial<Record<'stts' | 'ctts' | 'stss' | 'stsz' | 'stsc' | 'stco', Uint8Array | null>>,
): Uint8Array[] {
  const tables = {
    stts: stts([[4, 1000]]),
    stsz: stsz([10, 20, 30, 40]),
    stsc: stsc([[1, 2]]),
    stco: stco([100, 200]),
    ...changes,
  }
  return Object.values(tables).filter((table): table is Uint8Array => table !== null)
}

function ints(values: ArrayLike<number>): number[] {
  return Array.from(values)
}

describe("a track's frames (§10.4)", () => {
  it("expands stts, stsc with several entries, stsz and stco into each frame's offset, size and times", () => {
    // 8 samples in 4 chunks: the first chunk holds 3, the next two 2 each and the last 1.
    const track = trackWith(
      [
        stts([
          [5, 1001],
          [3, 2002],
        ]),
        stsz([100, 200, 300, 400, 500, 600, 700, 800]),
        stsc([
          [1, 3, 1],
          [2, 2, 1],
          [4, 1, 1],
        ]),
        stco([1000, 2000, 3000, 4000]),
      ],
      30000,
    )

    const frames = frameTable(track)

    expect(frames.count).toBe(8)
    expect(frames.timescale).toBe(30000)
    expect(frames.offsets).toBeInstanceOf(Float64Array)
    expect(frames.sizes).toBeInstanceOf(Uint32Array)
    expect(frames.dts).toBeInstanceOf(Float64Array)
    expect(frames.durations).toBeInstanceOf(Uint32Array)
    expect(frames.cts).toBeInstanceOf(Int32Array)
    expect(frames.sync).toBeInstanceOf(Uint8Array)
    expect(ints(frames.sizes)).toEqual([100, 200, 300, 400, 500, 600, 700, 800])
    // Chunk 1 (1000): 1000, 1100, 1300. Chunk 2 (2000): 2000, 2400. Chunk 3 (3000): 3000, 3600. Chunk 4: 4000.
    expect(ints(frames.offsets)).toEqual([1000, 1100, 1300, 2000, 2400, 3000, 3600, 4000])
    expect(ints(frames.durations)).toEqual([1001, 1001, 1001, 1001, 1001, 2002, 2002, 2002])
    expect(ints(frames.dts)).toEqual([0, 1001, 2002, 3003, 4004, 5005, 7007, 9009])
    expect(ints(frames.cts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(ints(frames.sync)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  })

  it('reads a constant sample size, and stz2 of 4, 8 and 16 bits', () => {
    const rest = [stts([[5, 1024]]), stsc([[1, 5]]), stco([1000])]

    const constant = frameTable(trackWith([stsz({ size: 512, count: 5 }), ...rest]))
    expect(constant.count).toBe(5)
    expect(ints(constant.sizes)).toEqual([512, 512, 512, 512, 512])
    expect(ints(constant.offsets)).toEqual([1000, 1512, 2024, 2536, 3048])

    // An odd number of 4-bit sizes leaves the last byte's low half unused.
    const cases = [
      { bits: 4, sizes: [1, 15, 7, 0, 9], offsets: [1000, 1001, 1016, 1023, 1023] },
      { bits: 8, sizes: [200, 0, 255, 3, 17], offsets: [1000, 1200, 1200, 1455, 1458] },
      { bits: 16, sizes: [65535, 256, 0, 1000, 12], offsets: [1000, 66535, 66791, 66791, 67791] },
    ] as const
    for (const { bits, sizes, offsets } of cases) {
      const frames = frameTable(trackWith([stz2(bits, sizes), ...rest]))
      expect(frames.count, `${bits} bits`).toBe(5)
      expect(ints(frames.sizes), `${bits} bits`).toEqual(sizes)
      expect(ints(frames.offsets), `${bits} bits`).toEqual(offsets)
    }
  })

  it('reads ctts v0 and v1, negative offsets included', () => {
    const rest = [stts([[5, 1000]]), stsz([1, 1, 1, 1, 1]), stsc([[1, 5]]), stco([0])]

    const version0 = frameTable(
      trackWith([
        ctts(0, [
          [2, 2002],
          [3, 0],
        ]),
        ...rest,
      ]),
    )
    expect(ints(version0.cts)).toEqual([2002, 2002, 0, 0, 0])

    const signed = frameTable(
      trackWith([
        ctts(1, [
          [1, -2002],
          [2, 4004],
          [1, -1001],
          [1, 0],
        ]),
        ...rest,
      ]),
    )
    expect(signed.cts).toBeInstanceOf(Int32Array)
    expect(ints(signed.cts)).toEqual([-2002, 4004, 4004, -1001, 0])

    // The ends of what 32 bits hold as a signed number: the largest of version 0 and both of version 1.
    const high = frameTable(trackWith([ctts(0, [[5, 2 ** 31 - 1]]), ...rest]))
    expect(ints(high.cts)).toEqual(new Array<number>(5).fill(2 ** 31 - 1))
    const ends = frameTable(
      trackWith([
        ctts(1, [
          [2, -(2 ** 31)],
          [3, 2 ** 31 - 1],
        ]),
        ...rest,
      ]),
    )
    expect(ints(ends.cts)).toEqual([-(2 ** 31), -(2 ** 31), 2 ** 31 - 1, 2 ** 31 - 1, 2 ** 31 - 1])
  })

  it("reads a version 0 ctts's offsets as signed, as FFmpeg does", () => {
    const rest = [stts([[5, 1000]]), stsz([1, 1, 1, 1, 1]), stsc([[1, 5]]), stco([0])]
    // QuickTime-style files carry a negative offset in version 0 as 32 bits two's complement:
    // 0xFFFFFC00 is -1024, and 0x80000000 is the most negative, which is not a large positive.
    const frames = frameTable(
      trackWith([
        ctts(0, [
          [1, 0xfffffc00],
          [2, 2002],
          [1, 0x80000000],
          [1, 0xffffffff],
        ]),
        ...rest,
      ]),
    )
    expect(frames.cts).toBeInstanceOf(Int32Array)
    expect(ints(frames.cts)).toEqual([-1024, 2002, 2002, -(2 ** 31), -1])
  })

  it('treats every frame as a keyframe without stss', () => {
    const frames = frameTable(trackWith(tablesOf({})))
    expect(ints(frames.sync)).toEqual([1, 1, 1, 1])
  })

  it('marks the frames that stss numbers, counting from 1, and no others', () => {
    const frames = frameTable(trackWith(tablesOf({ stss: stss([1, 3]) })))
    expect(ints(frames.sync)).toEqual([1, 0, 1, 0])

    // The last frame, in the order of the list as written: not necessarily ascending.
    expect(ints(frameTable(trackWith(tablesOf({ stss: stss([4, 2]) }))).sync)).toEqual([0, 1, 0, 1])

    // A list with nothing in it is not the same as no list: no frame is a keyframe.
    expect(ints(frameTable(trackWith(tablesOf({ stss: stss([]) }))).sync)).toEqual([0, 0, 0, 0])
  })

  it('reads co64 offsets past 4 GiB exactly', () => {
    const frames = frameTable(
      trackWith([
        stts([[4, 1000]]),
        stsz([100, 200, 300, 400]),
        stsc([[1, 2]]),
        co64([2n ** 32n + 12345n, 7_140_713_588n - 1000n]),
      ]),
    )
    // Two samples in each chunk: the second one is its chunk's offset plus the first one's size.
    expect(frames.offsets[0]).toBe(2 ** 32 + 12345)
    expect(frames.offsets[1]).toBe(2 ** 32 + 12345 + 100)
    expect(frames.offsets[2]).toBe(7_140_713_588 - 1000)
    expect(frames.offsets[3]).toBe(7_140_713_588 - 1000 + 300)
    expect(ints(frames.offsets)).toEqual([
      4_294_979_641, 4_294_979_741, 7_140_712_588, 7_140_712_888,
    ])

    // The last offset a number holds exactly, from a chunk's offset and the sizes before it.
    const edge = frameTable(
      trackWith([
        stts([[3, 1000]]),
        stsz([100, 200, 300]),
        stsc([
          [1, 2],
          [2, 1],
        ]),
        co64([
          BigInt(Number.MAX_SAFE_INTEGER) - 300n - 300n,
          BigInt(Number.MAX_SAFE_INTEGER) - 300n,
        ]),
      ]),
    )
    expect(edge.offsets[1]).toBe(Number.MAX_SAFE_INTEGER - 300 - 300 + 100)
    expect(edge.offsets[2]).toBe(Number.MAX_SAFE_INTEGER - 300)

    // A chunk of 32-bit offsets that reaches past 4 GiB inside the chunk doesn't wrap.
    const crossing = frameTable(
      trackWith([stts([[3, 1]]), stsz([100, 200, 300]), stsc([[1, 3]]), stco([4_294_967_000])]),
    )
    expect(ints(crossing.offsets)).toEqual([4_294_967_000, 4_294_967_100, 4_294_967_300])
  })

  it('prefers co64 to an stco beside it, which a file past 4 GiB may hold as a dummy', () => {
    // 4 samples of 10, 20, 30 and 40 bytes in 2 chunks; the stco says other places, and fewer than 2^32.
    const frames = frameTable(
      trackWith([...tablesOf({ stco: stco([100, 200]) }), co64([2n ** 32n + 5n, 2n ** 33n])]),
    )
    expect(ints(frames.offsets)).toEqual([2 ** 32 + 5, 2 ** 32 + 15, 2 ** 33, 2 ** 33 + 30])

    // Whatever the stco says is not read: it can be one chunk, none, or not a table at all.
    const bare = frameTable(trackWith([...tablesOf({ stco: stco([]) }), co64([7n, 9n])]))
    expect(ints(bare.offsets)).toEqual([7, 17, 9, 39])
  })

  it("takes each chunk's sample description as one of the stsd's, counting from 1", () => {
    // Two descriptions, so 2 is one the track has: the chunks may use either.
    const entries = [sampleEntry('avc1'), sampleEntry('avc3')]
    const tables = tablesOf({
      stsc: stsc([
        [1, 1, 1],
        [2, 1, 2],
      ]),
      stco: stco([100, 200]),
      stsz: stsz([10, 20]),
      stts: stts([[2, 1000]]),
    })
    const track = readMovie(movie({ tracks: [{ entries, tables }] })).tracks[0]
    if (!track) throw new Error('expected a track')
    expect(ints(frameTable(track).offsets)).toEqual([100, 200])
  })

  it('reads the tables of a track with no samples as no frames', () => {
    const frames = frameTable(trackWith([stts([]), stsz([]), stsc([]), stco([])]))
    expect(frames.count).toBe(0)
    expect([
      frames.offsets.length,
      frames.sizes.length,
      frames.dts.length,
      frames.sync.length,
    ]).toEqual([0, 0, 0, 0])
  })

  it('keeps the track timescale, 0 included, without dividing by it', () => {
    // `readMovie` gives a track that counts in ticks of 0 a problem, so the 0 is put in by hand.
    const track = { ...trackWith(tablesOf({})), timescale: 0 }
    expect(frameTable(track).timescale).toBe(0)
  })

  describe('refuses tables whose counts disagree', () => {
    const cases: [string, Parameters<typeof tablesOf>[0], RegExp][] = [
      [
        'an stts that counts more samples than stsz',
        { stts: stts([[5, 1000]]) },
        /'stts'.*5.*'stsz'.*4/,
      ],
      ['an stts that counts fewer', { stts: stts([[3, 1000]]) }, /'stts'.*3.*'stsz'.*4/],
      [
        'an stts whose runs add up to more',
        {
          stts: stts([
            [2, 1000],
            [9, 1000],
          ]),
        },
        /'stts'.*11.*'stsz'.*4/,
      ],
      [
        'a ctts that counts more samples than stsz',
        { ctts: ctts(1, [[5, 0]]) },
        /'ctts'.*5.*'stsz'.*4/,
      ],
      ['a ctts that counts fewer', { ctts: ctts(0, [[3, 0]]) }, /'ctts'.*3.*'stsz'.*4/],
      [
        'chunks that hold fewer samples than stsz counts',
        { stco: stco([100]) },
        /'stsc'.*'stco'.*2.*'stsz'.*4/,
      ],
      ['a chunk past the samples', { stco: stco([100, 200, 300]) }, /'stsc'.*'stco'.*6.*'stsz'.*4/],
      [
        'a chunk that holds more than the samples there are',
        { stsc: stsc([[1, 5]]) },
        /'stsc'.*'stco'.*10.*'stsz'.*4/,
      ],
      [
        'an stsc whose runs place more',
        {
          stsc: stsc([
            [1, 2],
            [2, 3],
          ]),
        },
        /'stsc'.*'stco'.*5.*'stsz'.*4/,
      ],
      ['an stss that numbers a sample past the last', { stss: stss([1, 5]) }, /'stss'.*5.*4/],
      ['an stss that numbers sample 0, which counts from 1', { stss: stss([0, 1]) }, /'stss'.*0/],
      [
        'an stss that lists more samples than the track has, though each is one it has',
        { stss: stss([1, 2, 3, 4, 1]) },
        /'stss'.*5.*4/,
      ],
      ['no stsz or stz2', { stsz: null }, /'stsz'/],
      ['no stts', { stts: null }, /'stts'/],
      ['no stsc', { stsc: null }, /'stsc'/],
      ['no stco or co64', { stco: null }, /'stco'/],
      ['an stsc that starts at chunk 0', { stsc: stsc([[0, 2]]) }, /'stsc'.*chunk 0/],
      ['an stsc that does not start at chunk 1', { stsc: stsc([[2, 2]]) }, /'stsc'.*chunk 2/],
      [
        'an stsc that goes back',
        {
          stsc: stsc([
            [1, 2],
            [2, 1],
            [1, 1],
          ]),
        },
        /'stsc'.*ascend/,
      ],
      [
        'an stsc that repeats a chunk',
        {
          stsc: stsc([
            [1, 1],
            [1, 3],
          ]),
        },
        /'stsc'.*ascend/,
      ],
      ['an stsc of no samples in a chunk', { stsc: stsc([[1, 0]]) }, /'stsc'.*0 samples/],
      [
        'an stsc that uses sample description 0, which counts from 1',
        { stsc: stsc([[1, 2, 0]]) },
        /'stsc'.*description 0/,
      ],
      [
        'an stsc that uses a sample description past the stsd entries',
        { stsc: stsc([[1, 2, 2]]) },
        /'stsc'.*description 2.*1/,
      ],
      [
        'an stsc whose later entry uses a description the track does not have',
        {
          stsc: stsc([
            [1, 1, 1],
            [2, 1, 7],
          ]),
        },
        /'stsc'.*chunk 2.*description 7/,
      ],
      [
        'an stsc entry for a chunk that stco does not have',
        {
          stsc: stsc([
            [1, 2],
            [3, 2],
          ]),
        },
        /'stsc'.*chunk 3.*'stco'.*2/,
      ],
      ['an stsc that says nothing of the chunks there are', { stsc: stsc([]) }, /'stsc'.*no entry/],
      [
        'an stts that claims more entries than it holds',
        { stts: stts([[4, 1000]], 99_999) },
        /'stts'.*99999/,
      ],
      [
        'a ctts that claims more entries than it holds',
        { ctts: ctts(1, [[4, 0]], 7) },
        /'ctts'.*7/,
      ],
      ['an stss that claims more entries than it holds', { stss: stss([1], 5) }, /'stss'.*5/],
      [
        'an stsz that claims more samples than it holds',
        { stsz: stsz([10, 20, 30, 40], 99) },
        /'stsz'.*99/,
      ],
      ['an stsc that claims more entries than it holds', { stsc: stsc([[1, 2]], 3) }, /'stsc'.*3/],
      ['an stco that claims more chunks than it holds', { stco: stco([100, 200], 3) }, /'stco'.*3/],
      [
        'an stts of a version this reader does not know',
        { stts: fullBox('stts', 1, 0, u32(0)) },
        /'stts'.*version 1/,
      ],
      [
        'an stco of a version this reader does not know',
        { stco: fullBox('stco', 2, 0, u32(0)) },
        /'stco'.*version 2/,
      ],
      [
        'a ctts of a version this reader does not know',
        { ctts: fullBox('ctts', 2, 0, u32(0)) },
        /'ctts'.*version 2/,
      ],
    ]
    it.each(cases)('%s', (_name, changes, message) => {
      const error = refusal(() => frameTable(trackWith(tablesOf(changes))))
      expect(error.reason).toBe('damaged')
      expect(error.message).toMatch(message)
    })

    it('an stz2 that is not 4, 8 or 16 bits, or claims more sizes than it holds', () => {
      const odd = fullBox('stz2', 0, 0, [0, 0, 0, 12], u32(4), [1, 2, 3, 4, 5, 6])
      const error = refusal(() => frameTable(trackWith(tablesOf({ stsz: odd }))))
      expect(error.reason).toBe('damaged')
      expect(error.message).toMatch(/'stz2'.*12 bits/)

      const long = refusal(() =>
        frameTable(trackWith(tablesOf({ stsz: stz2(4, [1, 2, 3, 4], 99) }))),
      )
      expect(long.reason).toBe('damaged')
      expect(long.message).toMatch(/'stz2'.*99/)
    })

    it('a co64 offset, or a chunk reaching past what a number holds exactly', () => {
      const wide = refusal(() => frameTable(trackWith(tablesOf({ stco: co64([100n, 2n ** 53n]) }))))
      expect(wide.reason).toBe('damaged')

      // The chunk starts below the limit; its samples carry it over.
      const over = refusal(() =>
        frameTable(
          trackWith(tablesOf({ stco: co64([100n, BigInt(Number.MAX_SAFE_INTEGER) - 50n]) })),
        ),
      )
      expect(over.reason).toBe('damaged')
      expect(over.message).toMatch(/offset/)
    })

    it('a count past what a track can have, however much the other tables agree with it', () => {
      const count = 2 ** 32 - 1
      const error = refusal(() =>
        frameTable(
          trackWith([
            stts([[count, 1]]),
            stsz({ size: 1, count }),
            stsc([[1, count]]),
            stco([100]),
          ]),
        ),
      )
      expect(error.reason).toBe('damaged')
      expect(error.message).toMatch(/'stsz'.*4294967295/)
    })

    it('a track that could not be read, with the reason it could not', () => {
      const track = readMovie(movie({ tracks: [{ stbl: new Uint8Array(0) }] })).tracks[0]
      if (!track?.problem) throw new Error('expected a track that could not be read')
      const error = refusal(() => frameTable(track))
      expect(error.reason).toBe('damaged')
      expect(error.message).toContain(track.problem)
    })
  })

  it('expands two hours of 60 fps, 432 000 frames, within 300 ms, in typed arrays', () => {
    const count = 2 * 60 * 60 * 60
    expect(count).toBe(432_000)
    const sizes = Array.from({ length: count }, (_, index) => 1000 + (index % 7919))
    const chunks = Array.from({ length: count }, (_, index) => 48 + index * 9000)
    const track = trackWith(
      [stts([[count, 1000]]), stsz(sizes), stsc([[1, 1]]), stco(chunks)],
      60000,
    )

    const start = performance.now()
    const frames = frameTable(track)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(300)
    expect(frames.count).toBe(count)
    expect(frames.timescale).toBe(60000)
    expect(frames.offsets).toBeInstanceOf(Float64Array)
    expect(frames.sizes).toBeInstanceOf(Uint32Array)
    expect(frames.dts).toBeInstanceOf(Float64Array)
    expect(frames.durations).toBeInstanceOf(Uint32Array)
    expect(frames.cts).toBeInstanceOf(Int32Array)
    expect(frames.sync).toBeInstanceOf(Uint8Array)
    expect([frames.offsets.length, frames.sizes.length, frames.dts.length]).toEqual([
      count,
      count,
      count,
    ])
    expect(frames.dts[count - 1]).toBe((count - 1) * 1000)
    expect(frames.offsets[count - 1]).toBe(48 + (count - 1) * 9000)
    expect(frames.sizes[count - 1]).toBe(1000 + ((count - 1) % 7919))
    expect(frames.sync[count - 1]).toBe(1)
  })
})
