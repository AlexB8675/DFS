import { describe, expect, it } from 'vitest'
import { childBoxes, firstBox, Reader } from './boxes.ts'
import type { Box } from './boxes.ts'
import { chooseTracks } from './choose.ts'
import type { PlayTrack } from './choose.ts'
import { Mp4Error } from './errors.ts'
import { frameTable } from './frames.ts'
import { readMovie } from './movie.ts'
import {
  avcC,
  box,
  ctts,
  esds,
  frma,
  movie,
  quickTimeAudioEntry,
  stco,
  stsc,
  stss,
  stsz,
  stts,
  visualEntry,
  wave,
} from './testing/build.ts'
import { fragment, fragmentHead, initSegment } from './write.ts'

/** A file of a mebibyte: it holds every frame that the tables here place (the furthest ends at 9 600). */
const FILE_SIZE = 2 ** 20

const PICTURE = visualEntry('avc1', {}, avcC())
/** A sound as QuickTime writes it, which the init segment carries rewritten as an ISO one. */
const QUICKTIME_SOUND = quickTimeAudioEntry(
  'mp4a',
  { version: 1, channels: 2, sampleRate: 48000 },
  wave(frma('mp4a'), esds()),
)

/** A picture turned a quarter turn: the matrix a phone's video holds. */
const ROTATED_90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]
const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]

const PICTURE_ID = 3
const SOUND_ID = 5

// What a trun says of a frame's flags: a keyframe depends on no other frame
// (sample_depends_on 2), any other depends on one (1) and is not a sync sample.
const SYNC = 0x02000000
const NOT_SYNC = 0x01010000

/**
 * 6 pictures in 2 chunks far apart, decoded for 1000 ticks (the first two) and
 * 1500 (the rest), with keyframes at the samples 1 and 4 and composition
 * offsets of 2000, -1000 and then 500, which are signed.
 */
function pictureTables(): Uint8Array[] {
  return [
    stts([
      [2, 1000],
      [4, 1500],
    ]),
    ctts(1, [
      [1, 2000],
      [1, -1000],
      [4, 500],
    ]),
    stsz([10, 20, 30, 40, 50, 60]),
    stsc([[1, 3]]),
    stco([1000, 5000]),
    stss([1, 4]),
  ]
}

/** 5 sound frames in one chunk, each a sync sample as a table with no `stss` says. */
function soundTables(): Uint8Array[] {
  return [stts([[5, 1024]]), stsz([100, 110, 120, 130, 140]), stsc([[1, 5]]), stco([9000])]
}

/** A picture and a sound, chosen from a movie as the repackager chooses them. */
function play(): { video: PlayTrack; audio: PlayTrack } {
  const { video, audio } = chooseTracks(
    readMovie(
      movie({
        timescale: 1000,
        tracks: [
          {
            id: PICTURE_ID,
            handler: 'vide',
            timescale: 30000,
            language: 'fra',
            width: 1920.5,
            height: 1080,
            matrix: ROTATED_90,
            // An edit list that the init segment must leave out: the player's SourceBuffer takes it as an offset.
            // (It starts at 0, where the picture's first frame is shown: an edit that starts later is refused.)
            edits: { version: 0, edits: [{ duration: 500, mediaTime: 0 }] },
            entries: [PICTURE],
            tables: pictureTables(),
          },
          {
            id: SOUND_ID,
            handler: 'soun',
            timescale: 48000,
            language: 'ita',
            entries: [QUICKTIME_SOUND],
            tables: soundTables(),
          },
        ],
      }),
    ),
    FILE_SIZE,
  )
  if (!audio) throw new Error('expected a sound')
  return { video, audio }
}

/** The box with this type among the boxes inside `parent` (the whole of `bytes` when there is none). */
function within(bytes: Uint8Array, parent: Box | null, type: string): Box {
  const [from, to] = parent ? [parent.body, parent.end] : [0, bytes.length]
  const found = childBoxes(bytes, from, to).find((entry) => entry.type === type)
  if (!found) throw new Error(`expected a '${type}' box`)
  return found
}

/** The boxes inside the box at the end of `path` (the top level of the bytes for no path). */
function children(bytes: Uint8Array, ...path: string[]): Box[] {
  let parent: Box | null = null
  for (const type of path) parent = within(bytes, parent, type)
  return parent ? childBoxes(bytes, parent.body, parent.end) : childBoxes(bytes, 0, bytes.length)
}

