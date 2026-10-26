import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import type { Mp4Refusal } from '../errors.ts'
import type { FrameTable } from '../frames.ts'
import type { ByteRange } from '../source.ts'
import { matroskaMovie } from '../testing/ebml.ts'
import type { Movie, MovieCluster, MovieFrame, MovieSpec, TrackSpec } from '../testing/ebml.ts'
import { fragment, fragmentHead } from '../write.ts'
import type { FragmentTrack } from '../write.ts'
import { readHeader } from './ebml.ts'
import { readMatroska } from './read.ts'
import type { MatroskaIndex } from './read.ts'
import { matroskaFrames, matroskaStart } from './spans.ts'
import type { MatroskaCursor } from './spans.ts'
import { startDecode } from './timing.ts'

// The frames of a span of a Matroska file, as tables for the writer, and the cursor
// to go on with (DESIGN.md §10.4, D45). Every file is built in code by
// `matroskaMovie`, and the values that are expected are written out from the
// evidence (x264's B-frames at 30 frames a second, depth 2, presented at 0, 100,
// 33, 67, 233, 167, 133 and 200 ms in decode order, as ffmpeg wrote them
// 2026-10-25, and the dts the remux gives them) and from the rule of the brief, not
// computed by the module. The heart is that a file read in chunks gives the frames
// that one read of all of it does, however it is cut.

/** A file with no chunk missing from it: the index is made from all of it. */
function indexOf(bytes: Uint8Array): MatroskaIndex {
  const step = readMatroska([{ start: 0, bytes }], bytes.length)
  if (!('done' in step)) throw new Error('the index asked for more than the whole file')
  return step.done
}

/** What is there, which a test knows to be. */
function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('expected a value')
  return value
}

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

/** The `avcC` record of x264 for generated 320x240 pictures with B-frames (2026-10-25): `has_b_frames` 2, level 1.3. */
const X264_B_FRAMES =
  '0164000dffe100196764000dacd94141fb0110000003001000000303c0f142996001000668ebe3cb22c0fdf8f800'

/** The uncompressed header of a profile 0 VP9 keyframe: frame marker, profile 0, a keyframe, the sync code, 8 bits and color_space 0 with a limited range. */
const VP9_KEYFRAME = [0x82, 0x49, 0x83, 0x42, 0x00]

/** An OpusHead (RFC 7845 §5.1): stereo at 48 kHz with a pre-skip of 312 samples. */
function opusHead(): Uint8Array {
  const out = new Uint8Array(19)
  out.set(Array.from('OpusHead', (letter) => letter.charCodeAt(0)))
  const data = new DataView(out.buffer)
  out[8] = 1
  out[9] = 2
  data.setUint16(10, 312, true)
  data.setUint32(12, 48000, true)
  return out
}

/** The picture of x264's B-frames, at 30 frames a second. */
const H264: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_MPEG4/ISO/AVC',
  codecPrivate: fromHex(X264_B_FRAMES),
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

/** The VP9 picture of ffmpeg's WebM, with no DefaultDuration; `VP9` has it. */
const VP9_BARE: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_VP9',
  video: { pixelWidth: 320, pixelHeight: 240 },
}
const VP9: TrackSpec = { ...VP9_BARE, defaultDuration: 33_333_333 }

/** A stereo Opus sound of 20 ms frames (track 2). */
const OPUS: TrackSpec = {
  number: 2,
  type: 2,
  codecId: 'A_OPUS',
  codecPrivate: opusHead(),
  codecDelay: 6_500_000,
  seekPreRoll: 80_000_000,
  defaultDuration: 20_000_000,
  audio: { samplingFrequency: 48000, channels: 2 },
}

/** What header stripping took from the start of every frame of the AAC sound. */
const AAC_PREFIX = Uint8Array.of(0xff, 0xf1)

/** A stereo AAC-LC sound at 48 kHz (AudioSpecificConfig 0x1190) with no DefaultDuration, whose frames are timed one after another by the 1024 samples each holds, and whose headers are stripped (ContentCompAlgo 3). */
const AAC: TrackSpec = {
  number: 2,
  type: 2,
  codecId: 'A_AAC',
  codecPrivate: Uint8Array.of(0x11, 0x90),
  audio: { samplingFrequency: 48000, channels: 2 },
  encodings: [{ compression: { algo: 3, settings: AAC_PREFIX } }],
}

/** Bytes of a frame that no other frame has: its tag, then the low byte of its size, then filling, so that it can be found in a file by what it holds. */
function tagged(tag: number, size = 8): Uint8Array {
  const out = new Uint8Array(size).fill(0x11)
  out[0] = tag
  out[1] = size & 0xff
  out[2] = tag ^ 0xff
  return out
}

/** A VP9 keyframe (the header, then a tag in the last byte so that the frame is found by it). */
function vp9Key(tag: number): Uint8Array {
  const out = new Uint8Array(8)
  out.set(VP9_KEYFRAME)
  out[7] = tag
  return out
}

