import { describe, expect, it } from 'vitest'
import { childBoxes } from './boxes.ts'
import { Mp4Error } from './errors.ts'
import { readMovie } from './movie.ts'
import type { Movie } from './movie.ts'
import type { Part } from './testing/build.ts'
import {
  box,
  concat,
  dataEntry,
  dref,
  edts,
  fourcc,
  fullBox,
  hdlr,
  i32,
  mdhd,
  movie,
  mvhd,
  sampleEntry,
  stsd,
  tkhd,
  trak,
  u16,
  u32,
  u64,
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

/** The track `index` of a movie, which a test that builds it knows is there. */
function trackOf(read: Movie, index: number): Movie['tracks'][number] {
  const track = read.tracks[index]
  if (!track) throw new Error(`expected a track at ${index}`)
  return track
}

/** A sample table's box, with the entries it is given as its body: they are not expanded here, so only that they come out whole counts. */
function table(type: string, ...body: number[][]): Uint8Array {
  return fullBox(type, 0, 0, ...body)
}

describe("a movie's header and tracks (§10.4)", () => {
  it("reads the movie's timescale and each track's kind, timescale, size, language, matrix, entries and tables", () => {
    const avc1 = sampleEntry('avc1', [1, 2, 3, 4, 5, 6, 7, 8])
    const mp4a = sampleEntry('mp4a', [9, 8, 7])
    const videoTables = [
      table('stts', u32(1), u32(30), u32(1001)),
      table('ctts', u32(1), u32(30), u32(2002)),
      table('stss', u32(2), u32(1), u32(31)),
      table('stsz', u32(0), u32(3), u32(100), u32(200), u32(300)),
      table('stsc', u32(1), u32(1), u32(3), u32(1)),
      table('stco', u32(1), u32(4096)),
    ]
    const audioTables = [
      table('stts', u32(1), u32(9), u32(1024)),
      table('stz2', [0, 0, 0, 16], u32(2), u16(7), u16(9)),
      table('stsc', u32(1), u32(1), u32(9), u32(1)),
      table('co64', u32(1), u64(2n ** 32n + 12345n)),
    ]
    const moov = movie({
      version: 1,
      timescale: 600,
      duration: 2n ** 32n + 7n,
      tracks: [
        {
          id: 1,
          handler: 'vide',
          timescale: 30000,
          duration: 90090,
          language: 0x2681, // 'ita'
          // A portrait picture, turned a quarter turn: a, b, c, d, then u, v, w.
          matrix: [0, 0x10000, 0, -0x10000, 0, 0, 1080 * 0x10000, 0, 0x40000000],
          width: 1080.25,
          height: 1920.75,
          entries: [avc1],
          tables: videoTables,
        },
        {
          id: 2,
          handler: 'soun',
          tkhdVersion: 1,
          mdhdVersion: 1,
          timescale: 48000,
          duration: 2n ** 33n + 5n,
          language: 0x15c7, // 'eng'
          entries: [mp4a],
          tables: audioTables,
        },
      ],
    })
    // Inside a larger buffer, so every offset has to count the view's own.
    const wide = concat([1, 2, 3, 4, 5], moov, [6, 6])
    const bytes = wide.subarray(5, 5 + moov.length)
    expect(bytes.byteOffset).toBe(5)

    const read = readMovie(bytes)

    expect(read.timescale).toBe(600)
    expect(read.durationTicks).toBe(2 ** 32 + 7)
    expect(read.tracks).toHaveLength(2)
    expect(read.tracks[0]).toEqual({
      id: 1,
      kind: 'video',
      handler: 'vide',
      timescale: 30000,
      durationTicks: 90090,
      language: 'ita',
      width: 1080,
      height: 1920,
      matrix: Uint8Array.of(
        ...[0, 0, 0, 0],
        ...[0, 1, 0, 0],
        ...[0, 0, 0, 0],
        ...[0xff, 0xff, 0, 0],
        ...[0, 0, 0, 0],
        ...[0, 0, 0, 0],
        ...[0x04, 0x38, 0, 0],
        ...[0, 0, 0, 0],
        ...[0x40, 0, 0, 0],
      ),
      edits: null,
      dataReferences: null,
      entries: [{ type: 'avc1', bytes: avc1, stsdVersion: 0 }],
      tables: {
        stts: videoTables[0],
        ctts: videoTables[1],
        stss: videoTables[2],
        stsz: videoTables[3],
        stsc: videoTables[4],
        stco: videoTables[5],
      },
      problem: null,
    })
    expect(read.tracks[1]).toEqual({
      id: 2,
      kind: 'audio',
      handler: 'soun',
      timescale: 48000,
      durationTicks: 2 ** 33 + 5,
      language: 'eng',
      width: 0,
      height: 0,
      // The tkhd of version 1 is longer, so its matrix is further in: still this one.
      matrix: Uint8Array.of(
        ...[0, 1, 0, 0],
        ...[0, 0, 0, 0],
        ...[0, 0, 0, 0],
        ...[0, 0, 0, 0],
        ...[0, 1, 0, 0],
        ...[0, 0, 0, 0],
        ...[0, 0, 0, 0],
        ...[0, 0, 0, 0],
        ...[0x40, 0, 0, 0],
      ),
      edits: null,
      dataReferences: null,
      entries: [{ type: 'mp4a', bytes: mp4a, stsdVersion: 0 }],
      tables: {
        stts: audioTables[0],
        stz2: audioTables[1],
        stsc: audioTables[2],
        co64: audioTables[3],
      },
      problem: null,
    })

    // The entries and tables are views onto the moov, not copies of it.
    const video = trackOf(read, 0)
    expect(video.entries[0]?.bytes.buffer).toBe(wide.buffer)
    expect(video.tables.stco?.buffer).toBe(wide.buffer)
    const stcoAt = (video.tables.stco?.byteOffset ?? 0) - bytes.byteOffset
    expect(Array.from(bytes.subarray(stcoAt + 8, stcoAt + 12))).toEqual([0, 0, 0, 0])
    expect(Array.from(bytes.subarray(stcoAt + 12, stcoAt + 16))).toEqual([0, 0, 0, 1])
  })

  it('reads a movie header of version 0', () => {
    const read = readMovie(movie({ version: 0, timescale: 90000, duration: 4_000_000_000 }))
    expect(read).toEqual({ timescale: 90000, durationTicks: 4_000_000_000, tracks: [] })
  })

  it('calls a handler other than vide and soun other, and a language that is not three letters und', () => {
    const read = readMovie(
      movie({
        tracks: [
          { id: 1, handler: 'tmcd', language: 0 },
          { id: 2, handler: 'text', language: 0x7fff },
          // A Macintosh language code, as a MOV can hold, is below 0x400 and is not three letters.
          { id: 3, handler: 'sbtl', language: 0x0005 },
          { id: 4, handler: 'vide', language: 0x15c7 },
          { id: 5, handler: 'soun', language: 0xffff },
        ],
      }),
    )
    expect(
      read.tracks.map((track) => [track.id, track.kind, track.handler, track.language]),
    ).toEqual([
      [1, 'other', 'tmcd', 'und'],
      [2, 'other', 'text', 'und'],
      [3, 'other', 'sbtl', 'und'],
      [4, 'video', 'vide', 'eng'],
      [5, 'audio', 'soun', 'und'],
    ])
    expect(read.tracks.map((track) => track.problem)).toEqual([null, null, null, null, null])
  })

  it('lists every sample entry of a track, for the one who chooses to refuse several', () => {
    const first = sampleEntry('avc1', [1])
    const second = sampleEntry('avc3', [2, 2])
    const read = readMovie(movie({ tracks: [{ entries: [first, second] }] }))
    const track = trackOf(read, 0)
    expect(track.problem).toBeNull()
    expect(track.entries).toEqual([
      { type: 'avc1', bytes: first, stsdVersion: 0 },
      { type: 'avc3', bytes: second, stsdVersion: 0 },
    ])
  })

  it("gives each entry the version of the stsd it is in: 0 for a normal one, 1 for ISO's AudioSampleEntryV1", () => {
    const entry = sampleEntry('fLaC', [1, 2, 3])
    const versions = [0, 1].map((version) => {
      const stbl = box('stbl', fullBox('stsd', version, 0, u32(2), entry, entry))
      const read = readMovie(movie({ tracks: [{ handler: 'soun', stbl }] }))
      return trackOf(read, 0).entries.map((one) => one.stsdVersion)
    })
    expect(versions).toEqual([
      [0, 0],
      [1, 1],
    ])
    // A normal stsd is the one the builder makes.
    const plain = readMovie(movie({ tracks: [{ handler: 'soun', entries: [entry] }] }))
    expect(trackOf(plain, 0).entries.map((one) => one.stsdVersion)).toEqual([0])
  })

  it('keeps the first of a sample table that appears twice, and leaves other boxes of the stbl out', () => {
    const first = table('stts', u32(1), u32(5), u32(5))
    const second = table('stts', u32(1), u32(6), u32(6))
    const read = readMovie(
      movie({ tracks: [{ tables: [first, box('sgpd', [1, 2, 3]), second, table('stps')] }] }),
    )
    expect(trackOf(read, 0).tables).toEqual({ stts: first })
  })

  it('reads edit lists of version 0 and 1, an empty edit as mediaTime -1', () => {
    const read = readMovie(
      movie({
        tracks: [
          {
            id: 1,
            edits: {
              version: 0,
              edits: [
                { duration: 1200, mediaTime: -1 },
                { duration: 90000, mediaTime: 2002, rate: 0x10000 },
              ],
            },
          },
          {
            id: 2,
            edits: {
              version: 1,
              edits: [
                { duration: 2n ** 33n, mediaTime: -1n },
                { duration: 5, mediaTime: 2n ** 32n + 9n, rate: 0x8000 },
                { duration: 7, mediaTime: 0, rate: 0 },
              ],
            },
          },
          { id: 3, edits: { version: 0, edits: [] } },
          // No edit list at all: null, which is not the same as an empty one.
          { id: 4 },
        ],
      }),
    )
    expect(read.tracks.map((track) => track.problem)).toEqual([null, null, null, null])
    expect(trackOf(read, 0).edits).toEqual([
      { durationMovieTicks: 1200, mediaTime: -1, rate: 0x10000 },
      { durationMovieTicks: 90000, mediaTime: 2002, rate: 0x10000 },
    ])
    expect(trackOf(read, 1).edits).toEqual([
      { durationMovieTicks: 2 ** 33, mediaTime: -1, rate: 0x10000 },
      { durationMovieTicks: 5, mediaTime: 2 ** 32 + 9, rate: 0x8000 },
      { durationMovieTicks: 7, mediaTime: 0, rate: 0 },
    ])
    expect(trackOf(read, 2).edits).toEqual([])
    expect(trackOf(read, 3).edits).toBeNull()

    // An `edts` without an `elst` has no edits to give.
    const bare = box(
      'trak',
      tkhd({ id: 5 }),
      box('edts'),
      box('mdia', mdhd(), hdlr('vide'), box('minf', box('stbl', stsd([sampleEntry('avc1')])))),
    )
    const readBare = readMovie(movie({ tracks: [bare] }))
    expect(trackOf(readBare, 0).problem).toBeNull()
    expect(trackOf(readBare, 0).edits).toBeNull()
  })

  it('refuses a fragmented file', () => {
    const fragmented = movie({
      tracks: [{ id: 1 }],
      extra: [box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)))],
    })
    expect(refusal(() => readMovie(fragmented)).reason).toBe('fragmented')
    // It is the first thing said, before a header that can't be read is.
    expect(refusal(() => readMovie(box('moov', box('mvex'), box('mvhd')))).reason).toBe(
      'fragmented',
    )
    // An `mvex` deeper in a track is not the movie's.
    const inside = box('trak', box('mvex'))
    expect(readMovie(movie({ tracks: [inside] })).tracks[0]?.problem).not.toBeNull()
  })

  it('reads a moov and its lists that end in the 4 zero bytes QuickTime writes', () => {
    const zero = [0, 0, 0, 0]
    const track = box(
      'trak',
      tkhd({ id: 7, width: 640, height: 480 }),
      box(
        'mdia',
        mdhd({ timescale: 44100 }),
        hdlr('soun'),
        box('minf', box('stbl', stsd([sampleEntry('sowt')]), table('stts', u32(0)), zero), zero),
        zero,
      ),
      zero,
    )
    const moov = box('moov', mvhd({ timescale: 600 }), track, zero)
    const read = readMovie(moov)
    expect(read.timescale).toBe(600)
    expect(read.tracks).toHaveLength(1)
    const only = trackOf(read, 0)
    expect(only.problem).toBeNull()
    expect([only.id, only.kind, only.timescale, only.width, only.height]).toEqual([
      7,
      'audio',
      44100,
      640,
      480,
    ])
    expect(only.entries.map((entry) => entry.type)).toEqual(['sowt'])
    expect(Object.keys(only.tables)).toEqual(['stts'])
  })
})