function typesIn(bytes: Uint8Array, ...path: string[]): string[] {
  return children(bytes, ...path).map((entry) => entry.type)
}

/** The box at the end of `path`. */
function find(bytes: Uint8Array, ...path: string[]): Box {
  let parent: Box | null = null
  for (const type of path) parent = within(bytes, parent, type)
  if (!parent) throw new Error('expected a path')
  return parent
}

/** A cursor in the body of the box at the end of `path`. */
function bodyOf(bytes: Uint8Array, ...path: string[]): Reader {
  const found = find(bytes, ...path)
  return new Reader(bytes, found.body, found.end)
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`expected an item at ${index}`)
  return item
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A number of 32 bits, signed or not, as its 4 bytes. */
function word(value: number): number[] {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setInt32(0, value | 0)
  return Array.from(out)
}

/** The language `mdhd` packs: three letters, each 5 bits from the top, as an offset from 0x60. */
function packed(code: string): number {
  return Array.from(code, (letter) => letter.charCodeAt(0) - 0x60).reduce(
    (sum, offset) => (sum << 5) | offset,
    0,
  )
}

/** The copy of a track that has these changes in its header. */
function withHeader(track: PlayTrack, header: Partial<PlayTrack['header']>): PlayTrack {
  return { ...track, header: { ...track.header, ...header } }
}

/** The copy of a track whose frames are these sizes (and decode times, from 0 for each if there are none given): a table that no file has to be made of. */
function withFrames(track: PlayTrack, sizes: number[], dts?: number[]): PlayTrack {
  const count = sizes.length
  return {
    ...track,
    table: {
      ...track.table,
      count,
      offsets: new Float64Array(count),
      sizes: Uint32Array.from(sizes),
      dts: Float64Array.from(dts ?? sizes.map(() => 0)),
      durations: new Uint32Array(count).fill(1),
      cts: new Int32Array(count),
      sync: new Uint8Array(count).fill(1),
    },
  }
}