/** Where `data` lies in `file`, which must be in one place only. */
function locate(file: Uint8Array, data: Uint8Array): number {
  const found: number[] = []
  const first = data[0] ?? 0
  for (let at = file.indexOf(first); at !== -1; at = file.indexOf(first, at + 1)) {
    if (data.every((byte, offset) => file[at + offset] === byte)) found.push(at)
  }
  if (found.length !== 1) throw new Error(`a frame of tag ${first} is in ${found.length} places`)
  return must(found[0])
}

/** Where the block of a SimpleBlock that holds `data` starts: its ID, its size (one byte), its track number, its timecode and its flags come first. */
function blockStart(file: Uint8Array, data: Uint8Array): number {
  const at = locate(file, data) - 6
  if (file[at] !== 0xa3) throw new Error(`there is no SimpleBlock at ${at}`)
  return at
}

/** A frame of a built movie whose bytes are known. */
interface Known extends MovieFrame {
  data: Uint8Array
}

/** A frame of the picture (track 1) at `time` with its tag; a VP9 keyframe holds the header the entry is made from. */
function picture(time: number, tag: number, over: Omit<Partial<MovieFrame>, 'data'> = {}): Known {
  const data = over.keyframe === true ? vp9Key(tag) : tagged(tag)
  return { track: 1, time, data, ...over }
}

/** A frame of the sound (track 2) at `time`; a sound frame is a sync sample. */
function sound(time: number, tag: number): Known {
  return { track: 2, time, keyframe: true, data: tagged(tag) }
}

/** A movie of VP9 and Opus in a millisecond scale (or the one given). */
function vp9Opus(clusters: MovieCluster[], over: Partial<MovieSpec> = {}): Movie {
  return matroskaMovie({
    duration: 4021,
    scale: 1_000_000,
    tracks: [VP9, OPUS],
    clusters,
    ...over,
  })
}

/** What `run` throws, which must be an `Mp4Error` of this reason. */
function refused(reason: Mp4Refusal, run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe(reason)
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error')
}

/** A frame of a table, every field of it. */
interface Row {
  offset: number
  size: number
  dts: number
  cts: number
  duration: number
  sync: number
}

function rowsOf(table: FrameTable): Row[] {
  expect(table.offsets).toHaveLength(table.count)
  expect(table.sizes).toHaveLength(table.count)
  expect(table.dts).toHaveLength(table.count)
  expect(table.durations).toHaveLength(table.count)
  expect(table.cts).toHaveLength(table.count)
  expect(table.sync).toHaveLength(table.count)
  return Array.from({ length: table.count }, (_, at) => ({
    offset: must(table.offsets[at]),
    size: must(table.sizes[at]),
    dts: must(table.dts[at]),
    cts: must(table.cts[at]),
    duration: must(table.durations[at]),
    sync: must(table.sync[at]),
  }))
}

/** The tables of a call, as rows added to those of a track's earlier calls. */
function collect(into: Map<number, Row[]>, frames: readonly FragmentTrack[]): void {
  for (const track of frames) {
    const rows = into.get(track.header.id) ?? []
    rows.push(...rowsOf(track.table))
    into.set(track.header.id, rows)
  }
}

/** The ranges with those that touch or overlap joined, in order. */
function merged(ranges: readonly ByteRange[]): ByteRange[] {
  const out: ByteRange[] = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else out.push({ ...range })
  }
  return out
}

/** What a walk over a file in chunks gives. */
interface Driven {
  rows: Map<number, Row[]>
  skipped: ByteRange[]
  calls: number
  cursor: MatroskaCursor
}

/**
 * Reads a file the way the engine does: each call is given the chunk from where the
 * cursor is to the next of the cuts, and when the cursor doesn't move, a chunk that
 * reaches to the cut after that (or to the file's end), until the cursor says the
 * Segment has ended. The dts of a track must rise from call to call.
 */
function drive(
  index: MatroskaIndex,
  bytes: Uint8Array,
  cuts: readonly number[],
  soundId: number | null,
): Driven {
  const ordered = [...new Set(cuts)].sort((a, b) => a - b)
  const rows = new Map<number, Row[]>()
  const skipped: ByteRange[] = []
  let cursor = matroskaStart(index, soundId)
  let floor = cursor.at
  let calls = 0
  while (!cursor.ended) {
    calls += 1
    const stop = ordered.find((cut) => cut > floor) ?? bytes.length
    const chunk = { start: cursor.at, bytes: bytes.subarray(cursor.at, stop) }
    const result = matroskaFrames(index, cursor, chunk)
    collect(rows, result.frames)
    skipped.push(...result.skipped)
    const moved = result.cursor.at !== cursor.at
    if (!moved && stop >= bytes.length && !result.cursor.ended) {
      throw new Error(
        `the cursor stays at ${cursor.at} with the whole rest of the file in the chunk`,
      )
    }
    floor = moved ? result.cursor.at : stop
    cursor = result.cursor
  }
  for (const list of rows.values()) {
    for (const [at, row] of list.entries()) {
      if (at > 0) expect(row.dts).toBeGreaterThan(must(list[at - 1]).dts)
    }
  }
  return { rows, skipped, calls, cursor }
}

/** The result of one call that is given the file from its start to its end. */
function allAtOnce(index: MatroskaIndex, bytes: Uint8Array, soundId: number | null) {
  const result = matroskaFrames(index, matroskaStart(index, soundId), { start: 0, bytes })
  const rows = new Map<number, Row[]>()
  collect(rows, result.frames)
  return { ...result, rows }
}