describe('what a movie that is not sound refuses, and what only a track does (§10.4)', () => {
  it('refuses a moov that cannot be walked, or that has no readable movie header', () => {
    const good = movie({ tracks: [{ id: 1 }] })
    const reasons = (bytes: Uint8Array) => refusal(() => readMovie(bytes)).reason

    expect(reasons(new Uint8Array(0))).toBe('damaged')
    expect(reasons(box('ftyp', fourcc('isom')))).toBe('damaged')
    // A box that claims more than the bytes hold.
    expect(reasons(good.subarray(0, good.length - 1))).toBe('damaged')
    // A moov whose own children can't be walked: one claims more than the moov holds.
    expect(reasons(box('moov', mvhd(), concat(u32(500), fourcc('trak'), [1, 2, 3])))).toBe(
      'damaged',
    )
    // No movie header, a movie header cut short, one of a version there is none of.
    expect(reasons(box('moov', trak({ id: 1 })))).toBe('damaged')
    expect(reasons(box('moov'))).toBe('damaged')
    expect(reasons(box('moov', box('mvhd', [0, 0, 0, 0, 1, 2, 3])))).toBe('damaged')
    expect(reasons(box('moov', fullBox('mvhd', 2, 0, new Array<number>(96).fill(0))))).toBe(
      'damaged',
    )
    // The first box is not the moov.
    expect(reasons(concat(box('free'), good))).toBe('damaged')
  })

  it('parses a broken extra track as a problem on that track only', () => {
    const video = {
      id: 1,
      handler: 'vide',
      timescale: 30000,
      width: 1920,
      height: 1080,
      tables: [table('stts', u32(1), u32(30), u32(1001))],
    }
    const audio = { id: 2, handler: 'soun', timescale: 48000, entries: [sampleEntry('mp4a')] }
    // A third track whose `stbl` claims more than the `minf` it is in holds.
    const broken = {
      id: 3,
      handler: 'vide',
      timescale: 600,
      width: 64,
      height: 48,
      stbl: concat(u32(500), fourcc('stbl'), stsd([sampleEntry('avc1')])),
    }
    const clean = readMovie(movie({ tracks: [video, audio] }))
    const read = readMovie(movie({ tracks: [video, audio, broken] }))

    expect(read.tracks).toHaveLength(3)
    // The first two are what they are without the third.
    expect(read.tracks[0]).toEqual(clean.tracks[0])
    expect(read.tracks[1]).toEqual(clean.tracks[1])
    expect(trackOf(read, 0).problem).toBeNull()
    expect(trackOf(read, 1).problem).toBeNull()

    // The third says why, keeps what was read before it failed, and holds nothing of the table.
    const third = trackOf(read, 2)
    expect(third.problem).toContain("'stbl'")
    expect(third.problem).toContain('500')
    expect(third).toEqual({
      id: 3,
      kind: 'video',
      handler: 'vide',
      timescale: 600,
      durationTicks: 0,
      language: 'und',
      width: 64,
      height: 48,
      matrix: expect.any(Uint8Array) as Uint8Array,
      edits: null,
      dataReferences: null,
      entries: [],
      tables: {},
      problem: third.problem,
    })
  })

  it('keeps a problem on the track whichever of its boxes is wrong, and reads the others', () => {
    const wholeMedia = (...children: Uint8Array[]) => box('mdia', ...children)
    const stbl = box('stbl', stsd([sampleEntry('avc1')]))
    const goodMinf = box('minf', stbl)
    const cases: [string, Uint8Array, string][] = [
      ['no tkhd', box('trak', wholeMedia(mdhd(), hdlr('vide'), goodMinf)), "no 'tkhd'"],
      [
        'a tkhd cut short',
        box('trak', box('tkhd', [0, 0, 0, 0, 1, 2]), wholeMedia(mdhd(), hdlr('vide'), goodMinf)),
        'runs past',
      ],
      ['no mdia', box('trak', tkhd({ id: 1 })), "no 'mdia'"],
      ['no mdhd', box('trak', tkhd(), wholeMedia(hdlr('vide'), goodMinf)), "no 'mdhd'"],
      [
        'an mdhd of a version there is none of',
        box(
          'trak',
          tkhd(),
          wholeMedia(box('mdhd', [2, 0, 0, 0, 0, 0, 0, 0]), hdlr('vide'), goodMinf),
        ),
        'version 2',
      ],
      ['no hdlr', box('trak', tkhd(), wholeMedia(mdhd(), goodMinf)), "no 'hdlr'"],
      [
        'an hdlr cut short',
        box('trak', tkhd(), wholeMedia(mdhd(), box('hdlr', [0, 0, 0, 0, 0, 0]), goodMinf)),
        'runs past',
      ],
      ['no minf', box('trak', tkhd(), wholeMedia(mdhd(), hdlr('vide'))), "no 'minf'"],
      [
        'no stbl',
        box('trak', tkhd(), wholeMedia(mdhd(), hdlr('vide'), box('minf', box('dinf')))),
        "no 'stbl'",
      ],
      [
        'no stsd',
        box(
          'trak',
          tkhd(),
          wholeMedia(mdhd(), hdlr('vide'), box('minf', box('stbl', table('stts')))),
        ),
        "no 'stsd'",
      ],
      [
        'an stsd that counts 2 entries and holds 1',
        box(
          'trak',
          tkhd(),
          wholeMedia(
            mdhd(),
            hdlr('vide'),
            box('minf', box('stbl', stsd([sampleEntry('avc1')], 2))),
          ),
        ),
        '2 entries',
      ],
      [
        'an stsd with no entries',
        box('trak', tkhd(), wholeMedia(mdhd(), hdlr('vide'), box('minf', box('stbl', stsd([]))))),
        'no sample description',
      ],
      [
        'an stsd that counts 0 entries and holds 1',
        box(
          'trak',
          tkhd(),
          wholeMedia(
            mdhd(),
            hdlr('vide'),
            box('minf', box('stbl', stsd([sampleEntry('avc1')], 0))),
          ),
        ),
        '0 entries',
      ],
      [
        'an stsd cut short',
        box(
          'trak',
          tkhd(),
          wholeMedia(mdhd(), hdlr('vide'), box('minf', box('stbl', box('stsd', [0, 0, 0, 0, 0])))),
        ),
        'runs past',
      ],
      [
        'an elst that counts more edits than it holds',
        box(
          'trak',
          tkhd(),
          box('edts', fullBox('elst', 0, 0, u32(1000), u32(1), i32(0), u32(0x10000))),
          wholeMedia(mdhd(), hdlr('vide'), goodMinf),
        ),
        'edit',
      ],
    ]
    for (const [name, broken, why] of cases) {
      const read = readMovie(movie({ tracks: [{ id: 1 }, broken, { id: 3, handler: 'soun' }] }))
      const [first, second, third] = read.tracks
      expect(read.tracks, name).toHaveLength(3)
      expect(first?.problem, name).toBeNull()
      expect(third?.problem, name).toBeNull()
      expect(third?.kind, name).toBe('audio')
      expect(second?.problem, name).toContain(why)
      expect(second?.entries, name).toEqual([])
      expect(second?.tables, name).toEqual({})
    }
  })

  it('keeps the id, kind and times of a track whose sample table is the part that is wrong', () => {
    const track = box(
      'trak',
      tkhd({ id: 9, width: 100, height: 50 }),
      box('edts', fullBox('elst', 0, 0, u32(1), u32(30), i32(5), u32(0x10000))),
      box('mdia', mdhd({ timescale: 25, duration: 250 }), hdlr('soun'), box('minf')),
    )
    const read = readMovie(movie({ tracks: [track] }))
    const only = trackOf(read, 0)
    expect(only.problem).toContain("'stbl'")
    expect([only.id, only.kind, only.handler, only.timescale, only.durationTicks]).toEqual([
      9,
      'audio',
      'soun',
      25,
      250,
    ])
    expect([only.width, only.height]).toEqual([100, 50])
    expect(only.edits).toEqual([{ durationMovieTicks: 30, mediaTime: 5, rate: 0x10000 }])
    expect(only.entries).toEqual([])
    expect(only.tables).toEqual({})
  })
})