describe('the init segment (§10.4)', () => {
  it('writes an init segment that parses back as one track with the entry, the timescale and no edit list', () => {
    const { video, audio } = play()
    // What makes this test mean something: the picture has an edit list to leave out,
    // and the sound's own entry is not the one that the init segment is to carry.
    expect(video.header.edits).not.toBeNull()
    expect(audio.entry).not.toEqual(nth(audio.header.entries, 0).bytes)

    const cases = [
      { track: video, handler: 'vide', kind: 'video', id: PICTURE_ID },
      { track: audio, handler: 'soun', kind: 'audio', id: SOUND_ID },
    ] as const
    for (const { track, handler, kind, id } of cases) {
      const init = initSegment(track)
      expect(typesIn(init)).toEqual(['ftyp', 'moov'])

      // A fragmented file's index is what the reader turns away, for there is nothing in it to split: the mvex is there.
      const moov = find(init, 'moov')
      let refused: unknown = null
      try {
        readMovie(init.subarray(moov.start, moov.end))
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(Mp4Error)
      expect((refused as Mp4Error).reason).toBe('fragmented')

      // The same index without it parses as a movie of the one track.
      const mvex = find(init, 'moov', 'mvex')
      const parsed = readMovie(box('moov', init.subarray(moov.body, mvex.start)))
      expect(parsed.timescale).toBe(1000)
      expect(parsed.durationTicks).toBe(0)
      expect(parsed.tracks).toHaveLength(1)
      const only = nth(parsed.tracks, 0)
      expect(only).toMatchObject({
        id,
        kind,
        handler,
        timescale: track.header.timescale,
        durationTicks: 0,
        language: track.header.language,
        edits: null,
        problem: null,
      })
      expect(only.entries).toHaveLength(1)
      expect(nth(only.entries, 0).bytes).toEqual(track.entry)
      // The tables are there, are well formed and describe no frame.
      expect(Object.keys(only.tables).sort()).toEqual(['stco', 'stsc', 'stsz', 'stts'])
      expect(frameTable(only, FILE_SIZE).count).toBe(0)
    }
  })

  it("copies the track's matrix and size into the init segment", () => {
    const { video, audio } = play()
    const rotated = Uint8Array.from(ROTATED_90.flatMap(word))
    expect(video.header.matrix).toEqual(rotated)

    const tkhd = bodyOf(initSegment(video), 'moov', 'trak', 'tkhd')
    expect(tkhd.u8()).toBe(0) // version
    expect(tkhd.u24()).toBe(3) // enabled, and in the movie
    tkhd.skip(8) // created, modified
    expect(tkhd.u32()).toBe(PICTURE_ID)
    tkhd.skip(4) // reserved
    expect(tkhd.u32()).toBe(0) // duration
    tkhd.skip(8) // reserved
    expect(tkhd.i16()).toBe(0) // layer
    expect(tkhd.i16()).toBe(0) // alternate group
    expect(tkhd.u16()).toBe(0) // a picture has no volume
    tkhd.skip(2) // reserved
    expect(tkhd.bytes(36)).toEqual(rotated)
    // 16.16, the integer part of the source's: the fraction of 1920.5 is not carried.
    expect(tkhd.u32()).toBe(1920 * 0x10000)
    expect(tkhd.u32()).toBe(1080 * 0x10000)
    expect(tkhd.remaining).toBe(0)

    // A sound has no size, and its volume is 1.0.
    const soundHeader = bodyOf(initSegment(audio), 'moov', 'trak', 'tkhd')
    soundHeader.skip(4 + 8 + 4 + 4 + 4 + 8 + 2 + 2) // up to the volume: version and flags, times, ID, reserved, duration, reserved, layer, group
    expect(soundHeader.u16()).toBe(0x0100)
    soundHeader.skip(2) // reserved
    expect(soundHeader.bytes(36)).toEqual(Uint8Array.from(audio.header.matrix))
    expect(soundHeader.u32()).toBe(0)
    expect(soundHeader.u32()).toBe(0)

    // Even for a sound whose source gave it a size.
    const sized = bodyOf(
      initSegment(withHeader(audio, { width: 640, height: 480 })),
      'moov',
      'trak',
      'tkhd',
    )
    sized.skip(4 + 8 + 4 + 4 + 4 + 8 + 2 + 2 + 2 + 2 + 36)
    expect(sized.u32()).toBe(0)
    expect(sized.u32()).toBe(0)
  })

  it('writes the boxes Media Source reads around the track, and none of an edit list', () => {
    const { video, audio } = play()
    const cases = [
      { track: video, handler: 'vide', name: 'VideoHandler', media: 'vmhd', id: PICTURE_ID },
      { track: audio, handler: 'soun', name: 'SoundHandler', media: 'smhd', id: SOUND_ID },
    ]
    for (const { track, handler, name, media, id } of cases) {
      const init = initSegment(track)
      expect(typesIn(init, 'moov')).toEqual(['mvhd', 'trak', 'mvex'])
      expect(typesIn(init, 'moov', 'trak')).toEqual(['tkhd', 'mdia'])
      expect(typesIn(init, 'moov', 'trak', 'mdia')).toEqual(['mdhd', 'hdlr', 'minf'])
      expect(typesIn(init, 'moov', 'trak', 'mdia', 'minf')).toEqual([media, 'dinf', 'stbl'])
      expect(typesIn(init, 'moov', 'mvex')).toEqual(['trex'])

      const brands = bodyOf(init, 'ftyp')
      expect(brands.fourcc()).toBe('isom')
      expect(brands.u32()).toBe(0x200)
      const compatible: string[] = []
      while (brands.remaining > 0) compatible.push(brands.fourcc())
      expect(compatible).toEqual(['isom', 'iso6', 'mp41'])

      // Time in thousandths of a second, no length, normal rate and volume, the identity matrix.
      const mvhd = bodyOf(init, 'moov', 'mvhd')
      expect(mvhd.u8()).toBe(0)
      mvhd.skip(3 + 8) // flags, created, modified
      expect(mvhd.u32()).toBe(1000)
      expect(mvhd.u32()).toBe(0)
      expect(mvhd.u32()).toBe(0x10000)
      expect(mvhd.u16()).toBe(0x0100)
      mvhd.skip(10) // reserved
      expect(mvhd.bytes(36)).toEqual(Uint8Array.from(IDENTITY.flatMap(word)))
      mvhd.skip(24) // pre-defined
      expect(mvhd.u32()).toBe(id + 1)
      expect(mvhd.remaining).toBe(0)

      const mdhd = bodyOf(init, 'moov', 'trak', 'mdia', 'mdhd')
      expect(mdhd.u8()).toBe(0)
      mdhd.skip(3 + 8)
      expect(mdhd.u32()).toBe(track.header.timescale)
      expect(mdhd.u32()).toBe(0)
      expect(mdhd.u16()).toBe(packed(track.header.language))
      expect(mdhd.u16()).toBe(0)
      expect(mdhd.remaining).toBe(0)

      const hdlr = bodyOf(init, 'moov', 'trak', 'mdia', 'hdlr')
      hdlr.skip(4 + 4) // version and flags, pre-defined
      expect(hdlr.fourcc()).toBe(handler)
      hdlr.skip(12) // reserved
      expect(String.fromCharCode(...hdlr.bytes(hdlr.remaining))).toBe(`${name}\0`)

      // A picture's media header has the flag 1 that ISO asks of it, and a sound's none.
      const header = bodyOf(init, 'moov', 'trak', 'mdia', 'minf', media)
      expect(header.u8()).toBe(0)
      expect(header.u24()).toBe(media === 'vmhd' ? 1 : 0)
      expect(header.remaining).toBe(media === 'vmhd' ? 8 : 4)

      // The data is in the same stream: the one reference is flagged as self-contained.
      const dref = find(init, 'moov', 'trak', 'mdia', 'minf', 'dinf', 'dref')
      const reference = new Reader(init, dref.body, dref.end)
      reference.skip(4)
      expect(reference.u32()).toBe(1)
      const urls = childBoxes(init, reference.position, dref.end)
      expect(urls.map((entry) => entry.type)).toEqual(['url '])
      const url = new Reader(init, nth(urls, 0).body, nth(urls, 0).end)
      expect(url.u8()).toBe(0)
      expect(url.u24()).toBe(1)
      expect(url.remaining).toBe(0)
    }
  })

  it("holds the track's entry as it is in stsd, and tables and a trex that describe no frame", () => {
    const { video, audio } = play()
    for (const { track, id } of [
      { track: video, id: PICTURE_ID },
      { track: audio, id: SOUND_ID },
    ]) {
      const init = initSegment(track)
      const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl']
      expect(typesIn(init, ...stbl)).toEqual(['stsd', 'stts', 'stsc', 'stsz', 'stco'])

      const stsd = find(init, ...stbl, 'stsd')
      const entries = bodyOf(init, ...stbl, 'stsd')
      expect(entries.u32()).toBe(0) // version and flags
      expect(entries.u32()).toBe(1)
      expect(init.subarray(entries.position, stsd.end)).toEqual(track.entry)

      for (const type of ['stts', 'stsc', 'stco']) {
        const table = bodyOf(init, ...stbl, type)
        expect(table.u32()).toBe(0)
        expect(table.u32()).toBe(0) // no entry
        expect(table.remaining).toBe(0)
      }
      const sizes = bodyOf(init, ...stbl, 'stsz')
      expect(sizes.u32()).toBe(0)
      expect(sizes.u32()).toBe(0) // no size for all
      expect(sizes.u32()).toBe(0) // no sample
      expect(sizes.remaining).toBe(0)

      const trex = bodyOf(init, 'moov', 'mvex', 'trex')
      expect(trex.u32()).toBe(0) // version and flags
      expect(trex.u32()).toBe(id)
      expect(trex.u32()).toBe(1) // the one sample description
      expect(trex.u32()).toBe(0) // duration, size and flags, which each frame says for itself
      expect(trex.u32()).toBe(0)
      expect(trex.u32()).toBe(0)
      expect(trex.remaining).toBe(0)
    }
  })

  it("points the entry at the init segment's only data reference, and leaves the track's own entry as it was", () => {
    const { video, audio } = play()
    // The index of the data reference, which an entry holds after its 8-byte header and 6 reserved bytes.
    const indexIn = (entry: Uint8Array): number =>
      new DataView(entry.buffer, entry.byteOffset, entry.byteLength).getUint16(14)
    for (const track of [video, audio]) {
      expect(indexIn(track.entry)).toBe(1)
      for (const index of [0, 2, 0xffff]) {
        // The entry among other bytes, as a view onto a moov holds it.
        const space = new Uint8Array(track.entry.length + 8)
        space.set(track.entry, 4)
        new DataView(space.buffer).setUint16(4 + 14, index)
        const entry = space.subarray(4, 4 + track.entry.length)
        const before = Uint8Array.from(space)

        const init = initSegment({ ...track, entry })
        const stsd = find(init, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd')
        const written = init.subarray(stsd.body + 8, stsd.end)
        expect(indexIn(written), `index ${index}`).toBe(1)
        // The rest of the entry is as it was, byte for byte.
        expect(written).toHaveLength(track.entry.length)
        expect(written.subarray(0, 14)).toEqual(track.entry.subarray(0, 14))
        expect(written.subarray(16)).toEqual(track.entry.subarray(16))
        // And nothing that was given is written to: not the entry, and not the bytes around it that it is a view of.
        expect(space).toEqual(before)
      }
    }
  })

  it('packs the language back as it was read, and says und for what is not three letters', () => {
    const { video } = play()
    const languageOf = (track: PlayTrack): number => {
      const mdhd = bodyOf(initSegment(track), 'moov', 'trak', 'mdia', 'mdhd')
      mdhd.skip(4 + 8 + 4 + 4)
      return mdhd.u16()
    }
    expect(languageOf(video)).toBe((6 << 10) | (18 << 5) | 1) // fra
    expect(languageOf(withHeader(video, { language: 'und' }))).toBe((21 << 10) | (14 << 5) | 4)
    for (const language of ['', 'en', 'EN', 'engl', 'e1g']) {
      expect(languageOf(withHeader(video, { language })), language).toBe(packed('und'))
    }
  })

  it("gives the track's ID to the movie header, the track header and the trex, and keeps the next one in 32 bits", () => {
    const { video } = play()
    for (const id of [1, PICTURE_ID, 0x7fffffff, 0xfffffffe, 0xffffffff]) {
      const init = initSegment(withHeader(video, { id }))
      const next = bodyOf(init, 'moov', 'mvhd')
      next.skip(4 + 8 + 4 + 4 + 4 + 2 + 10 + 36 + 24)
      expect(next.u32(), `next ID after ${id}`).toBe(Math.min(id + 1, 0xffffffff))
      const tkhd = bodyOf(init, 'moov', 'trak', 'tkhd')
      tkhd.skip(4 + 8)
      expect(tkhd.u32()).toBe(id)
      const trex = bodyOf(init, 'moov', 'mvex', 'trex')
      trex.skip(4)
      expect(trex.u32()).toBe(id)
    }
  })

  it('writes the same bytes for the same track', () => {
    const { video, audio } = play()
    expect(initSegment(video)).toEqual(initSegment(video))
    expect(initSegment(audio)).toEqual(initSegment(audio))
    expect(initSegment(video)).not.toEqual(initSegment(audio))
  })
})

/** The frame bytes of a file in which the byte at an offset is that offset modulo 251: bytes that say where they came from. */
function fileBytes(offset: number, size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, k) => (offset + k) % 251)
}