/** Where every cluster and every element in it starts, and where the file ends: each block boundary. */
function boundaries(movie: Movie): number[] {
  const cuts: number[] = [movie.bytes.length]
  for (const range of movie.clusters) {
    cuts.push(range.start)
    const cluster = must(readHeader(movie.bytes, range.start, range.end))
    for (let at = cluster.data; at < range.end;) {
      const child = must(readHeader(movie.bytes, at, range.end))
      cuts.push(child.start)
      at = child.end
    }
  }
  return cuts
}

/** Seven cuts that fall where no element starts (checked by the tests that use them), spread over the clusters. */
function arbitrary(movie: Movie): number[] {
  const first = must(movie.clusters[0]).start
  const span = movie.bytes.length - first
  return [0.06, 0.17, 0.29, 0.44, 0.57, 0.73, 0.91].map((part) => first + Math.floor(span * part))
}

// The B-frame picture in decode order, in three clusters: the evidence's eight
// frames over the first two (a keyframe begins the first only), then the pattern
// again 267 ms on in the third, which begins with a second keyframe. The AAC sound
// is Xiph-laced, three frames to a block and a block every 64 ms, its blocks among
// the picture's frames, and one of its frames is 300 bytes, so that the size of a
// lace takes a run of 255.
const PICTURE_TIMES = [
  [0, 100, 33, 67],
  [233, 167, 133, 200],
  [267, 367, 300, 334, 500, 434, 400, 467],
]
const SOUND_TIMES = [
  [0, 64],
  [128, 192],
  [256, 320, 384],
]
const CLUSTER_TIMES = [0, 133, 267]

interface Built {
  movie: Movie
  /** The bytes each frame of the picture stores, in decode order. */
  pictureData: Uint8Array[]
  /** The bytes each frame of the sound stores, with the stripped bytes left off, in order. */
  soundData: Uint8Array[]
}

function bFrames(over: Partial<MovieSpec> = {}): Built {
  const pictureData: Uint8Array[] = []
  const soundData: Uint8Array[] = []
  const clusters = PICTURE_TIMES.map((times, which): MovieCluster => {
    const frames: MovieFrame[] = []
    for (const [at, time] of times.entries()) {
      const data = tagged(0x20 + pictureData.length, 6 + 3 * pictureData.length)
      pictureData.push(data)
      frames.push({ track: 1, time, keyframe: at === 0 && which !== 1, data })
      const block = SOUND_TIMES[which]?.[at]
      if (block !== undefined) {
        const laced = [0, 1, 2].map(() => {
          const index = soundData.length
          const frame = tagged(0x40 + index, index === 9 ? 300 : 5 + (index % 4))
          soundData.push(frame)
          return frame
        })
        frames.push({
          track: 2,
          time: block,
          keyframe: true,
          lace: { lacing: 'xiph', frames: laced },
        })
      }
    }
    return { timestamp: must(CLUSTER_TIMES[which]), frames }
  })
  const movie = matroskaMovie({
    duration: 4021,
    scale: 1_000_000,
    tracks: [H264, AAC],
    clusters,
    ...over,
  })
  return { movie, pictureData, soundData }
}