describe('what a track needs, and what it does not (§10.4)', () => {
  it('gives a track whose media timescale is 0 a problem, and leaves the others', () => {
    const clean = readMovie(movie({ tracks: [{ id: 1 }, { id: 3, handler: 'soun' }] }))
    const read = readMovie(
      movie({
        tracks: [{ id: 1 }, { id: 2, timescale: 0, duration: 500 }, { id: 3, handler: 'soun' }],
      }),
    )
    expect(read.tracks).toHaveLength(3)
    expect(read.tracks[0]).toEqual(clean.tracks[0])
    expect(read.tracks[2]).toEqual(clean.tracks[1])
    const zero = trackOf(read, 1)
    expect(zero.problem).toContain("'mdhd'")
    expect(zero.problem).toContain('timescale')
    expect(zero.id).toBe(2)
    // A movie's own timescale of 0 is left as it is: what reads edit lists guards it.
    expect(readMovie(movie({ timescale: 0, tracks: [{ id: 1 }] })).timescale).toBe(0)
  })

  it('reads a track clean when a box that is damaged comes after the ones it needs', () => {
    // A box that claims more bytes than are left in the box it is in.
    const vendor = concat(u32(500), fourcc('udta'), [1, 2, 3])
    const tables = [table('stts', u32(1), u32(30), u32(1001)), table('stco', u32(1), u32(4096))]
    const avc1 = sampleEntry('avc1', [1, 2])
    const stbl = (...after: Part[]) => box('stbl', stsd([avc1]), ...tables, ...after)
    const minf = (...after: Part[]) => box('minf', stbl(), ...after)
    const mdia = (...after: Part[]) =>
      box('mdia', mdhd({ timescale: 90000 }), hdlr('vide'), minf(), ...after)
    const withStbl = (...after: Part[]) =>
      box('mdia', mdhd({ timescale: 90000 }), hdlr('vide'), box('minf', stbl(...after)))
    const edits = edts(0, [{ duration: 600, mediaTime: 1001 }])

    const clean = trackOf(readMovie(movie({ tracks: [box('trak', tkhd({ id: 4 }), mdia())] })), 0)
    expect(clean.problem).toBeNull()
    expect(clean.entries).toEqual([{ type: 'avc1', bytes: avc1, stsdVersion: 0 }])
    expect(Object.keys(clean.tables)).toEqual(['stts', 'stco'])

    // After `mdia`, in the trak: the `edts` that is looked for isn't there, or is before `mdia`.
    const afterMedia = readMovie(
      movie({
        tracks: [
          box('trak', tkhd({ id: 4 }), mdia(), vendor),
          box('trak', tkhd({ id: 4 }), edits, mdia(), vendor),
        ],
      }),
    )
    expect(trackOf(afterMedia, 0)).toEqual(clean)
    expect(trackOf(afterMedia, 1)).toEqual({
      ...clean,
      edits: [{ durationMovieTicks: 600, mediaTime: 1001, rate: 0x10000 }],
    })

    // After the last box read, in `mdia`, in `minf` and in `stbl`.
    const deeper = readMovie(
      movie({
        tracks: [
          box('trak', tkhd({ id: 4 }), mdia(vendor)),
          box(
            'trak',
            tkhd({ id: 4 }),
            box('mdia', mdhd({ timescale: 90000 }), hdlr('vide'), minf(vendor)),
          ),
          box('trak', tkhd({ id: 4 }), withStbl(vendor)),
        ],
      }),
    )
    expect(deeper.tracks).toEqual([clean, clean, clean])

    // Damage in front of a box that is needed hides it, and that is the track's problem.
    const before = readMovie(movie({ tracks: [box('trak', tkhd({ id: 4 }), vendor, mdia())] }))
    expect(trackOf(before, 0).problem).toContain("'udta'")
  })

  it('gives a track a problem when what is damaged is a table, or the descriptions, in its stbl', () => {
    const vendor = concat(u32(500), fourcc('udta'), [1, 2, 3])
    const aTable = (type: string) => concat(u32(500), fourcc(type), [1, 2, 3])
    const inStbl = (...children: Part[]) =>
      box('trak', tkhd(), box('mdia', mdhd(), hdlr('vide'), box('minf', box('stbl', ...children))))
    const read = readMovie(
      movie({
        tracks: [
          // The damage is of another kind of box, after the descriptions and a table: not a problem.
          inStbl(stsd([sampleEntry('avc1')]), table('stts', u32(0)), vendor),
          // The damage is of a table, or of the descriptions.
          inStbl(stsd([sampleEntry('avc1')]), table('stts', u32(0)), aTable('stco')),
          inStbl(table('stts', u32(0)), aTable('stsd')),
        ],
      }),
    )
    const [fine, table1, table2] = read.tracks
    expect(fine?.problem).toBeNull()
    expect(fine?.entries).toHaveLength(1)
    expect(Object.keys(fine?.tables ?? {})).toEqual(['stts'])
    expect(table1?.problem).toContain("'stco'")
    expect(table2?.problem).toContain("'stsd'")
  })

  it("keeps a broken track's kind when its handler can be read", () => {
    const stbl = box('stbl', stsd([sampleEntry('avc1')]))
    const media = (handler: string, ...first: Uint8Array[]) =>
      box('mdia', ...first, hdlr(handler), box('minf', stbl))
    const cutTkhd = box('tkhd', [0, 0, 0, 0, 1, 2])
    const read = readMovie(
      movie({
        tracks: [
          // A picture whose media says a timescale of 0: its `mdhd` is read before the rest and fails.
          { id: 1, handler: 'vide', timescale: 0 },
          // A picture and a sound whose `tkhd` can't be read, before their `mdia`.
          box('trak', cutTkhd, media('vide', mdhd())),
          box('trak', cutTkhd, media('soun', mdhd())),
          // An `mdhd` that is missing, and an edit list that is wrong, after the handler.
          box('trak', tkhd(), media('vide')),
          box(
            'trak',
            tkhd(),
            box('edts', fullBox('elst', 0, 0, u32(1000), u32(1), i32(0), u32(0x10000))),
            media('soun', mdhd()),
          ),
          // The handler is what can't be found or read: nothing says what the track is.
          box('trak', tkhd(), box('mdia', mdhd(), box('minf', stbl))),
          box(
            'trak',
            tkhd(),
            box('mdia', mdhd(), box('hdlr', [0, 0, 0, 0, 0, 0]), box('minf', stbl)),
          ),
          // A handler that is neither, and a track that fails after it.
          box('trak', cutTkhd, media('tmcd', mdhd())),
        ],
      }),
    )
    expect(read.tracks.map((track) => [track.kind, track.problem !== null])).toEqual([
      ['video', true],
      ['video', true],
      ['audio', true],
      ['video', true],
      ['audio', true],
      ['other', true],
      ['other', true],
      ['other', true],
    ])
    expect(trackOf(read, 0).handler).toBe('vide')
    expect(trackOf(read, 1).handler).toBe('vide')
    expect(trackOf(read, 5).handler).toBe('')
  })

  it('reads a movie that is followed by bytes that are not boxes', () => {
    const moov = movie({ timescale: 600, tracks: [{ id: 1 }, { id: 2, handler: 'soun' }] })
    const expected = readMovie(moov)
    expect(readMovie(concat(moov, [1, 2, 3]))).toEqual(expected)
    expect(readMovie(concat(moov, u32(500), fourcc('mdat'), [1, 2, 3]))).toEqual(expected)
    expect(readMovie(concat(moov, box('free', [1])))).toEqual(expected)
  })
})