/** A `bytesAt` that records what it is asked for, and answers with `answer`. */
function recorder(answer: (offset: number, size: number, call: number) => Uint8Array = fileBytes): {
  calls: [offset: number, size: number][]
  bytesAt: (offset: number, size: number) => Uint8Array
} {
  const calls: [offset: number, size: number][] = []
  return {
    calls,
    bytesAt: (offset, size) => {
      calls.push([offset, size])
      return answer(offset, size, calls.length - 1)
    },
  }
}

interface RunRead {
  version: number
  flags: number
  count: number
  dataOffset: number
  frames: { duration: number; size: number; flags: number; offset: number }[]
}

interface MoofRead {
  types: { moof: string[]; traf: string[] }
  sequence: number
  tfhd: { version: number; flags: number; id: number; remaining: number }
  tfdt: { version: number; time: number; remaining: number }
  trun: RunRead
}

/** What the boxes of a `moof` say, read with the package's own reader. */
function readMoof(bytes: Uint8Array, moof: Box): MoofRead {
  const traf = within(bytes, moof, 'traf')
  const typesOf = (parent: Box): string[] =>
    childBoxes(bytes, parent.body, parent.end).map((entry) => entry.type)
  const mfhd = within(bytes, moof, 'mfhd')
  const sequence = new Reader(bytes, mfhd.body, mfhd.end)
  sequence.skip(4)

  const tfhdBox = within(bytes, traf, 'tfhd')
  const tfhd = new Reader(bytes, tfhdBox.body, tfhdBox.end)
  const tfhdVersion = tfhd.u8()
  const tfhdFlags = tfhd.u24()
  const id = tfhd.u32()

  const tfdtBox = within(bytes, traf, 'tfdt')
  const tfdt = new Reader(bytes, tfdtBox.body, tfdtBox.end)
  const tfdtVersion = tfdt.u8()
  tfdt.skip(3)
  const time = tfdt.u64()

  const trunBox = within(bytes, traf, 'trun')
  const trun = new Reader(bytes, trunBox.body, trunBox.end)
  const version = trun.u8()
  const flags = trun.u24()
  const count = trun.u32()
  const dataOffset = trun.i32()
  const frames = Array.from({ length: count }, () => ({
    duration: trun.u32(),
    size: trun.u32(),
    flags: trun.u32(),
    offset: trun.i32(),
  }))
  return {
    types: { moof: typesOf(moof), traf: typesOf(traf) },
    sequence: sequence.u32(),
    tfhd: { version: tfhdVersion, flags: tfhdFlags, id, remaining: tfhd.remaining },
    tfdt: { version: tfdtVersion, time, remaining: tfdt.remaining },
    trun: { version, flags, count, dataOffset, frames },
  }
}