describe('the frames of a span of a file with B-frames and a laced sound (§10.4)', () => {
  const built = bFrames()
  const { movie } = built
  const bytes = movie.bytes
  const index = indexOf(bytes)

  // The dts the remux gives, less the shift of 67: the least presentation time that
  // is not yet taken, delayed by the depth of 2, the first two put back by a frame's
  // length each, as the evidence has them (timing.test.ts).
  const PICTURE_DTS = [0, 34, 67, 100, 134, 167, 200, 234, 267, 300, 334, 367, 401, 434, 467, 501]
  const PICTURE_DURATIONS = [34, 33, 33, 34, 33, 33, 34, 33, 33, 34, 33, 34, 33, 33, 34, 33]
  // The presentation time less the decode time, the shift not in either.
  const PICTURE_CTS = [67, 133, 33, 34, 166, 67, 0, 33, 67, 134, 33, 34, 166, 67, 0, 33]
  // The frames of the sound are timed by their blocks' timecodes, a frame of 1024 samples at 48 kHz (21.33 ms) after the one before, each rounded once.
  const SOUND_DTS = [
    ...[0, 21, 43, 64, 85, 107, 128, 149, 171, 192, 213],
    ...[235, 256, 277, 299, 320, 341, 363, 384, 405, 427],
  ]
  const SOUND_DURATIONS = Array.from({ length: 21 }, (_, at) => [21, 22, 21][at % 3])

  it('has the index shift the decode times by 67 ms and the stripped bytes', () => {
    expect(index.video.read.shift).toBe(67)
    expect(index.video.read.depth).toBe(2)
    expect(index.soundTracks[0]?.prefix).toEqual(AAC_PREFIX)
  })

  it('gives the picture and then the sound, each table as the writer takes it', () => {
    const result = allAtOnce(index, bytes, 2)
    expect(result.frames.map((track) => track.header.id)).toEqual([1, 2])
    expect(result.cursor.ended).toBe(true)
    expect(result.skipped).toEqual([])

    const [pictureTrack, soundTrack] = result.frames.map((track) => must(track))
    const table = must(pictureTrack).table
    expect(table.count).toBe(16)
    expect(table.timescale).toBe(1000)
    expect(Array.from(table.dts)).toEqual(PICTURE_DTS)
    expect(Array.from(table.durations)).toEqual(PICTURE_DURATIONS)
    expect(Array.from(table.cts)).toEqual(PICTURE_CTS)
    expect(Array.from(table.sync)).toEqual(
      PICTURE_DTS.map((_, at) => (at === 0 || at === 8 ? 1 : 0)),
    )
    expect(Array.from(table.sizes)).toEqual(built.pictureData.map((data) => data.length))
    expect(Array.from(table.offsets)).toEqual(built.pictureData.map((data) => locate(bytes, data)))
    expect(must(pictureTrack).prefix).toEqual(new Uint8Array(0))

    const sounds = must(soundTrack).table
    expect(sounds.count).toBe(21)
    expect(sounds.timescale).toBe(1000)
    expect(Array.from(sounds.dts)).toEqual(SOUND_DTS)
    expect(Array.from(sounds.durations)).toEqual(SOUND_DURATIONS)
    expect(Array.from(sounds.cts)).toEqual(SOUND_DTS.map(() => 0))
    expect(Array.from(sounds.sync)).toEqual(SOUND_DTS.map(() => 1))
    // The sizes are the stored ones (the lace's 300-byte first frame among them), and the offsets are where those bytes are.
    expect(Array.from(sounds.sizes)).toEqual(built.soundData.map((data) => data.length))
    expect(Array.from(sounds.offsets)).toEqual(built.soundData.map((data) => locate(bytes, data)))
    expect(must(soundTrack).prefix).toEqual(AAC_PREFIX)
  })

  it('gives only the picture when no sound is chosen', () => {
    const result = allAtOnce(index, bytes, null)
    expect(result.frames.map((track) => track.header.id)).toEqual([1])
    expect(must(result.frames[0]).table.count).toBe(16)
    expect(result.cursor.sound).toBeNull()
    expect(result.cursor.audio).toBeNull()
  })

  it('gives the same frames when the file is cut at every block boundary', () => {
    const whole = allAtOnce(index, bytes, 2)
    const cuts = boundaries(movie)
    const walked = drive(index, bytes, cuts, 2)
    expect(walked.calls).toBeGreaterThan(cuts.length / 2)
    expect(walked.rows).toEqual(whole.rows)
    expect(walked.skipped).toEqual([])
    expect(walked.rows.get(1)).toHaveLength(16)
    expect(walked.rows.get(2)).toHaveLength(21)
  })

  it('gives the same frames when the file is cut at 7 arbitrary bytes', () => {
    const whole = allAtOnce(index, bytes, 2)
    const cuts = arbitrary(movie)
    expect(cuts).toHaveLength(7)
    for (const cut of cuts) expect(boundaries(movie)).not.toContain(cut)
    const walked = drive(index, bytes, cuts, 2)
    expect(walked.calls).toBeGreaterThanOrEqual(8)
    expect(walked.rows).toEqual(whole.rows)
  })

  it('gives the same frames when the file is cut at any one byte', () => {
    const whole = allAtOnce(index, bytes, 2)
    const first = must(movie.clusters[0]).start
    for (let cut = first + 1; cut < bytes.length; cut += 1) {
      expect(drive(index, bytes, [cut], 2).rows).toEqual(whole.rows)
    }
  })

  it('gives the same frames of the picture alone, cut at every 7th byte and 3 bytes on', () => {
    const whole = allAtOnce(index, bytes, null)
    const first = must(movie.clusters[0]).start
    for (let cut = first + 1; cut < bytes.length; cut += 7) {
      expect(drive(index, bytes, [cut, cut + 3], null).rows).toEqual(whole.rows)
    }
  })

  it('holds the last frames of a span in the cursor and gives them with the next span', () => {
    // The first two clusters hold 8 frames of the picture, of which the last waits for the next frame's decode time, and 12 of the sound, of which the last waits likewise.
    const third = must(movie.clusters[2]).start
    const cursor = matroskaStart(index, 2)
    const first = matroskaFrames(index, cursor, { start: 0, bytes: bytes.subarray(0, third) })
    expect(first.cursor.at).toBe(third)
    expect(first.cursor.ended).toBe(false)
    expect(first.cursor.picture.held).toHaveLength(1)
    expect(first.cursor.audio?.held).toHaveLength(1)
    const rows = must(first.frames[0]).table
    expect(Array.from(rows.dts)).toEqual(PICTURE_DTS.slice(0, 7))
    // The held frame's bytes lie before the chunk the next call is given.
    const next = matroskaFrames(index, first.cursor, {
      start: third,
      bytes: bytes.subarray(third),
    })
    const heldOffset = must(first.cursor.picture.held[0]).offset
    expect(heldOffset).toBeLessThan(third)
    expect(must(next.frames[0]).table.offsets[0]).toBe(heldOffset)
    expect(next.cursor.ended).toBe(true)
  })
})