describe("where a track's frames are kept (§10.4)", () => {
  it('reads the data references of a track, and which of them are the file itself', () => {
    const read = readMovie(
      movie({
        tracks: [
          { id: 1, dinf: box('dinf', dref([dataEntry('url ', 1)])) },
          {
            id: 2,
            handler: 'soun',
            // Only bit 0 of the flags says the data is in this file: 3 has it, 2 hasn't, and an alias's own bytes follow its flags.
            dinf: box(
              'dinf',
              dref([
                dataEntry('url ', 1),
                dataEntry('alis', 0, [1, 2, 3, 4]),
                dataEntry('rsrc', 3),
                dataEntry('urn ', 2),
              ]),
            ),
          },
        ],
      }),
    )
    expect(trackOf(read, 0).dataReferences).toEqual([{ type: 'url ', selfContained: true }])
    expect(trackOf(read, 1).dataReferences).toEqual([
      { type: 'url ', selfContained: true },
      { type: 'alis', selfContained: false },
      { type: 'rsrc', selfContained: true },
      { type: 'urn ', selfContained: false },
    ])
    expect(trackOf(read, 0).problem).toBeNull()
    expect(trackOf(read, 1).problem).toBeNull()
  })

  it('has no data references for a track with no dinf or no dref, and an empty list for a dref with no entry', () => {
    const read = readMovie(
      movie({
        tracks: [
          { id: 1, dinf: null },
          // The default: a `dinf` with nothing in it.
          { id: 2 },
          { id: 3, dinf: box('dinf', box('free', [1, 2, 3])) },
          { id: 4, dinf: box('dinf', dref([])) },
        ],
      }),
    )
    expect(read.tracks.map((track) => track.dataReferences)).toEqual([null, null, null, []])
    expect(read.tracks.map((track) => track.problem)).toEqual([null, null, null, null])
  })

  it('gives a track a problem when its dinf or dref is cut short, counts wrongly, or holds an entry that is not a whole box', () => {
    const stbl = box('stbl', stsd([sampleEntry('avc1')]))
    // A box that claims more bytes than are left in the box it is in.
    const torn = (type: string) => concat(u32(500), fourcc(type), [1, 2, 3])
    const inMinf = (...children: Part[]) =>
      box('trak', tkhd(), box('mdia', mdhd(), hdlr('vide'), box('minf', ...children)))
    const cases: [string, Uint8Array, string][] = [
      [
        'a dref that counts 2 entries and holds 1',
        trak({ dinf: box('dinf', dref([dataEntry('url ', 1)], 2)) }),
        '2 entries',
      ],
      [
        'a dref that counts 0 entries and holds 1',
        trak({ dinf: box('dinf', dref([dataEntry('url ', 1)], 0)) }),
        '0 entries',
      ],
      [
        'an entry that claims more than the dref holds',
        trak({ dinf: box('dinf', fullBox('dref', 0, 0, u32(1), torn('url '))) }),
        "'url '",
      ],
      [
        'an entry too short to hold its flags',
        trak({ dinf: box('dinf', dref([box('url ', [0, 0])])) }),
        'runs past',
      ],
      [
        'a dref cut short before its count',
        trak({ dinf: box('dinf', box('dref', [0, 0, 0])) }),
        'runs past',
      ],
      // The damage is in a box that says where the data is, or hides it: the track can't be told to have it in its own file.
      [
        'a dref whose header claims more than the dinf holds',
        trak({ dinf: box('dinf', torn('dref')) }),
        "'dref'",
      ],
      [
        'a dinf with damage in front of its dref',
        trak({ dinf: box('dinf', torn('udta'), dref([dataEntry('url ', 1)])) }),
        "'udta'",
      ],
      // After the tables, which the damage doesn't hide.
      ['a dinf whose header claims more than the minf holds', inMinf(stbl, torn('dinf')), "'dinf'"],
    ]
    for (const [name, broken, why] of cases) {
      const read = readMovie(movie({ tracks: [{ id: 1 }, broken, { id: 3, handler: 'soun' }] }))
      const [first, second, third] = read.tracks
      expect(read.tracks, name).toHaveLength(3)
      expect(first?.problem, name).toBeNull()
      expect(third?.problem, name).toBeNull()
      expect(second?.problem, name).toContain(why)
      expect(second?.dataReferences, name).toBeNull()
      // It is still the picture it was.
      expect(second?.kind, name).toBe('video')
    }
  })

  it('reads the data references of a track whose damage comes after them, or is in a box of another kind', () => {
    const torn = (type: string) => concat(u32(500), fourcc(type), [1, 2, 3])
    const refs = dref([dataEntry('alis', 0)])
    const stbl = box('stbl', stsd([sampleEntry('avc1')]))
    const inMinf = (...children: Part[]) =>
      box('trak', tkhd(), box('mdia', mdhd(), hdlr('vide'), box('minf', ...children)))
    const read = readMovie(
      movie({
        tracks: [
          // In the dinf, after the dref; in the minf, after the dinf and the stbl.
          trak({ dinf: box('dinf', refs, torn('udta')) }),
          inMinf(box('dinf', refs), stbl, torn('udta')),
          // In the minf, with no dinf at all, after the stbl: nothing says the data is anywhere else.
          inMinf(stbl, torn('udta')),
        ],
      }),
    )
    const [after, deeper, none] = read.tracks
    expect(after?.problem).toBeNull()
    expect(after?.dataReferences).toEqual([{ type: 'alis', selfContained: false }])
    expect(deeper?.problem).toBeNull()
    expect(deeper?.dataReferences).toEqual([{ type: 'alis', selfContained: false }])
    expect(none?.problem).toBeNull()
    expect(none?.dataReferences).toBeNull()
  })
})