/** A fragment taken apart: its top-level boxes, what its moof says and the bytes of its mdat. */
function readFragment(bytes: Uint8Array): MoofRead & { top: string[]; moof: Box; mdat: Box } {
  const [moof, mdat, ...rest] = childBoxes(bytes, 0, bytes.length)
  if (!moof || !mdat) throw new Error('expected a moof and an mdat')
  return {
    ...readMoof(bytes, moof),
    top: [moof, mdat, ...rest].map((entry) => entry.type),
    moof,
    mdat,
  }
}

describe('fragments (§10.4)', () => {
  it("writes a fragment whose trun gives each frame's duration, size, flags and signed offset, and whose mdat holds the frames' bytes in order", () => {
    const { video } = play()
    const { bytesAt } = recorder()
    const bytes = fragment(video, 1, 5, 7, bytesAt)
    const read = readFragment(bytes)

    expect(read.top).toEqual(['moof', 'mdat'])
    expect(read.types).toEqual({ moof: ['mfhd', 'traf'], traf: ['tfhd', 'tfdt', 'trun'] })
    expect(read.sequence).toBe(7)
    // The base of the data is the moof, with no other field in the tfhd than the track's ID.
    expect(read.tfhd).toEqual({ version: 0, flags: 0x020000, id: PICTURE_ID, remaining: 0 })
    // The decode time of the first frame, raw: the edit list's offset is the player's.
    expect(read.tfdt).toEqual({ version: 1, time: 1000, remaining: 0 })
    expect(read.trun.version).toBe(1)
    // The data offset, and each frame's duration, size, flags and composition offset.
    expect(read.trun.flags).toBe(0x000f01)
    expect(read.trun.count).toBe(4)
    expect(read.trun.frames).toEqual([
      { duration: 1000, size: 20, flags: NOT_SYNC, offset: -1000 },
      { duration: 1500, size: 30, flags: NOT_SYNC, offset: 500 },
      { duration: 1500, size: 40, flags: SYNC, offset: 500 },
      { duration: 1500, size: 50, flags: NOT_SYNC, offset: 500 },
    ])

    // The offset is from the start of the moof (which is where the fragment starts) to the first frame's bytes.
    expect(read.moof.start).toBe(0)
    expect(read.trun.dataOffset).toBe(read.mdat.body)
    expect(read.mdat.end).toBe(bytes.length)
    expect(bytes.subarray(read.mdat.body)).toEqual(
      join([fileBytes(1010, 20), fileBytes(1030, 30), fileBytes(5000, 40), fileBytes(5040, 50)]),
    )
  })

  it('writes a sound as it writes a picture, every frame of it a sync sample, from the decode time of its first frame', () => {
    const { audio } = play()
    const bytes = fragment(audio, 0, 5, 1, recorder().bytesAt)
    const read = readFragment(bytes)
    expect(read.sequence).toBe(1)
    expect(read.tfhd.id).toBe(SOUND_ID)
    expect(read.tfdt.time).toBe(0)
    expect(read.trun.frames).toEqual(
      [100, 110, 120, 130, 140].map((size) => ({
        duration: 1024,
        size,
        flags: SYNC,
        offset: 0,
      })),
    )
    expect(read.trun.dataOffset).toBe(read.mdat.body)
    expect(bytes.subarray(read.mdat.body)).toEqual(fileBytes(9000, 600))

    // The decode time is the table's for the first frame of the range, whichever it is.
    expect(readFragment(fragment(audio, 3, 5, 2, recorder().bytesAt)).tfdt.time).toBe(3072)
  })

  it('marks keyframes and only keyframes as sync', () => {
    const { video, audio } = play()
    for (const track of [video, audio]) {
      const { trun } = readFragment(fragment(track, 0, track.table.count, 1, recorder().bytesAt))
      expect(trun.frames).toHaveLength(track.table.count)
      const synced = trun.frames.flatMap((frame, index) => (frame.flags === SYNC ? [index] : []))
      expect(synced).toEqual(Array.from(track.keyframes))
      for (const frame of trun.frames) {
        expect([SYNC, NOT_SYNC]).toContain(frame.flags)
        // Bit 16 is sample_is_non_sync_sample: set for the frames that are not keyframes, and for no other.
        expect((frame.flags & 0x10000) !== 0).toBe(frame.flags === NOT_SYNC)
      }
    }
    // The picture's are its first frame and its fourth.
    expect(Array.from(video.keyframes)).toEqual([0, 3])
    expect(Array.from(audio.keyframes)).toEqual([0, 1, 2, 3, 4])
  })

  it("takes nothing it isn't asked for", () => {
    const { video } = play()
    const first = recorder()
    const one = fragment(video, 2, 5, 9, first.bytesAt)
    // Once for each frame of the range, in order, with that frame's offset and size.
    expect(first.calls).toEqual([
      [1030, 30],
      [5000, 40],
      [5040, 50],
    ])
    // Nothing is kept between calls: the same arguments give the same bytes.
    const second = recorder()
    const two = fragment(video, 2, 5, 9, second.bytesAt)
    expect(two).toEqual(one)
    expect(second.calls).toEqual(first.calls)
    expect(fragment(video, 2, 5, 9, recorder().bytesAt)).toEqual(one)
    // And the other arguments change the bytes.
    expect(fragment(video, 2, 5, 10, recorder().bytesAt)).not.toEqual(one)
    // The track is not changed by being written.
    expect(play().video.table).toEqual(video.table)
  })

  it("gives the track's ID to every fragment as it does to the init segment", () => {
    const { video, audio } = play()
    for (const { track, id } of [
      { track: video, id: PICTURE_ID },
      { track: audio, id: SOUND_ID },
    ]) {
      expect(readFragment(fragment(track, 0, 1, 1, recorder().bytesAt)).tfhd.id).toBe(id)
      const tkhd = bodyOf(initSegment(track), 'moov', 'trak', 'tkhd')
      tkhd.skip(4 + 8)
      expect(tkhd.u32()).toBe(id)
    }
  })

  it('numbers a fragment up to the largest number of 32 bits', () => {
    const { video } = play()
    expect(readFragment(fragment(video, 0, 1, 1, recorder().bytesAt)).sequence).toBe(1)
    expect(readFragment(fragment(video, 0, 1, 0xffffffff, recorder().bytesAt)).sequence).toBe(
      0xffffffff,
    )
  })

  it('writes the bytes it always has for a small fragment', () => {
    // Pinned, so that a change in how the moof is put together can't change a byte of it unseen: the first three
    // frames of the picture, a keyframe and then two that depend on others (the second with a negative composition offset).
    const { video } = play()
    const bytes = fragment(video, 0, 3, 7, recorder().bytesAt)
    const pinned = [
      '000000886d6f6f66', // moof
      '000000106d6668640000000000000007', // mfhd
      '0000007074726166', // traf
      '00000010746668640002000000000003', // tfhd
      '0000001474666474010000000000000000000000', // tfdt
      '000000447472756e01000f010000000300000090', // trun: version 1, flags 0xf01, 3 frames, data offset 144
      '000003e80000000a02000000000007d0', // frame 0: 1000 ticks, 10 bytes, keyframe, offset 2000
      '000003e80000001401010000fffffc18', // frame 1: 1000 ticks, 20 bytes, depends on others, offset -1000
      '000005dc0000001e01010000000001f4', // frame 2: 1500 ticks, 30 bytes, depends on others, offset 500
      '000000446d646174', // mdat
      'f7f8f9fa000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637', // the 60 bytes of the three frames
    ].join('')
    expect(Buffer.from(bytes).toString('hex')).toBe(pinned)
  })

  it('refuses a range or a sequence number that is not one, before it asks for any bytes', () => {
    const { video } = play()
    const ranges: [number, number][] = [
      [3, 3],
      [0, 0],
      [6, 6],
      [4, 2],
      [-1, 2],
      [0, 7],
      [7, 8],
      [0.5, 2],
      [1, 2.5],
      [Number.NaN, 2],
      [0, Number.NaN],
      [0, Infinity],
    ]
    for (const [from, to] of ranges) {
      const { bytesAt, calls } = recorder()
      expect(() => fragment(video, from, to, 1, bytesAt), `${from} to ${to}`).toThrow(RangeError)
      expect(calls).toEqual([])
    }
    for (const sequence of [0, -1, 1.5, 2 ** 32, Number.NaN, Infinity]) {
      const { bytesAt, calls } = recorder()
      expect(() => fragment(video, 0, 2, sequence, bytesAt), `sequence ${sequence}`).toThrow(
        RangeError,
      )
      expect(calls).toEqual([])
    }
  })

  it("refuses bytes of another length than the frame's, and asks for no more after them", () => {
    const { video } = play()
    for (const delta of [-1, 1, -30]) {
      const { bytesAt, calls } = recorder((offset, size, call) =>
        // The second frame of the range, which is 30 bytes.
        fileBytes(offset, call === 1 ? size + delta : size),
      )
      expect(() => fragment(video, 1, 5, 1, bytesAt), `${delta}`).toThrow(RangeError)
      expect(calls).toEqual([
        [1010, 20],
        [1030, 30],
      ])
    }
  })

  it('writes the decode time in 64 bits, as the table has it', () => {
    const { video } = play()
    const track = withFrames(video, [1, 1, 1], [0, 2 ** 33, 2 ** 40 + 5])
    const { head } = fragmentHead(track, 1, 3, 1)
    const moof = firstBox(head, 0, head.length)
    if (!moof) throw new Error('expected a moof')
    expect(readMoof(head, moof).tfdt).toEqual({ version: 1, time: 2 ** 33, remaining: 0 })
    const later = fragmentHead(track, 2, 3, 1).head
    const laterMoof = firstBox(later, 0, later.length)
    if (!laterMoof) throw new Error('expected a moof')
    expect(readMoof(later, laterMoof).tfdt.time).toBe(2 ** 40 + 5)
  })
})