describe('the stripped sound (§10.4)', () => {
  const built = bFrames()
  const { movie } = built
  const bytes = movie.bytes
  const index = indexOf(bytes)

  it('has the stored sizes and the stripped bytes as its prefix, and the writer puts them back', () => {
    const track = must(allAtOnce(index, bytes, 2).frames[1])
    expect(track.header.id).toBe(2)
    expect(track.prefix).toEqual(AAC_PREFIX)
    expect(Array.from(track.table.sizes)).toEqual(built.soundData.map((data) => data.length))

    const stored = built.soundData.reduce((sum, data) => sum + data.length, 0)
    const { payload } = fragmentHead(track, 0, track.table.count, 1)
    expect(payload).toBe(stored + AAC_PREFIX.length * built.soundData.length)

    const out = fragment(track, 0, track.table.count, 1, (offset, size) =>
      bytes.subarray(offset, offset + size),
    )
    const expected = new Uint8Array(payload)
    let at = 0
    for (const data of built.soundData) {
      expected.set(AAC_PREFIX, at)
      expected.set(data, at + AAC_PREFIX.length)
      at += AAC_PREFIX.length + data.length
    }
    expect(out.subarray(out.length - payload)).toEqual(expected)
  })
})

describe('a cursor that has not started the picture (§10.4)', () => {
  // Three clusters: the keyframe that the index is made from, then a cluster whose
  // first frames of the picture lean on frames before it (a keyframe comes later in
  // it), then a cluster that has no keyframe at all.
  const frames = {
    key0: picture(0, 0x20, { keyframe: true }),
    sound0: sound(0, 0x40),
    next33: picture(33, 0x21),
    lead100: picture(100, 0x22),
    sound100: sound(100, 0x41),
    lead133: picture(133, 0x23),
    sound120: sound(120, 0x42),
    key167: picture(167, 0x24, { keyframe: true }),
    sound140: sound(140, 0x43),
    next200: picture(200, 0x25),
    next233: picture(233, 0x26),
    open300: picture(300, 0x27),
    sound300: sound(300, 0x44),
    open333: picture(333, 0x28),
  }
  const movie = vp9Opus([
    { timestamp: 0, frames: [frames.key0, frames.sound0, frames.next33] },
    {
      timestamp: 100,
      frames: [
        frames.lead100,
        frames.sound100,
        frames.lead133,
        frames.sound120,
        frames.key167,
        frames.sound140,
        frames.next200,
        frames.next233,
      ],
    },
    { timestamp: 300, frames: [frames.open300, frames.sound300, frames.open333] },
  ])
  const index = indexOf(movie.bytes)
  const at = (data: Uint8Array | undefined): number => locate(movie.bytes, must(data))

  it('starts the picture at its keyframe and keeps the sound from where it is', () => {
    const cursor: MatroskaCursor = {
      ...matroskaStart(index, 2),
      at: must(movie.clusters[1]).start,
    }
    expect(cursor.pictureStarted).toBe(false)
    const result = matroskaFrames(index, cursor, { start: 0, bytes: movie.bytes })

    const pictures = must(result.frames[0])
    expect(pictures.header.id).toBe(1)
    const rows = rowsOf(pictures.table)
    // The frames before the keyframe (100 and 133) are left out; those after it go on into the cluster that follows, which has no keyframe and needs none.
    expect(rows.map((row) => row.offset)).toEqual(
      [frames.key167, frames.next200, frames.next233, frames.open300, frames.open333].map((one) =>
        at(one.data),
      ),
    )
    expect(rows.map((row) => row.dts)).toEqual([167, 200, 233, 300, 333])
    expect(rows.map((row) => row.duration)).toEqual([33, 33, 67, 33, 33])
    expect(rows.map((row) => row.sync)).toEqual([1, 0, 0, 0, 0])

    const sounds = rowsOf(must(result.frames[1]).table)
    expect(sounds.map((row) => row.dts)).toEqual([100, 120, 140, 300])
    expect(sounds.map((row) => row.duration)).toEqual([20, 20, 160, 20])
    expect(result.cursor.pictureStarted).toBe(true)
  })

  it('leaves the picture out while its cluster has no keyframe, and goes on waiting', () => {
    const cursor: MatroskaCursor = {
      ...matroskaStart(index, 2),
      at: must(movie.clusters[2]).start,
    }
    const result = matroskaFrames(index, cursor, { start: 0, bytes: movie.bytes })
    expect(result.frames.map((track) => track.header.id)).toEqual([2])
    expect(rowsOf(must(result.frames[0]).table).map((row) => row.dts)).toEqual([300])
    expect(result.cursor.pictureStarted).toBe(false)
    expect(result.cursor.picture).toEqual(cursor.picture)
    expect(result.cursor.ended).toBe(true)
  })

  it('starts at the first keyframe of the file when it starts there', () => {
    // The file's start is the same: frames before the first keyframe are dropped, as the index counted from it.
    const lead = vp9Opus([
      {
        timestamp: 0,
        frames: [
          picture(0, 0x30),
          sound(0, 0x50),
          picture(33, 0x31),
          picture(67, 0x32, { keyframe: true }),
          picture(100, 0x33),
        ],
      },
    ])
    const result = allAtOnce(indexOf(lead.bytes), lead.bytes, 2)
    expect(rowsOf(must(result.frames[0]).table).map((row) => row.dts)).toEqual([67, 100])
    expect(rowsOf(must(result.frames[1]).table).map((row) => row.dts)).toEqual([0])
  })
})