/** Two tracks with small tables and data references, an edit list on one, in a `moov` that also holds a `udta`. */
function index(): Uint8Array {
  return movie({
    version: 1,
    timescale: 600,
    duration: 6000,
    tracks: [
      {
        id: 1,
        handler: 'vide',
        timescale: 30000,
        duration: 90000,
        language: 0x15c7,
        width: 1920,
        height: 1080,
        edits: { version: 0, edits: [{ duration: 600, mediaTime: 1001 }] },
        dinf: box('dinf', dref([dataEntry('url ', 1)])),
        entries: [sampleEntry('avc1', [1, 2, 3, 4, 5, 6, 7, 8])],
        tables: [
          table('stts', u32(1), u32(30), u32(1001)),
          table('stsz', u32(0), u32(3), u32(100), u32(200), u32(300)),
          table('stsc', u32(1), u32(1), u32(3), u32(1)),
          table('stco', u32(1), u32(4096)),
        ],
      },
      {
        id: 2,
        handler: 'soun',
        tkhdVersion: 1,
        mdhdVersion: 1,
        timescale: 48000,
        duration: 96000,
        language: 0x2681,
        dinf: box('dinf', dref([dataEntry('alis', 1, [1, 2, 3, 4]), dataEntry('url ', 0)])),
        entries: [sampleEntry('mp4a', [9, 8, 7])],
        tables: [table('stts', u32(1), u32(9), u32(1024)), table('co64', u32(1), u64(2n ** 32n))],
      },
    ],
    extra: [box('udta', box('free', [1, 2, 3]))],
  })
}