describe('the size of the mdat (§10.4)', () => {
  /** What the head of a fragment of frames of these sizes says of its mdat: where it starts and the header it has there. */
  function mdatOf(sizes: number[]): {
    payload: number
    headerSize: number
    size: number
    wide: boolean
    dataOffset: number
    moofEnd: number
    headLength: number
  } {
    const { video } = play()
    const { head, payload } = fragmentHead(withFrames(video, sizes), 0, sizes.length, 1)
    const moof = firstBox(head, 0, head.length)
    if (!moof) throw new Error('expected a moof')
    const header = new Reader(head, moof.end, head.length)
    const size = header.u32()
    expect(header.fourcc()).toBe('mdat')
    const wide = size === 1
    return {
      payload,
      headerSize: head.length - moof.end,
      size: wide ? header.u64() : size,
      wide,
      dataOffset: readMoof(head, moof).trun.dataOffset,
      moofEnd: moof.end,
      headLength: head.length,
    }
  }

  it('is the 32-bit size header up to a payload of 2^32 - 9 bytes', () => {
    const small = mdatOf([10, 20])
    expect(small).toMatchObject({ payload: 30, headerSize: 8, size: 38, wide: false })
    expect(small.dataOffset).toBe(small.moofEnd + 8)

    // The largest size that 32 bits hold, which is 8 bytes of header and the rest.
    const largest = mdatOf([2 ** 31, 2 ** 31 - 9])
    expect(largest).toMatchObject({
      payload: 2 ** 32 - 9,
      headerSize: 8,
      size: 2 ** 32 - 1,
      wide: false,
    })
    expect(largest.dataOffset).toBe(largest.moofEnd + 8)
  })

  it('is the 64-bit size header from a payload of 2^32 - 8 bytes, with the data offset after its 16 bytes', () => {
    const wide = mdatOf([2 ** 31, 2 ** 31 - 8])
    // A size of 1, the type, then the size in 64 bits, which counts the 16 bytes of header.
    expect(wide).toMatchObject({
      payload: 2 ** 32 - 8,
      headerSize: 16,
      size: 2 ** 32 + 8,
      wide: true,
    })
    expect(wide.dataOffset).toBe(wide.moofEnd + 16)

    const huge = mdatOf([2 ** 32 - 1, 2 ** 32 - 1, 2 ** 32 - 1])
    expect(huge).toMatchObject({ payload: 3 * (2 ** 32 - 1), headerSize: 16, wide: true })
    expect(huge.size).toBe(3 * (2 ** 32 - 1) + 16)
    expect(huge.dataOffset).toBe(huge.moofEnd + 16)
  })
})