describe('the last frame of the file (§10.4)', () => {
  /** A file of the picture alone, with frames at 0, 40 and 80 ms, the last of them with this duration if it is given. */
  function ends(track: TrackSpec, last: Partial<MovieFrame> = {}): number[] {
    const movie = matroskaMovie({
      duration: 4021,
      scale: 1_000_000,
      tracks: [track],
      clusters: [
        {
          timestamp: 0,
          frames: [
            picture(0, 0x20, { keyframe: true }),
            picture(40, 0x21),
            picture(80, 0x22, last),
          ],
        },
      ],
    })
    const result = allAtOnce(indexOf(movie.bytes), movie.bytes, null)
    return rowsOf(must(result.frames[0]).table).map((row) => row.duration)
  }

  it("lasts the BlockDuration when the frame has one, whatever the track's DefaultDuration is", () => {
    expect(ends(VP9, { duration: 25 })).toEqual([40, 40, 25])
  })

  it("lasts the track's DefaultDuration, rounded, when the frame has no BlockDuration", () => {
    expect(ends(VP9)).toEqual([40, 40, 33])
  })

  it("lasts a frame's length by the first frames of the file when there is neither", () => {
    expect(ends(VP9_BARE)).toEqual([40, 40, 40])
  })

  it('gives every frame held at the end of the Segment, the sound as well', () => {
    const movie = vp9Opus([
      {
        timestamp: 0,
        frames: [picture(0, 0x20, { keyframe: true }), sound(0, 0x40), picture(40, 0x21)],
      },
    ])
    const result = allAtOnce(indexOf(movie.bytes), movie.bytes, 2)
    expect(rowsOf(must(result.frames[0]).table)).toHaveLength(2)
    expect(rowsOf(must(result.frames[1]).table).map((row) => row.duration)).toEqual([20])
    expect(result.cursor.picture.held).toEqual([])
    expect(result.cursor.audio?.held).toEqual([])
  })
})

describe('clusters of unknown size (§10.4)', () => {
  const clusters = (unknown: boolean): MovieCluster[] => [
    {
      timestamp: 0,
      unknown,
      frames: [
        picture(0, 0x20, { keyframe: true }),
        sound(0, 0x40),
        picture(33, 0x21),
        sound(20, 0x41),
      ],
    },
    {
      timestamp: 100,
      unknown,
      frames: [
        picture(100, 0x22, { keyframe: true }),
        sound(100, 0x42),
        picture(133, 0x23),
        sound(120, 0x43),
      ],
    },
    {
      timestamp: 200,
      unknown,
      frames: [picture(200, 0x24, { keyframe: true }), sound(200, 0x44), picture(233, 0x25)],
    },
  ]
  const movie = vp9Opus(clusters(true))
  const index = indexOf(movie.bytes)

  it('gives the same frames across chunks as in one, cut at every block boundary', () => {
    // Every cluster is written with the size of 8 bytes that says it is not known: 0x01 and then seven bytes of 1 bits, after the 4 of its ID.
    for (const range of movie.clusters) {
      expect(Array.from(movie.bytes.subarray(range.start + 4, range.start + 12))).toEqual([
        0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ])
    }
    const whole = allAtOnce(index, movie.bytes, 2)
    expect(whole.rows.get(1)).toHaveLength(6)
    expect(whole.rows.get(2)).toHaveLength(5)
    expect(drive(index, movie.bytes, boundaries(movie), 2).rows).toEqual(whole.rows)
  })

  it('gives the same frames cut at any one byte', () => {
    const whole = allAtOnce(index, movie.bytes, 2)
    const first = must(movie.clusters[0]).start
    for (let cut = first + 1; cut < movie.bytes.length; cut += 1) {
      expect(drive(index, movie.bytes, [cut], 2).rows).toEqual(whole.rows)
    }
  })

  it('gives the times that the same file with clusters of their size gives', () => {
    const sized = vp9Opus(clusters(false))
    const times = (rows: Map<number, Row[]>): unknown[] =>
      [1, 2].map((track) =>
        (rows.get(track) ?? []).map((row) => [row.dts, row.cts, row.duration, row.sync]),
      )
    expect(times(allAtOnce(index, movie.bytes, 2).rows)).toEqual(
      times(allAtOnce(indexOf(sized.bytes), sized.bytes, 2).rows),
    )
  })
})