/** `bytes` cut at `length`, with the size of every box the cut falls inside rewritten to end there, so that only what is cut off is missing, and everything left claims no more than it holds. */
function cutAt(bytes: Uint8Array, length: number): Uint8Array {
  // The boxes whose children are boxes, and the bytes of its own that each holds before them (a `dref` has its version, flags and count).
  const containers = new Map([
    ['moov', 0],
    ['trak', 0],
    ['edts', 0],
    ['mdia', 0],
    ['minf', 0],
    ['dinf', 0],
    ['dref', 8],
    ['stbl', 0],
  ])
  const out = bytes.slice(0, length)
  const view = new DataView(out.buffer)
  const shrink = (from: number, to: number): void => {
    for (const entry of childBoxes(bytes, from, to)) {
      if (entry.start < length && length < entry.end) {
        if (entry.start + 4 <= length) view.setUint32(entry.start, length - entry.start)
        const fields = containers.get(entry.type)
        if (fields !== undefined) shrink(entry.body + fields, entry.end)
        return
      }
    }
  }
  shrink(0, bytes.length)
  return out
}

/** What reading `bytes` gives: the movie, or the refusal, and never another error. */
function outcome(bytes: Uint8Array): Movie | Mp4Error {
  try {
    return readMovie(bytes)
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    return error as Mp4Error
  }
}