describe('damage in the middle of a file (§10.4)', () => {
  const frames = {
    key0: picture(0, 0x20, { keyframe: true }),
    sound0: sound(0, 0x40),
    next33: picture(33, 0x21),
    sound20: sound(20, 0x41),
    next67: picture(67, 0x22),
    key100: picture(100, 0x23, { keyframe: true }),
    sound100: sound(100, 0x42),
    broken: sound(120, 0x43),
    lost133: picture(133, 0x24),
    lost140: sound(140, 0x44),
    lead200: picture(200, 0x25),
    sound200: sound(200, 0x45),
    key233: picture(233, 0x26, { keyframe: true }),
    sound220: sound(220, 0x46),
    next267: picture(267, 0x27),
  }
  const movie = vp9Opus([
    {
      timestamp: 0,
      frames: [frames.key0, frames.sound0, frames.next33, frames.sound20, frames.next67],
    },
    {
      timestamp: 100,
      frames: [frames.key100, frames.sound100, frames.broken, frames.lost133, frames.lost140],
    },
    {
      timestamp: 200,
      frames: [frames.lead200, frames.sound200, frames.key233, frames.sound220, frames.next267],
    },
  ])
  const index = indexOf(movie.bytes)

  // The track number of the block in the middle of the second cluster is zeroed, which no block has.
  const bytes = Uint8Array.from(movie.bytes)
  const brokenAt = blockStart(movie.bytes, must(frames.broken.data))
  bytes[brokenAt + 2] = 0
  const damage: ByteRange = { start: brokenAt, end: must(movie.clusters[2]).start }

  it('reports what it skipped, goes on with the next cluster, and waits for a keyframe', () => {
    const result = matroskaFrames(index, matroskaStart(index, 2), { start: 0, bytes })
    expect(result.skipped).toEqual([damage])
    expect(result.cursor.ended).toBe(true)
    expect(result.cursor.searching).toBe(false)

    // The frame held when the damage came (at 100) is lost with the picture's state, and the frame at 200 comes before the next keyframe.
    const pictures = rowsOf(must(result.frames[0]).table)
    expect(pictures.map((row) => row.dts)).toEqual([0, 33, 67, 233, 267])
    expect(pictures.map((row) => row.duration)).toEqual([33, 34, 33, 34, 33])
    expect(pictures.map((row) => row.sync)).toEqual([1, 0, 0, 1, 0])
    expect(pictures.map((row) => row.offset)).toEqual(
      [frames.key0, frames.next33, frames.next67, frames.key233, frames.next267].map((one) =>
        locate(movie.bytes, must(one.data)),
      ),
    )
    expect(result.cursor.pictureStarted).toBe(true)

    // The sound goes on across the skip, its frame before it lasting to the one after.
    const sounds = rowsOf(must(result.frames[1]).table)
    expect(sounds.map((row) => row.dts)).toEqual([0, 20, 100, 200, 220])
    expect(sounds.map((row) => row.duration)).toEqual([20, 80, 100, 20, 20])
  })

  it('is told of it once the walk is over, cut at every byte, with the same frames', () => {
    const whole = matroskaFrames(index, matroskaStart(index, 2), { start: 0, bytes })
    const wholeRows = new Map<number, Row[]>()
    collect(wholeRows, whole.frames)
    for (let cut = must(movie.clusters[0]).start + 1; cut < bytes.length; cut += 1) {
      const walked = drive(index, bytes, [cut], 2)
      expect(walked.rows).toEqual(wholeRows)
      expect(merged(walked.skipped)).toEqual([damage])
    }
  })

  it('waits for a keyframe again at each skip of a call', () => {
    // Two damaged blocks, in the first and in the third cluster.
    const twice = Uint8Array.from(bytes)
    const other = blockStart(movie.bytes, must(frames.sound220.data))
    twice[other + 2] = 0
    const result = matroskaFrames(index, matroskaStart(index, 2), { start: 0, bytes: twice })
    // The second damage skips to the end of the Segment: the cluster's remaining frames (the one after 220) go with it.
    expect(merged(result.skipped)).toEqual([damage, { start: other, end: twice.length }])
    // The keyframe at 233 was read before the second skip, and is held with the picture's state, which the skip drops: the picture waits for a keyframe again, and there is none.
    const pictures = rowsOf(must(result.frames[0]).table)
    expect(pictures.map((row) => row.dts)).toEqual([0, 33, 67])
    expect(result.cursor.pictureStarted).toBe(false)
    expect(result.cursor.ended).toBe(true)
  })
})

describe('the cursor (§10.4)', () => {
  const built = bFrames()
  const bytes = built.movie.bytes
  const index = indexOf(bytes)
  const first = must(built.movie.clusters[0]).start

  it('starts at the first Cluster with fresh decode states at the index depth and frame lengths', () => {
    const cursor = matroskaStart(index, 2)
    expect(cursor).toEqual({
      container: 'matroska',
      at: first,
      cluster: null,
      searching: false,
      ended: false,
      sound: 2,
      picture: startDecode(2, 33.333333),
      audio: startDecode(0, 21),
      pictureStarted: false,
    })
    const alone = matroskaStart(index, null)
    expect(alone.sound).toBeNull()
    expect(alone.audio).toBeNull()
  })

  it('refuses a sound that is not one of the index as a RangeError', () => {
    expect(() => matroskaStart(index, 1)).toThrow(RangeError)
    expect(() => matroskaStart(index, 99)).toThrow(RangeError)
    const cursor = { ...matroskaStart(index, 2), sound: 99 }
    expect(() => matroskaFrames(index, cursor, { start: 0, bytes })).toThrow(RangeError)
    const torn = { ...matroskaStart(index, 2), audio: null }
    expect(() => matroskaFrames(index, torn, { start: 0, bytes })).toThrow(RangeError)
  })

  it('refuses a chunk that does not hold the cursor as a RangeError', () => {
    const cursor = matroskaStart(index, 2)
    expect(() => matroskaFrames(index, cursor, { start: first + 1, bytes })).toThrow(RangeError)
    expect(() =>
      matroskaFrames(index, cursor, { start: 0, bytes: bytes.subarray(0, first - 1) }),
    ).toThrow(RangeError)
    // The chunk's end is in it, though nothing can be read from there.
    const empty = matroskaFrames(index, cursor, { start: 0, bytes: bytes.subarray(0, first) })
    expect(empty.frames).toEqual([])
    expect(empty.cursor.at).toBe(first)
  })

  it('does not move when the chunk ends before the next element is whole, and gives back what it was given', () => {
    const cursor = matroskaStart(index, 2)
    for (const length of [1, 3, 5]) {
      const result = matroskaFrames(index, cursor, {
        start: first,
        bytes: bytes.subarray(first, first + length),
      })
      expect(result.frames).toEqual([])
      expect(result.skipped).toEqual([])
      expect(result.cursor).toEqual(cursor)
      expect(result.cursor).not.toBe(cursor)
    }
  })

  it('never changes the cursor it is given', () => {
    const cursor = matroskaStart(index, 2)
    const cut = first + Math.floor((bytes.length - first) / 2)
    const result = matroskaFrames(index, cursor, {
      start: first,
      bytes: bytes.subarray(first, cut),
    })
    expect(result.cursor.at).toBeGreaterThan(first)
    expect(cursor).toEqual(matroskaStart(index, 2))

    const before = structuredClone(result.cursor)
    matroskaFrames(index, result.cursor, {
      start: result.cursor.at,
      bytes: bytes.subarray(result.cursor.at),
    })
    expect(result.cursor).toEqual(before)
  })
})

describe('what the writer cannot hold (§10.4)', () => {
  it('refuses a decode time before 0 after the shift, as a span the index shifted too little for', () => {
    const { movie } = bFrames()
    const index = indexOf(movie.bytes)
    const unshifted: MatroskaIndex = {
      ...index,
      video: { ...index.video, read: { ...index.video.read, shift: 0 } },
    }
    const error = refused('damaged', () =>
      matroskaFrames(unshifted, matroskaStart(unshifted, null), { start: 0, bytes: movie.bytes }),
    )
    expect(error.message).toContain('before 0')
    expect(error.message).toContain('shift')
  })

  it('counts a file whose TimestampScale does not divide a second in nanoseconds', () => {
    const movie = matroskaMovie({
      duration: 4021,
      scale: 1_000_001,
      tracks: [VP9_BARE],
      clusters: [
        {
          timestamp: 0,
          frames: [
            picture(0, 0x20, { keyframe: true }),
            picture(40, 0x21),
            picture(80, 0x22, { duration: 33 }),
          ],
        },
      ],
    })
    const index = indexOf(movie.bytes)
    const track = must(allAtOnce(index, movie.bytes, null).frames[0])
    expect(track.table.timescale).toBe(1e9)
    expect(Array.from(track.table.dts)).toEqual([0, 40_000_040, 80_000_080])
    expect(Array.from(track.table.durations)).toEqual([40_000_040, 40_000_040, 33_000_033])
    expect(Array.from(track.table.cts)).toEqual([0, 0, 0])
  })

  it('refuses a duration that a 32-bit field cannot hold', () => {
    // 5000 ticks of 1.000001 ms between two frames of a sound, in nanoseconds: 5.000005e9, past 2^32 - 1.
    const movie = vp9Opus(
      [
        {
          timestamp: 0,
          frames: [
            picture(0, 0x20, { keyframe: true }),
            sound(0, 0x40),
            sound(5000, 0x41),
            picture(40, 0x21),
          ],
        },
      ],
      { scale: 1_000_001 },
    )
    const index = indexOf(movie.bytes)
    const error = refused('damaged', () =>
      matroskaFrames(index, matroskaStart(index, 2), { start: 0, bytes: movie.bytes }),
    )
    expect(error.message).toContain('duration')
  })

  it('refuses a composition offset that a signed 32-bit field cannot hold', () => {
    // A frame presented 3000 ticks of 1.000001 ms after the frame it is decoded behind: 3.03e9 ns.
    const movie = matroskaMovie({
      duration: 4021,
      scale: 1_000_001,
      tracks: [H264],
      clusters: [
        {
          timestamp: 0,
          frames: [
            { track: 1, time: 0, keyframe: true, data: tagged(0x20) },
            { track: 1, time: 3000, data: tagged(0x21) },
            { track: 1, time: 1000, data: tagged(0x22) },
          ],
        },
      ],
    })
    const index = indexOf(movie.bytes)
    const error = refused('damaged', () =>
      matroskaFrames(index, matroskaStart(index, null), { start: 0, bytes: movie.bytes }),
    )
    expect(error.message).toContain('composition offset')
  })
})