describe('a moov that is cut short or damaged (§10.4)', () => {
  it('refuses every truncation of a valid index with Mp4Error only', () => {
    const moov = index()
    expect(readMovie(moov).tracks).toHaveLength(2)
    for (let length = 0; length < moov.length; length += 1) {
      outcome(moov.subarray(0, length))
    }
  })

  it('refuses a valid index cut anywhere, its boxes resized to end there, with Mp4Error only', () => {
    const moov = index()
    let refused = 0
    let kept = 0
    let flagged = 0
    for (let length = 0; length < moov.length; length += 1) {
      const result = outcome(cutAt(moov, length))
      if (result instanceof Mp4Error) {
        refused += 1
      } else {
        kept += 1
        if (result.tracks.some((track) => track.problem !== null)) flagged += 1
      }
    }
    // The cuts reach both what fails the file and what only fails a track.
    expect(refused).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(0)
    expect(flagged).toBeGreaterThan(0)
  })

  it('reads a valid index with any one byte changed to a Movie or an Mp4Error only', () => {
    const moov = index()
    let refused = 0
    let flagged = 0
    for (let at = 0; at < moov.length; at += 1) {
      for (const value of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
        const changed = moov.slice()
        changed[at] = value
        const result = outcome(changed)
        if (result instanceof Mp4Error) {
          refused += 1
        } else if (result.tracks.some((track) => track.problem !== null)) {
          flagged += 1
        }
      }
    }
    expect(refused).toBeGreaterThan(0)
    expect(flagged).toBeGreaterThan(0)
  })
})
