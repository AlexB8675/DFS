import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import { heldBytes } from '../source.ts'
import type { ByteRange, Chunk } from '../source.ts'
import { concat } from '../testing/build.ts'
import {
  cluster,
  cues,
  element,
  elementSized,
  info,
  matroskaFile,
  matroskaMovie,
  seekHead,
  simpleBlock,
  sizeBytes,
  trackEntry,
  tracksElement,
  uint,
} from '../testing/ebml.ts'
import type {
  CueSpec,
  FilePart,
  MatroskaFile,
  Movie,
  MovieCluster,
  MovieFrame,
  MovieSpec,
  TrackSpec,
} from '../testing/ebml.ts'
import { virtualFile } from '../testing/virtual.ts'
import type { VirtualFile } from '../testing/virtual.ts'
import { children, readHeader } from './ebml.ts'
import { ID } from './ids.ts'
import {
  CUES_LIMIT,
  FIRST_FRAMES_BYTES,
  HEADER_READ,
  MAX_CUE_FIELDS,
  MAX_CUE_POINTS,
  MAX_SEEK_READS,
  SEARCH_READ,
  TAIL_BYTES,
} from './limits.ts'
import { readMatroska } from './read.ts'
import type { MatroskaIndex } from './read.ts'
import { matroskaSeek, readCues } from './seek.ts'
import { matroskaFrames, matroskaStart } from './spans.ts'
import type { MatroskaCursor } from './spans.ts'

// Seeking in a Matroska file (DESIGN.md §10.4, D45): given a time, where to start
// reading, by the file's Cues when it has them and by a bounded search of its
// clusters when it has none. Every file is built in code, and every expectation is
// written from the rules (the cluster a time is in, the keyframe it starts at), not
// computed by the module. A seek is driven the way a caller drives it, by `seek`,
// which answers each ask from the whole built file and holds it to the rules on the
// way: it lies inside the Segment, it is never a range the caller holds, and a seek
// that goes on asking is stopped. A landing is checked by playing from it: the first
// frame the picture gives out must be a keyframe, presented at or before the time.

/** The most turns a driven seek is let make: far above the cap on reads. */
const TURNS = 120

/** What is there, which a test knows to be. */
function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('expected a value')
  return value
}

/** A file with no chunk missing from it: the index is made from all of it. */
function indexOf(bytes: Uint8Array): MatroskaIndex {
  const step = readMatroska([{ start: 0, bytes }], bytes.length)
  if (!('done' in step)) throw new Error('the index asked for more than the whole file')
  return step.done
}

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

/** The `avcC` record of x264 for generated 320x240 pictures with B-frames (2026-10-25): `has_b_frames` 2, level 1.3. */
const X264_B_FRAMES =
  '0164000dffe100196764000dacd94141fb0110000003001000000303c0f142996001000668ebe3cb22c0fdf8f800'

/** The uncompressed header of a profile 0 VP9 keyframe: frame marker, profile 0, a keyframe, the sync code, 8 bits and color_space 0 with a limited range. */
const VP9_KEYFRAME = [0x82, 0x49, 0x83, 0x42, 0x00]

/** A VP9 keyframe of 8 bytes: the header, then a tag in the last. */
function vp9Key(tag: number): Uint8Array {
  const out = new Uint8Array(8)
  out.set(VP9_KEYFRAME)
  out[7] = tag
  return out
}

/** A frame of 8 bytes that no keyframe is. */
function tagged(tag: number): Uint8Array {
  return new Uint8Array(8).fill(0x11).fill(tag, 0, 1)
}

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

const VP9: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_VP9',
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

const H264: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_MPEG4/ISO/AVC',
  codecPrivate: fromHex(X264_B_FRAMES),
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

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

/** What a driven seek gives: the cursor, and the ranges it asked for in order. */
interface Sought {
  cursor: MatroskaCursor
  asks: ByteRange[]
}

/**
 * Seeks the way a caller does: the chunks it is given to start with (none unless
 * `held` says), then each range the seek asks for, from the whole file. Every ask is
 * held to the rules on the way; `asks` is filled even when the seek throws.
 */
function seek(
  index: MatroskaIndex,
  bytes: Uint8Array,
  seconds: number,
  { sound = null, held = [] }: { sound?: number | null; held?: Chunk[] } = {},
): Sought {
  const chunks = [...held]
  const asks: ByteRange[] = []
  for (let turn = 0; turn < TURNS; turn += 1) {
    const step = matroskaSeek(index, seconds, sound, chunks)
    if ('done' in step) return { cursor: step.done, asks }
    const { start, end } = step.need
    expect(Number.isSafeInteger(start) && start >= index.segment.data && start < end).toBe(true)
    expect(end).toBeLessThanOrEqual(index.segment.end)
    expect(heldBytes(chunks, start, end)).toBeNull()
    asks.push(step.need)
    chunks.push({ start, bytes: bytes.subarray(start, end) })
  }
  throw new Error('the seek went on asking')
}

/** The whole file as the one chunk that a caller who has read it all holds. */
function everything(bytes: Uint8Array): Chunk[] {
  return [{ start: 0, bytes }]
}

/**
 * Where the picture's first timed frame from the cursor is presented, on the
 * playback timeline (the table's time with the track's `timestampOffset` added),
 * whether it is a sync sample, and where its bytes are. The file is given from the
 * cursor to its end, so the frames are all given out.
 */
function firstShown(
  index: MatroskaIndex,
  bytes: Uint8Array,
  cursor: MatroskaCursor,
): { seconds: number; sync: boolean; offset: number } {
  const chunk = { start: cursor.at, bytes: bytes.subarray(cursor.at) }
  const { frames } = matroskaFrames(index, cursor, chunk)
  const { table } = must(frames.find((one) => one.header.id === index.video.header.id))
  return {
    seconds:
      (must(table.dts[0]) + must(table.cts[0])) / table.timescale +
      index.video.timing.offsetSeconds,
    sync: table.sync[0] === 1,
    offset: must(table.offsets[0]),
  }
}

/** The seek lands at or before `seconds`: playing from the cursor starts at a keyframe presented no later. Gives when. */
function landsBefore(
  index: MatroskaIndex,
  bytes: Uint8Array,
  cursor: MatroskaCursor,
  seconds: number,
): number {
  const shown = firstShown(index, bytes, cursor)
  expect(shown.sync).toBe(true)
  expect(shown.seconds).toBeLessThanOrEqual(seconds + 1e-9)
  return shown.seconds
}

/** Which of the clusters (ranges that end where the next part starts) the offset is in. */
function inCluster(clusters: ByteRange[], at: number): number {
  return clusters.findIndex((range) => range.start <= at && at < range.end)
}

/** Where the nth frame's block of a cluster is, counted from the cluster's data, as a CueRelativePosition counts. */
function blockAt(movie: Movie, which: number, nth: number): number {
  const range = must(movie.clusters[which])
  const header = must(readHeader(movie.bytes, range.start, range.end))
  return must(children(movie.bytes, header)[1 + nth]).start - header.data
}

/** Where a cluster's data starts. */
function dataOf(movie: Movie, which: number): number {
  const range = must(movie.clusters[which])
  return must(readHeader(movie.bytes, range.start, range.end)).data
}

/** Where the data of the element whose header is at `at` starts. */
function dataAt(bytes: Uint8Array, at: number): number {
  return must(readHeader(bytes, at, bytes.length)).data
}

/** The ranges of the clusters of a hand-built file: each ends where the next starts, the last where its Cues or the file ends. */
function rangesOf(built: Assembled): ByteRange[] {
  return built.clusters.map((start, k) => ({
    start,
    end: built.clusters[k + 1] ?? built.cues ?? built.file.bytes.length,
  }))
}

/** What `run` throws, which must be an `Mp4Error` of the reason `damaged`. */
function damagedBy(run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe('damaged')
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error')
}

/** A frame of the picture: a keyframe at the time, or not. */
function pictureFrame(time: number, tag: number, keyframe: boolean): MovieFrame {
  return keyframe
    ? { track: 1, time, keyframe: true, data: vp9Key(tag) }
    : { track: 1, time, data: tagged(tag) }
}

/**
 * Clusters of one second each: cluster k starts at k seconds with a frame that is a
 * keyframe in every `keyEvery`th cluster (the first always), and holds one more
 * frame, of `pad` bytes, half a second on, so that a cluster is as long as a test
 * needs. A keyframe is of `key` bytes when that is more than the 8 that a keyframe
 * of the tests is.
 */
function seconds(
  count: number,
  {
    keyEvery = 1,
    pad = 8,
    key = 8,
    unknown = false,
  }: { keyEvery?: number; pad?: number; key?: number; unknown?: boolean } = {},
): MovieCluster[] {
  return Array.from({ length: count }, (_, k) => {
    const first = pictureFrame(1000 * k, k & 0xff, k % keyEvery === 0)
    return {
      timestamp: 1000 * k,
      unknown,
      frames: [
        first.keyframe === true && key > 8 ? bigKey(1000 * k, key) : first,
        { track: 1, time: 1000 * k + 500, size: pad },
      ],
    }
  })
}

/** A keyframe of the picture of `size` bytes, presented at `time` ticks: the header of one, then zeros. */
function bigKey(time: number, size: number): MovieFrame {
  return { track: 1, time, keyframe: true, data: concat(VP9_KEYFRAME, new Uint8Array(size - 5)) }
}

function movieOf(clusters: MovieCluster[], over: Partial<MovieSpec> = {}): Movie {
  return matroskaMovie({
    duration: 1000 * clusters.length,
    scale: 1_000_000,
    tracks: [VP9],
    clusters,
    ...over,
  })
}

/**
 * The movie with a SeekHead and Cues that name the clusters listed, each at its
 * Timestamp, and the block that is the nth frame of the cluster.
 */
function cued(
  clusters: MovieCluster[],
  listed: number[],
  over: Partial<MovieSpec> = {},
  nth = 0,
): Movie {
  const plain = movieOf(clusters)
  return movieOf(clusters, {
    seek: true,
    cuePoints: (at) =>
      listed.map((k) => ({
        time: must(clusters[k]).timestamp,
        cluster: must(at[k]),
        relative: blockAt(plain, k, nth),
      })),
    ...over,
  })
}

/** The first `count` numbers, from 0. */
function upTo(count: number): number[] {
  return Array.from({ length: count }, (_, k) => k)
}

/** A cluster of one second, written by hand: a keyframe, then a frame of `pad` bytes. */
function rawCluster(k: number, pad: number, first: Uint8Array = vp9Key(k & 0xff)): Uint8Array {
  return cluster(1000 * k, [
    simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [first] }),
    simpleBlock({ track: 1, timecode: 500, frames: [new Uint8Array(pad)] }),
  ])
}

/** Where the block that follows a rawCluster's Timestamp is, counted from its data. */
function stampLength(k: number): number {
  return uint(ID.Timestamp, 1000 * k).length
}

/** A file laid out by hand: where the Cues go, and what the SeekHead says of them. */
interface Layout {
  /** Cues before the first cluster, from the position of each cluster (counted from the Segment's data). */
  front?: (clusters: number[]) => Uint8Array
  /** Cues after the last cluster. */
  back?: (clusters: number[]) => Uint8Array
  /** A SeekHead that names the Cues where they are (`front`, `back`), or at the fourth cluster's header (`stale`), or that names the Info and the Tracks and not the Cues (`without`); none when left out. */
  seek?: 'front' | 'back' | 'stale' | 'without'
}

/** A hand-built file: its bytes, the offset of each cluster, and where its Cues are. */
interface Assembled {
  file: MatroskaFile
  clusters: number[]
  cues: number | null
}

function assemble(blocks: Uint8Array[], layout: Layout = {}): Assembled {
  const parts: FilePart[] = []
  const seekAt = layout.seek === undefined ? null : parts.length
  if (seekAt !== null) parts.push(new Uint8Array(0))
  const infoAt = parts.length
  parts.push(info({ scale: 1_000_000, duration: 1000 * blocks.length }))
  const tracksAt = parts.length
  parts.push(tracksElement([trackEntry(VP9)]))
  const frontAt = layout.front === undefined ? null : parts.length
  if (frontAt !== null) parts.push(new Uint8Array(0))
  const clustersAt = parts.length
  parts.push(...blocks)
  const backAt = layout.back === undefined ? null : parts.length
  if (backAt !== null) parts.push(new Uint8Array(0))

  const where = (at: number[]): number[] => blocks.map((_, k) => at[clustersAt + k] ?? 0)
  const { front, back } = layout
  if (frontAt !== null && front !== undefined) parts[frontAt] = (at) => front(where(at))
  if (backAt !== null && back !== undefined) parts[backAt] = (at) => back(where(at))
  if (seekAt !== null) {
    const named = layout.seek === 'front' ? frontAt : backAt
    parts[seekAt] = (at) =>
      seekHead([
        [ID.Info, at[infoAt] ?? 0],
        [ID.Tracks, at[tracksAt] ?? 0],
        ...(layout.seek === 'without'
          ? []
          : [
              [
                ID.Cues,
                layout.seek === 'stale' ? (at[clustersAt + 3] ?? 0) : (at[named ?? 0] ?? 0),
              ] as [number, number],
            ]),
      ])
  }
  const file = matroskaFile(parts)
  const cuesAt = frontAt ?? backAt
  return {
    file,
    clusters: blocks.map((_, k) => file.offsets[clustersAt + k] ?? 0),
    cues: cuesAt === null ? null : (file.offsets[cuesAt] ?? 0),
  }
}

/** Cues for every cluster of a hand-built file, at the block that follows the Timestamp. */
function cuesOfAll(count: number): (starts: number[]) => Uint8Array {
  return (starts) =>
    cues(
      upTo(count).map((k) => ({
        time: 1000 * k,
        cluster: must(starts[k]),
        relative: stampLength(k),
      })),
      { positionWidth: 8 },
    )
}

describe('reading the Cues (§10.4)', () => {
  /** A Cues element as `readCues` takes it, with a Segment whose data starts at 100. */
  function parse(
    points: CueSpec[],
    { crc = false, track = 1, end }: { crc?: boolean; track?: number; end?: number } = {},
  ): ReturnType<typeof readCues> {
    const bytes = cues(points, { crc })
    return readCues(bytes, must(readHeader(bytes, 0, bytes.length)), 5000, 100, track, end)
  }

  it('gives the time, the absolute position of the cluster and the position of the block of each point, with a CRC-32 in the way', () => {
    const points = [
      { time: 0, cluster: 0, relative: 4 },
      { time: 5000, cluster: 1200, relative: 25 },
      { time: 9000, cluster: 2400 },
    ]
    for (const crc of [false, true]) {
      expect(parse(points, { crc })).toEqual([
        { time: 0, cluster: 100, relative: 4 },
        { time: 5000, cluster: 1300, relative: 25 },
        { time: 9000, cluster: 2500, relative: null },
      ])
    }
  })

  it('leaves out the points of other tracks, and puts the rest in order of time, those of one time as they came', () => {
    const points: CueSpec[] = [
      { time: 9000, cluster: 90 },
      { time: 3000, cluster: 30, track: 2 },
      { time: 5000, cluster: 50 },
      { time: 5000, cluster: 51 },
      { time: 0, cluster: 0 },
    ]
    expect(parse(points)).toEqual([
      { time: 0, cluster: 100, relative: null },
      { time: 5000, cluster: 150, relative: null },
      { time: 5000, cluster: 151, relative: null },
      { time: 9000, cluster: 190, relative: null },
    ])
    expect(parse(points, { track: 2 })).toEqual([{ time: 3000, cluster: 130, relative: null }])
    expect(parse(points, { track: 3 })).toEqual([])
  })

  it("leaves out a position at or past the Segment's end", () => {
    const points = [
      { time: 0, cluster: 0 },
      { time: 1, cluster: 899 },
      { time: 2, cluster: 900 },
      { time: 3, cluster: 5000 },
    ]
    // The Segment's data starts at 100, so a cluster at 900 is at 1000.
    expect(parse(points, { end: 1000 }).map((one) => one.time)).toEqual([0, 1])
  })

  it('leaves out a CuePoint with no time or no position for the track, and takes the track from among several CueTrackPositions', () => {
    const positions = (track: number, at?: number): Uint8Array =>
      element(
        ID.CueTrackPositions,
        uint(ID.CueTrack, track),
        ...(at === undefined ? [] : [uint(ID.CueClusterPosition, at)]),
      )
    const bytes = element(
      ID.Cues,
      element(ID.CuePoint, positions(1, 10)),
      element(ID.CuePoint, uint(ID.CueTime, 20), positions(1)),
      element(ID.CuePoint, uint(ID.CueTime, 30), positions(2, 11), positions(1, 12)),
      element(ID.CuePoint, uint(ID.CueTime, 40), positions(2, 13)),
    )
    const found = readCues(bytes, must(readHeader(bytes, 0, bytes.length)), 0, 0, 1)
    expect(found).toEqual([{ time: 30, cluster: 12, relative: null }])
  })

  it('refuses children that do not walk, as a damaged file', () => {
    // A CuePoint that claims more than the Cues have left.
    const cut = element(ID.Cues, elementSized(ID.CuePoint, sizeBytes(50), uint(ID.CueTime, 1)))
    damagedBy(() => readCues(cut, must(readHeader(cut, 0, cut.length)), 0, 0, 1))
    // A CueTime wider than any integer is.
    const wide = element(
      ID.Cues,
      element(ID.CuePoint, element(ID.CueTime, new Uint8Array(9)), element(ID.CueTrackPositions)),
    )
    damagedBy(() => readCues(wide, must(readHeader(wide, 0, wide.length)), 0, 0, 1))
  })

  it("reads the Cues of a built movie to the position of each cluster's header", () => {
    const movie = cued(seconds(4), upTo(4))
    const start = must(movie.cues)
    const bytes = movie.bytes.subarray(start)
    const found = readCues(
      bytes,
      must(readHeader(bytes, 0, bytes.length)),
      start,
      movie.segmentData,
      1,
    )
    expect(found.map((one) => one.cluster)).toEqual(movie.clusters.map((range) => range.start))
    expect(found.map((one) => one.time)).toEqual([0, 1000, 2000, 3000])
  })
})

describe('seeking by the Cues (§10.4)', () => {
  const clusters = seconds(10)
  const movie = cued(clusters, upTo(10))
  const index = indexOf(movie.bytes)

  it('goes to the cluster of the last point at or before the time, at the block that point names, asking for the Cues and that cluster only', () => {
    expect(index.cues).toEqual({ start: movie.cues, end: null })
    const { cursor, asks } = seek(index, movie.bytes, 5.0)
    const second = must(movie.clusters[5])
    expect(cursor).toEqual({
      ...matroskaStart(index, null),
      at: dataOf(movie, 5) + blockAt(movie, 5, 0),
      cluster: { timestamp: 5000, end: second.end, sized: true },
    })
    // The Cues' header read holds all of them; the cluster's holds its keyframe, so no more is read.
    expect(asks).toEqual([
      { start: must(movie.cues), end: movie.bytes.length },
      { start: second.start, end: movie.bytes.length },
    ])
    expect(landsBefore(index, movie.bytes, cursor, 5.0)).toBe(5)
  })

  it('lands in the cluster a time is in, at a keyframe at or before it, for every quarter second of the file', () => {
    for (let quarter = 0; quarter <= 44; quarter += 1) {
      const time = quarter / 4
      const { cursor } = seek(index, movie.bytes, time)
      expect(inCluster(movie.clusters, cursor.at)).toBe(Math.min(Math.floor(time), 9))
      expect(landsBefore(index, movie.bytes, cursor, time)).toBe(Math.min(Math.floor(time), 9))
    }
  })

  it('gives the same cursor to a caller that holds the whole file, and asks it nothing', () => {
    for (const time of [-1, 0, 3.5, 5, 9.9, 100]) {
      const exact = seek(index, movie.bytes, time)
      const ahead = seek(index, movie.bytes, time, { held: everything(movie.bytes) })
      expect(ahead.asks).toEqual([])
      expect(ahead.cursor).toEqual(exact.cursor)
    }
  })

  it("gives the cursor of the sound it is asked for, and refuses a sound that doesn't play and a time that is no time", () => {
    const both = matroskaMovie({
      duration: 3000,
      scale: 1_000_000,
      seek: true,
      tracks: [VP9, OPUS],
      clusters: upTo(3).map((k) => ({
        timestamp: 1000 * k,
        frames: [
          { track: 2, time: 1000 * k, keyframe: true, data: tagged(9) },
          pictureFrame(1000 * k, k, true),
        ],
      })),
      // The sound's block comes first, so the picture's follows it: the Timestamp, then 14 bytes.
      cuePoints: (at) =>
        upTo(3).map((k) => ({
          time: 1000 * k,
          cluster: must(at[k]),
          relative: stampLength(k) + 14,
        })),
    })
    const opened = indexOf(both.bytes)
    const { cursor } = seek(opened, both.bytes, 1.5, { sound: 2 })
    expect(cursor).toEqual({
      ...matroskaStart(opened, 2),
      at: dataOf(both, 1) + stampLength(1) + 14,
      cluster: { timestamp: 1000, end: must(both.clusters[1]).end, sized: true },
    })
    expect(cursor.audio).not.toBeNull()
    expect(cursor.pictureStarted).toBe(false)
    expect(landsBefore(opened, both.bytes, cursor, 1.5)).toBe(1)
    // A sound that is not one of the index's, or a time that is no time, is the caller's mistake: nothing is asked.
    expect(() => matroskaSeek(opened, 1, 7, [])).toThrow(RangeError)
    expect(() => matroskaSeek(opened, Number.NaN, null, [])).toThrow(RangeError)
  })

  it('goes to the point before when the keyframe that a point names is later than its time, and keeps the first point when none is before', () => {
    // Cluster 5 starts at 5 s but its keyframe is at 5.8 s, after a delta frame, which is the block that the cue names.
    const lying = seconds(10)
    lying[5] = {
      timestamp: 5000,
      frames: [pictureFrame(5000, 50, false), pictureFrame(5800, 51, true)],
    }
    const file = cued(lying, upTo(10))
    const opened = indexOf(file.bytes)

    const early = seek(opened, file.bytes, 5.2)
    expect(inCluster(file.clusters, early.cursor.at)).toBe(4)
    expect(early.cursor.at).toBe(dataOf(file, 4) + blockAt(file, 4, 0))
    expect(landsBefore(opened, file.bytes, early.cursor, 5.2)).toBe(4)
    // The headers of both clusters were read, the lying one first.
    expect(early.asks.map((ask) => ask.start)).toEqual([
      must(file.cues),
      must(file.clusters[5]).start,
      must(file.clusters[4]).start,
    ])

    // Once the time is past the keyframe, the point is good.
    const late = seek(opened, file.bytes, 5.9)
    expect(inCluster(file.clusters, late.cursor.at)).toBe(5)
    expect(landsBefore(opened, file.bytes, late.cursor, 5.9)).toBe(5.8)

    // A first point that lies has nothing before it: it is kept, as a point whose keyframe is not found is.
    const first = seconds(4)
    first[0] = { timestamp: 0, frames: [pictureFrame(300, 1, true), pictureFrame(500, 2, false)] }
    const liar = cued(first, upTo(4))
    const kept = seek(indexOf(liar.bytes), liar.bytes, 0.1)
    expect(kept.cursor.at).toBe(dataOf(liar, 0) + blockAt(liar, 0, 0))
  })

  it("starts at the cluster's own start when a point names no block, or one that is not in the cluster, or not a block", () => {
    const plain = seconds(4)
    const here = movieOf(plain)
    const cases: [string, (k: number) => number | undefined][] = [
      ['no block', () => undefined],
      ['a block past the cluster', () => 1_000_000],
      ['one byte into a block', (k) => blockAt(here, k, 0) + 1],
    ]
    for (const [name, relative] of cases) {
      const file = movieOf(plain, {
        seek: true,
        cuePoints: (at) =>
          upTo(4).map((k) => ({ time: 1000 * k, cluster: must(at[k]), relative: relative(k) })),
      })
      const opened = indexOf(file.bytes)
      const { cursor } = seek(opened, file.bytes, 2.5)
      // The cursor is then at the cluster's header, which readClusters enters.
      expect(cursor, name).toEqual({
        ...matroskaStart(opened, null),
        at: must(file.clusters[2]).start,
      })
      expect(landsBefore(opened, file.bytes, cursor, 2.5), name).toBe(2)
    }
  })

  it("counts the times of the Cues in ticks of the file's TimestampScale", () => {
    // Ticks of half a millisecond: a second is 2000 of them.
    const doubled: MovieCluster[] = upTo(10).map((k) => ({
      timestamp: 2000 * k,
      frames: [pictureFrame(2000 * k, k, true), { track: 1, time: 2000 * k + 1000, size: 8 }],
    }))
    const plain = movieOf(doubled, { scale: 500_000 })
    const file = movieOf(doubled, {
      scale: 500_000,
      seek: true,
      cuePoints: (at) =>
        upTo(10).map((k) => ({
          time: 2000 * k,
          cluster: must(at[k]),
          relative: blockAt(plain, k, 0),
        })),
    })
    const opened = indexOf(file.bytes)
    expect(opened.timestampScale).toBe(500_000)
    for (const [time, expected] of [
      [4.99, 4],
      [5, 5],
      [5.4, 5],
    ] as const) {
      const { cursor } = seek(opened, file.bytes, time)
      expect(inCluster(file.clusters, cursor.at)).toBe(expected)
      expect(landsBefore(opened, file.bytes, cursor, time)).toBe(expected)
    }
  })

  it("reads on from a block that lies beyond the bytes of the cluster's header, to the keyframe", () => {
    // Cluster 5 begins with a delta frame of 100 KB and has its keyframe at 5.5 s: the cue names that block.
    const heavy = seconds(10)
    heavy[5] = {
      timestamp: 5000,
      frames: [{ track: 1, time: 5000, size: 100_000 }, pictureFrame(5500, 55, true)],
    }
    const plain = movieOf(heavy)
    const file = movieOf(heavy, {
      seek: true,
      cuePoints: (at) =>
        upTo(10).map((k) => ({
          time: k === 5 ? 5500 : 1000 * k,
          cluster: must(at[k]),
          relative: blockAt(plain, k, k === 5 ? 1 : 0),
        })),
    })
    const opened = indexOf(file.bytes)
    const { cursor, asks } = seek(opened, file.bytes, 5.6)
    const named = dataOf(file, 5) + blockAt(file, 5, 1)
    expect(cursor.at).toBe(named)
    expect(named - must(file.clusters[5]).start).toBeGreaterThan(HEADER_READ)
    // The Cues, the cluster's header, and then the bytes from the block, which the header's read does not reach.
    expect(asks.map((ask) => ask.start)).toEqual([
      must(file.cues),
      must(file.clusters[5]).start,
      named,
    ])
    expect(landsBefore(opened, file.bytes, cursor, 5.6)).toBe(5.5)
    // Before the keyframe the point before is used.
    const earlier = seek(opened, file.bytes, 5.2)
    expect(inCluster(file.clusters, earlier.cursor.at)).toBe(4)
  })

  it('enters a cluster of unknown size, which ends where the Segment does', () => {
    const open = seconds(5, { unknown: true })
    const file = cued(open, upTo(5))
    const opened = indexOf(file.bytes)
    const { cursor } = seek(opened, file.bytes, 3.2)
    expect(cursor.cluster).toEqual({ timestamp: 3000, end: opened.segment.end, sized: false })
    expect(cursor.at).toBe(dataOf(file, 3) + blockAt(file, 3, 0))
    expect(landsBefore(opened, file.bytes, cursor, 3.2)).toBe(3)
  })

  it('goes to the start of the first point for a time before it, and to the last for a time past the end', () => {
    const before = seek(index, movie.bytes, -1)
    expect(before.cursor).toEqual(matroskaStart(index, null))
    const past = seek(index, movie.bytes, 1e6)
    expect(past.cursor.at).toBe(dataOf(movie, 9) + blockAt(movie, 9, 0))
    expect(landsBefore(index, movie.bytes, past.cursor, 1e6)).toBe(9)
  })

  it("starts at the cluster's own start when the bytes at a point's block have no readable header", () => {
    // Cluster 5 begins with a Void of zeros, then its keyframe; the cue's block position is inside the zeros: no element there, so the point is not at a block, and the readClusters that follows it would pass the damage and find a keyframe in a later cluster.
    const blocks = upTo(10).map((k) =>
      k === 5
        ? cluster(5000, [
            element(ID.Void, new Uint8Array(8)),
            simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [vp9Key(5)] }),
            simpleBlock({ track: 1, timecode: 500, frames: [new Uint8Array(8)] }),
          ])
        : rawCluster(k, 8),
    )
    const built = assemble(blocks, {
      back: (starts) =>
        cues(
          starts.map((start, k) => ({
            time: 1000 * k,
            cluster: start,
            // The Timestamp, the Void's header of 2 bytes, and 1 byte of its zeros.
            relative: stampLength(k) + (k === 5 ? 3 : 0),
          })),
          { positionWidth: 8 },
        ),
      seek: 'back',
    })
    const { bytes } = built.file
    const index = indexOf(bytes)
    const { cursor } = seek(index, bytes, 5.5)
    expect(cursor).toEqual({ ...matroskaStart(index, null), at: must(built.clusters[5]) })
    expect(landsBefore(index, bytes, cursor, 5.5)).toBe(5)
  })

  it("keeps the block that a point names when the cluster's header bytes end within the block's header", () => {
    // The keyframe of cluster 5 follows a Void that ends 1 byte before the first read of the cluster does: its header is not whole in those bytes, and the read from the block tells that it is one.
    const gap = HEADER_READ - 1 - 7 - stampLength(5)
    const blocks = upTo(10).map((k) =>
      k === 5
        ? cluster(5000, [
            element(ID.Void, new Uint8Array(gap - 4)),
            simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [vp9Key(5)] }),
            simpleBlock({ track: 1, timecode: 500, frames: [new Uint8Array(8)] }),
          ])
        : rawCluster(k, 8),
    )
    const built = assemble(blocks, {
      back: (starts) =>
        cues(
          starts.map((start, k) => ({
            time: 1000 * k,
            cluster: start,
            relative: stampLength(k) + (k === 5 ? gap : 0),
          })),
          { positionWidth: 8 },
        ),
      seek: 'back',
    })
    const { bytes } = built.file
    const index = indexOf(bytes)
    const start = must(built.clusters[5])
    const { cursor } = seek(index, bytes, 5.5)
    expect(cursor.at - start).toBe(HEADER_READ - 1)
    expect(cursor.cluster).toEqual({ timestamp: 5000, end: must(built.clusters[6]), sized: true })
    expect(landsBefore(index, bytes, cursor, 5.5)).toBe(5)
  })

  it("starts at the first cluster for a time before the first point when that point's cluster is not the first", () => {
    // Cues that begin at the fourth cluster.
    const file = cued(seconds(10), [3, 4, 5, 6, 7, 8, 9])
    const opened = indexOf(file.bytes)
    const { cursor, asks } = seek(opened, file.bytes, 1.5)
    expect(cursor).toEqual(matroskaStart(opened, null))
    expect(inCluster(file.clusters, cursor.at)).toBe(0)
    // Nothing of the clusters was read.
    expect(asks).toEqual([{ start: must(file.cues), end: file.bytes.length }])
    // From the first point on they are used.
    expect(inCluster(file.clusters, seek(opened, file.bytes, 3.2).cursor.at)).toBe(3)
  })

  it("starts at the first cluster when the first point's keyframe is after the time and its cluster is not the first", () => {
    // Cues that begin at the third cluster, whose keyframe is at 2.8 s after a delta frame at 2.0 s.
    const lying = seconds(10)
    lying[2] = {
      timestamp: 2000,
      frames: [pictureFrame(2000, 20, false), pictureFrame(2800, 21, true)],
    }
    const file = cued(lying, [2, 3, 4, 5, 6, 7, 8, 9])
    const opened = indexOf(file.bytes)
    const { cursor } = seek(opened, file.bytes, 2.2)
    expect(cursor).toEqual(matroskaStart(opened, null))
    expect(landsBefore(opened, file.bytes, cursor, 2.2)).toBe(0)
    // Once the time is past the keyframe the point is good.
    const good = seek(opened, file.bytes, 2.9)
    expect(inCluster(file.clusters, good.cursor.at)).toBe(2)
    expect(landsBefore(opened, file.bytes, good.cursor, 2.9)).toBe(2.8)
  })

  it("takes a picture's CodecDelay off the times of the cues, but not the shift of its decode times", () => {
    // A picture with a CodecDelay of half a second: a keyframe at 5000 ticks is shown at 4.5 s.
    const delayed = cued(seconds(10), upTo(10), { tracks: [{ ...VP9, codecDelay: 500_000_000 }] })
    const opened = indexOf(delayed.bytes)
    expect(opened.video.timing.offsetSeconds).toBe(-0.5)
    expect(inCluster(delayed.clusters, seek(opened, delayed.bytes, 4.6).cursor.at)).toBe(5)
    expect(inCluster(delayed.clusters, seek(opened, delayed.bytes, 4.4).cursor.at)).toBe(4)
    expect(landsBefore(opened, delayed.bytes, seek(opened, delayed.bytes, 4.6).cursor, 4.6)).toBe(
      4.5,
    )

    // B-frames put the decode times before 0, and the index shifts them by 67 ms (offsetSeconds takes that off); the times of the cues are not shifted.
    const reordered: MovieCluster[] = upTo(10).map((k) => ({
      timestamp: 1000 * k,
      frames: [
        { track: 1, time: 1000 * k, keyframe: true, data: tagged(1) },
        { track: 1, time: 1000 * k + 100, data: tagged(2) },
        { track: 1, time: 1000 * k + 33, data: tagged(3) },
        { track: 1, time: 1000 * k + 67, data: tagged(4) },
      ],
    }))
    const bframes = cued(reordered, upTo(10), { tracks: [H264] })
    const shifted = indexOf(bframes.bytes)
    expect(shifted.video.read.shift).toBe(67)
    // 4.96 s is before the keyframe at 5.0 s, and after the shifted time 4.933.
    expect(inCluster(bframes.clusters, seek(shifted, bframes.bytes, 4.96).cursor.at)).toBe(4)
    const exact = seek(shifted, bframes.bytes, 5)
    expect(inCluster(bframes.clusters, exact.cursor.at)).toBe(5)
    expect(landsBefore(shifted, bframes.bytes, exact.cursor, 5)).toBeCloseTo(5, 9)
  })
})

describe('finding the Cues (§10.4)', () => {
  const clusters = seconds(10)

  it('reads the whole of Cues that stand before the clusters in one ask, and then the cluster', () => {
    const blocks = upTo(10).map((k) => rawCluster(k, 8))
    const built = assemble(blocks, { front: cuesOfAll(10), seek: 'front' })
    const { bytes } = built.file
    const index = indexOf(bytes)
    const start = must(built.cues)
    expect(index.cues).toEqual({ start, end: index.firstCluster })

    const { cursor, asks } = seek(index, bytes, 6.5)
    expect(asks).toEqual([
      { start, end: index.firstCluster },
      { start: must(built.clusters[6]), end: bytes.length },
    ])
    expect(cursor.at).toBe(dataAt(bytes, must(built.clusters[6])) + stampLength(6))
    expect(cursor.cluster).toEqual({
      timestamp: 6000,
      end: must(built.clusters[7]),
      sized: true,
    })
    expect(landsBefore(index, bytes, cursor, 6.5)).toBe(6)
  })

  it('reads Cues that are longer than a header read whole, in a second ask', () => {
    // 4000 points, 400 for the start of each cluster, 100 KB of Cues.
    const tens = seconds(10)
    const plain = movieOf(tens)
    const file = movieOf(tens, {
      seek: true,
      cuePoints: (at) =>
        upTo(4000).map((one) => {
          const k = Math.floor(one / 400)
          return {
            time: 1000 * k + (one % 400),
            cluster: must(at[k]),
            relative: blockAt(plain, k, 0),
          }
        }),
    })
    const opened = indexOf(file.bytes)
    const start = must(file.cues)
    expect(file.bytes.length - start).toBeGreaterThan(HEADER_READ)
    const { cursor, asks } = seek(opened, file.bytes, 5.0)
    expect(asks.slice(0, 2)).toEqual([
      { start, end: start + HEADER_READ },
      { start, end: file.bytes.length },
    ])
    expect(inCluster(file.clusters, cursor.at)).toBe(5)
    expect(landsBefore(opened, file.bytes, cursor, 5.0)).toBe(5)
  })

  it("looks at the last megabyte of a file whose SeekHead doesn't name the Cues, and takes the Cues it finds there", () => {
    const small = movieOf(clusters, {
      cuePoints: (at) =>
        upTo(10).map((k) => ({
          time: 1000 * k,
          cluster: must(at[k]),
          relative: stampLength(k),
        })),
    })
    const index = indexOf(small.bytes)
    expect(index.cues).toBeNull()
    const { cursor, asks } = seek(index, small.bytes, 5.5)
    // The tail is the whole of this small file from the first cluster, and holds the cluster too.
    expect(asks).toEqual([{ start: index.firstCluster, end: small.bytes.length }])
    expect(cursor.at).toBe(dataAt(small.bytes, must(small.clusters[5]).start) + stampLength(5))
    expect(landsBefore(index, small.bytes, cursor, 5.5)).toBe(5)

    // In a file longer than a megabyte the tail is exactly the last one.
    const long = seconds(20, { pad: 99_000 })
    const big = movieOf(long, {
      cuePoints: (at) =>
        upTo(20).map((k) => ({
          time: 1000 * k,
          cluster: must(at[k]),
          relative: stampLength(k),
        })),
    })
    const opened = indexOf(big.bytes)
    const found = seek(opened, big.bytes, 5.5)
    // The cluster is before the tail, so its header is another ask.
    expect(found.asks).toEqual([
      { start: opened.segment.end - TAIL_BYTES, end: opened.segment.end },
      { start: must(big.clusters[5]).start, end: must(big.clusters[5]).start + HEADER_READ },
    ])
    expect(inCluster(big.clusters, found.cursor.at)).toBe(5)
    expect(landsBefore(opened, big.bytes, found.cursor, 5.5)).toBe(5)
  })

  it('takes the Cues from the tail when a SeekHead names the Info and the Tracks and not the Cues', () => {
    const blocks = upTo(10).map((k) => rawCluster(k, 8))
    const built = assemble(blocks, { back: cuesOfAll(10), seek: 'without' })
    const { bytes } = built.file
    const index = indexOf(bytes)
    expect(index.cues).toBeNull()
    const { cursor, asks } = seek(index, bytes, 2.5)
    expect(asks).toEqual([{ start: index.firstCluster, end: bytes.length }])
    expect(cursor.at).toBe(dataAt(bytes, must(built.clusters[2])) + stampLength(2))
    expect(landsBefore(index, bytes, cursor, 2.5)).toBe(2)
  })

  it('goes past a Cues element in the payload of a frame, which does not end where the Segment does or where one of its own elements starts', () => {
    // A whole Cues element, naming the first cluster, inside a frame, with an element after it that is not one of the Segment's own (a Void).
    const decoy = concat(
      cues([{ time: 0, cluster: 0, relative: 1 }]),
      element(ID.Void, new Uint8Array(4)),
      new Uint8Array(40),
    )
    const blocks = upTo(10).map((k) => rawCluster(k, 8, k === 9 ? decoy : vp9Key(k)))
    const built = assemble(blocks, { back: cuesOfAll(10) })
    const { bytes } = built.file
    const index = indexOf(bytes)
    const { cursor } = seek(index, bytes, 4.5)
    expect(cursor.at).toBe(dataAt(bytes, must(built.clusters[4])) + stampLength(4))
  })

  it("looks in the tail when the SeekHead's entry for the Cues leads to something that is not Cues", () => {
    const blocks = upTo(10).map((k) => rawCluster(k, 8))
    const built = assemble(blocks, { back: cuesOfAll(10), seek: 'stale' })
    const { bytes } = built.file
    const index = indexOf(bytes)
    expect(index.cues?.end).toBeNull()
    const { cursor, asks } = seek(index, bytes, 7.5)
    // The entry's header read finds a cluster, and then the tail is read.
    expect(asks.map((ask) => ask.start)).toEqual([must(built.clusters[3]), index.firstCluster])
    expect(cursor.at).toBe(dataAt(bytes, must(built.clusters[7])) + stampLength(7))
  })

  it('searches the clusters when the Cues are over CUES_LIMIT, and never asks for the Cues', () => {
    const blocks = upTo(40).map((k) => rawCluster(k, 99_000))
    const huge = element(ID.Cues, new Uint8Array(CUES_LIMIT))
    const named = assemble(blocks, { back: () => huge, seek: 'back' })
    const bytes = named.file.bytes
    const index = indexOf(bytes)
    const cuesStart = must(named.cues)
    const { cursor, asks } = seek(index, bytes, 20.5)
    // Its header is read, which is all of it that is.
    expect(asks[0]).toEqual({ start: cuesStart, end: cuesStart + HEADER_READ })
    for (const ask of asks) expect(ask.end - ask.start).toBeLessThanOrEqual(SEARCH_READ)
    expect(inCluster(rangesOf(named), cursor.at)).toBe(20)
    expect(cursor.at).toBe(must(named.clusters[20]))
    expect(landsBefore(index, bytes, cursor, 20.5)).toBe(20)

    // Cues that stand before the clusters have their size in the index, so the seek doesn't ask for them at all.
    const front = assemble(blocks, { front: () => huge })
    const opened = indexOf(front.file.bytes)
    const found = seek(opened, front.file.bytes, 20.5)
    expect(opened.cues).toEqual({ start: must(front.cues), end: opened.firstCluster })
    for (const ask of found.asks) {
      expect(ask.start).toBeGreaterThanOrEqual(opened.firstCluster)
      expect(ask.end - ask.start).toBeLessThanOrEqual(SEARCH_READ)
    }
    expect(landsBefore(opened, front.file.bytes, found.cursor, 20.5)).toBe(20)
  })

  it('searches when the Cues have no point of the picture, or do not walk, or point at something that is no cluster', () => {
    const blocks = upTo(40).map((k) => rawCluster(k, 99_000))
    const cases: Record<string, (clusters: number[]) => Uint8Array> = {
      'no point of the picture': (starts) =>
        cues(
          starts.map((start, k) => ({ time: 1000 * k, track: 2, cluster: start })),
          {
            positionWidth: 8,
          },
        ),
      'children that do not walk': () =>
        element(ID.Cues, elementSized(ID.CuePoint, sizeBytes(50), uint(ID.CueTime, 1))),
      'a position in the middle of a frame': (starts) =>
        cues(
          starts.map((start, k) => ({ time: 1000 * k, cluster: start + 50_000, relative: 4 })),
          { positionWidth: 8 },
        ),
      'a position at the Tracks': (starts) =>
        cues(
          starts.map((_, k) => ({ time: 1000 * k, cluster: 1, relative: 4 })),
          { positionWidth: 8 },
        ),
    }
    for (const [name, back] of Object.entries(cases)) {
      const built = assemble(blocks, { back, seek: 'back' })
      const bytes = built.file.bytes
      const index = indexOf(bytes)
      const { cursor, asks } = seek(index, bytes, 20.5)
      expect(asks.length, name).toBeLessThanOrEqual(MAX_SEEK_READS)
      // The search lands in the cluster the time is in: nothing of the cues is trusted.
      expect(cursor.cluster, name).toBeNull()
      expect(cursor.at, name).toBe(must(built.clusters[20]))
      expect(landsBefore(index, bytes, cursor, 20.5), name).toBe(20)
    }
  })
})

describe('the bounds on the walk of the Cues (§10.4)', () => {
  /** `count` empty elements of a one-byte ID (an ID and a size of 0) as one run of bytes, written in a loop so that millions of them cost no array of parts. */
  function empties(count: number, id: number): Uint8Array {
    expect(id).toBeLessThan(0x100)
    const out = new Uint8Array(count * 2)
    for (let at = 0; at < out.length; at += 2) {
      out[at] = id
      out[at + 1] = 0x80
    }
    return out
  }

  /** An ID that no CuePoint, CueTrackPositions or Cues holds, with a one-byte ID. */
  const OTHER = ID.Channels

  /** A CuePoint of one CueTrackPositions for track 1, with `more` after the position. */
  function point(time: number, cluster: number, ...more: Uint8Array[]): Uint8Array {
    return element(
      ID.CuePoint,
      uint(ID.CueTime, time),
      element(
        ID.CueTrackPositions,
        uint(ID.CueTrack, 1),
        uint(ID.CueClusterPosition, cluster),
        ...more,
      ),
    )
  }

  /** What `readCues` gives for a Cues element of the bytes given, with a Segment whose data starts at 0. */
  function readCuesOf(bytes: Uint8Array): ReturnType<typeof readCues> {
    return readCues(bytes, must(readHeader(bytes, 0, bytes.length)), 0, 0, 1)
  }

  /** What `readCues` gives for a Cues element that holds the body. */
  function readBody(...body: Uint8Array[]): ReturnType<typeof readCues> {
    return readCuesOf(element(ID.Cues, ...body))
  }

  /** Cues of the points given (written at a fixed width, so that the Cues are as long wherever the clusters are) with the run of bytes `flood` after the points. */
  function flooded(points: CueSpec[], flood: Uint8Array): Uint8Array {
    const real = cues(points, { positionWidth: 8 })
    return element(ID.Cues, real.subarray(must(readHeader(real, 0, real.length)).data), flood)
  }

  it('reads Cues of MAX_CUE_POINTS children, and refuses those of one more as a damaged file, naming where they are', () => {
    expect(readBody(point(5, 9), empties(MAX_CUE_POINTS - 1, ID.CuePoint))).toEqual([
      { time: 5, cluster: 9, relative: null },
    ])
    const error = damagedBy(() => readBody(point(5, 9), empties(MAX_CUE_POINTS, ID.CuePoint)))
    expect(error.message).toContain('The Cues element at offset')
    // Children of another ID count as well, and so do a Void and a CRC-32, whose headers the walk reads all the same.
    for (const id of [OTHER, ID.Void, ID.CRC32]) {
      damagedBy(() => readBody(point(5, 9), empties(MAX_CUE_POINTS, id)))
    }
  })

  it('never cuts the points short: Cues of more children than the bound give none of their points', () => {
    const points = upTo(40).map((k) => ({ time: 1000 * k, cluster: 100 + k }))
    expect(readCuesOf(flooded(points, empties(MAX_CUE_POINTS - 40, ID.CuePoint)))).toHaveLength(40)
    damagedBy(() => readCuesOf(flooded(points, empties(MAX_CUE_POINTS - 39, ID.CuePoint))))
  })

  it('reads a CuePoint, and a CueTrackPositions, of MAX_CUE_FIELDS children, and refuses one of more as a damaged file', () => {
    const place = [{ time: 5, cluster: 9, relative: null }]
    // A CuePoint holds the CueTime and the CueTrackPositions, and then the rest.
    const crowded = (rest: number): Uint8Array =>
      element(
        ID.CuePoint,
        uint(ID.CueTime, 5),
        element(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, 9)),
        empties(rest, OTHER),
      )
    expect(readBody(crowded(MAX_CUE_FIELDS - 2))).toEqual(place)
    damagedBy(() => readBody(crowded(MAX_CUE_FIELDS - 1)))

    // A CueTrackPositions holds the CueTrack and the CueClusterPosition, and then the rest.
    expect(readBody(point(5, 9, empties(MAX_CUE_FIELDS - 2, OTHER)))).toEqual(place)
    damagedBy(() => readBody(point(5, 9, empties(MAX_CUE_FIELDS - 1, OTHER))))
  })

  it('refuses 32 MiB of children of a few bytes each, wherever they stand, in well under a second', () => {
    const most = (CUES_LIMIT - 1024) / 2
    const shapes: Record<string, Uint8Array> = {
      'empty CuePoints': empties(most, ID.CuePoint),
      'Void elements': empties(most, ID.Void),
      'fields of one CuePoint': element(ID.CuePoint, empties(most, OTHER)),
      'fields of one CueTrackPositions': element(
        ID.CuePoint,
        uint(ID.CueTime, 5),
        element(ID.CueTrackPositions, empties(most - 8, OTHER)),
      ),
    }
    for (const [name, body] of Object.entries(shapes)) {
      const bytes = element(ID.Cues, body)
      const before = performance.now()
      damagedBy(() => readCuesOf(bytes))
      expect(performance.now() - before, name).toBeLessThan(1000)
    }
  }, 120_000)

  describe('seeking in a file whose Cues are too many to walk', () => {
    const blocks = upTo(40).map((k) => rawCluster(k, 99_000))

    /** Where the Cues go: after the clusters, named by the SeekHead, or before them, where the index knows their size. */
    const layouts: [string, (make: (starts: number[]) => Uint8Array) => Layout][] = [
      ['after the clusters, named by the SeekHead,', (make) => ({ back: make, seek: 'back' })],
      ['before the clusters', (make) => ({ front: make })],
    ]

    it.each(layouts)(
      'searches the clusters, and trusts none of the points, when the Cues %s hold more than MAX_CUE_POINTS children',
      (_name, layout) => {
        // A point for every cluster, at its block, as ffmpeg writes them: if they were used, the seek would land at the block.
        const built = assemble(
          blocks,
          layout((starts) =>
            flooded(
              upTo(40).map((k) => ({
                time: 1000 * k,
                cluster: must(starts[k]),
                relative: stampLength(k),
              })),
              empties(MAX_CUE_POINTS, ID.CuePoint),
            ),
          ),
        )
        const bytes = built.file.bytes
        const index = indexOf(bytes)
        const { cursor, asks } = seek(index, bytes, 20.5)
        expect(asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
        // The search lands in the cluster the time is in, at its start: the points are not used, and not cut short, which would land far too early.
        expect(cursor.cluster).toBeNull()
        expect(cursor.at).toBe(must(built.clusters[20]))
        expect(landsBefore(index, bytes, cursor, 20.5)).toBe(20)
      },
    )

    it.each(layouts)(
      'searches the clusters in a few seconds when the Cues %s are 32 MiB of empty CuePoints',
      (_name, layout) => {
        const huge = element(ID.Cues, empties((CUES_LIMIT - 1024) / 2, ID.CuePoint))
        const built = assemble(
          blocks,
          layout(() => huge),
        )
        const bytes = built.file.bytes
        const index = indexOf(bytes)

        const before = performance.now()
        const { cursor, asks } = seek(index, bytes, 20.5)
        const took = performance.now() - before

        expect(took).toBeLessThan(3000)
        expect(asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
        expect(cursor.cluster).toBeNull()
        expect(cursor.at).toBe(must(built.clusters[20]))
        expect(landsBefore(index, bytes, cursor, 20.5)).toBe(20)
      },
      120_000,
    )

    it('passes over Cues in the last megabyte that hold a CuePoint of more than MAX_CUE_FIELDS children, as it does Cues that do not walk', () => {
      // The Cues stand last and no SeekHead names them, so that the seek finds them in the tail: a point for every cluster, then one CuePoint of fields.
      const lands = (fields: number) => {
        const built = assemble(blocks, {
          back: (starts) =>
            flooded(
              upTo(40).map((k) => ({
                time: 1000 * k,
                cluster: must(starts[k]),
                relative: stampLength(k),
              })),
              element(ID.CuePoint, uint(ID.CueTime, 1), empties(fields, OTHER)),
            ),
        })
        const bytes = built.file.bytes
        const index = indexOf(bytes)
        return { ...seek(index, bytes, 20.5), built }
      }

      // With a CueTime and 63 fields the CuePoint is whole: the points are used, and the seek lands at the block of the cluster's point.
      const used = lands(MAX_CUE_FIELDS - 1)
      expect(used.cursor.cluster).not.toBeNull()
      expect(used.cursor.at).toBeGreaterThan(must(used.built.clusters[20]))

      // With one more the Cues are damaged: the candidate is passed over, there are no others, and the search lands at the cluster's start.
      const passed = lands(MAX_CUE_FIELDS)
      expect(passed.cursor.cluster).toBeNull()
      expect(passed.cursor.at).toBe(must(passed.built.clusters[20]))
    })
  })
})

describe('seeking by a search of the clusters (§10.4)', () => {
  // Clusters of about 100 KB, so that a file of them is longer than the guesses of a search are.
  const pad = 99_000

  it('lands in the cluster at or before the time, within 20 reads, in 200 clusters of unknown size with one keyframe each and no Cues', () => {
    const long = movieOf(seconds(200, { pad, unknown: true }))
    const index = indexOf(long.bytes)
    expect(index.cues).toBeNull()
    for (const [time, expected] of [
      [0, 0],
      [1.7, 1],
      [99.9, 99],
      [199, 199],
    ] as const) {
      const exact = seek(index, long.bytes, time)
      expect(exact.asks.length).toBeLessThanOrEqual(20)
      expect(exact.cursor.searching).toBe(false)
      expect(exact.cursor.cluster).toBeNull()
      expect(inCluster(long.clusters, exact.cursor.at)).toBe(expected)
      expect(exact.cursor.at).toBe(must(long.clusters[expected]).start)
      expect(landsBefore(index, long.bytes, exact.cursor, time)).toBe(expected)

      // A caller that has read it all is asked nothing and is given the same cursor, and so is one that holds the first megabyte, as a player does.
      const ahead = seek(index, long.bytes, time, { held: everything(long.bytes) })
      expect(ahead.asks).toEqual([])
      expect(ahead.cursor).toEqual(exact.cursor)
      const head = seek(index, long.bytes, time, {
        held: [{ start: 0, bytes: long.bytes.subarray(0, 1024 * 1024) }],
      })
      expect(head.cursor).toEqual(exact.cursor)
    }
  })

  it('lands at a cluster that holds a keyframe, at or before the time, when only every third cluster has one', () => {
    const sparse = movieOf(seconds(60, { pad, keyEvery: 3 }))
    const index = indexOf(sparse.bytes)
    for (const [time, expected] of [
      [0.5, 0],
      [10.5, 9],
      [11.9, 9],
      [12, 12],
      [59.9, 57],
      [100, 57],
    ] as const) {
      const exact = seek(index, sparse.bytes, time)
      expect(exact.asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
      expect(inCluster(sparse.clusters, exact.cursor.at)).toBe(expected)
      expect(landsBefore(index, sparse.bytes, exact.cursor, time)).toBe(expected)
      const ahead = seek(index, sparse.bytes, time, { held: everything(sparse.bytes) })
      expect(ahead.cursor).toEqual(exact.cursor)
    }
  })

  it('gives the first cluster for a time before the start, and the last cluster for a time past the end', () => {
    const forty = movieOf(seconds(40, { pad }))
    const index = indexOf(forty.bytes)
    for (const time of [-5, -0.001]) {
      expect(seek(index, forty.bytes, time).cursor).toEqual(matroskaStart(index, null))
    }
    expect(seek(index, forty.bytes, 0).cursor).toEqual(matroskaStart(index, null))
    const past = seek(index, forty.bytes, 1e6)
    expect(inCluster(forty.clusters, past.cursor.at)).toBe(39)
    expect(landsBefore(index, forty.bytes, past.cursor, 1e6)).toBe(39)
  })

  it('reads the tail of a file shorter than one guess, which holds all of it, and finds the cluster in that', () => {
    const small = movieOf(seconds(10))
    const index = indexOf(small.bytes)
    expect(small.bytes.length).toBeLessThan(SEARCH_READ)
    const { cursor, asks } = seek(index, small.bytes, 6.5)
    // The tail is the whole file from the first cluster; the search makes no guess but looks at the clusters in what it holds.
    expect(asks).toEqual([{ start: index.firstCluster, end: small.bytes.length }])
    expect(inCluster(small.clusters, cursor.at)).toBe(6)
  })

  it('stops at MAX_SEEK_READS with the first cluster, whatever the caller holds, when every point lies', () => {
    // Cluster k starts at 100 + k seconds but the cues say k seconds, so that every cue but the first names a keyframe 100 s late.
    const late = seconds(60, { pad: 2000 }).map((one, k) =>
      k === 0
        ? one
        : {
            timestamp: 1000 * k + 100_000,
            frames: [pictureFrame(1000 * k + 100_000, k, true)],
          },
    )
    const plain = movieOf(late)
    const file = movieOf(late, {
      seek: true,
      cuePoints: (at) =>
        upTo(60).map((k) => ({
          time: 1000 * k,
          cluster: must(at[k]),
          relative: blockAt(plain, k, 0),
        })),
    })
    const index = indexOf(file.bytes)
    const exact = seek(index, file.bytes, 59.5)
    expect(exact.asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
    expect(exact.asks.length).toBeGreaterThan(MAX_SEEK_READS - 4)
    expect(exact.cursor).toEqual(matroskaStart(index, null))
    // The walk down the points would have ended at the first point's cluster if it had not been stopped; the counted reads are the same for a caller who holds the file.
    const ahead = seek(index, file.bytes, 59.5, { held: everything(file.bytes) })
    expect(ahead.cursor).toEqual(exact.cursor)
    // A time that only a few points lie about is found.
    const near = seek(index, file.bytes, 0.5)
    expect(near.cursor.at).toBe(dataOf(file, 0) + blockAt(file, 0, 0))
  })

  it('stops at MAX_SEEK_READS with the first cluster when a search goes back through clusters that hold no keyframe', () => {
    const bare = movieOf(seconds(160, { pad, keyEvery: 1000 }))
    const index = indexOf(bare.bytes)
    const exact = seek(index, bare.bytes, 150.5)
    expect(exact.asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
    expect(exact.asks.length).toBeGreaterThan(MAX_SEEK_READS - 12)
    expect(exact.cursor).toEqual(matroskaStart(index, null))
    const ahead = seek(index, bare.bytes, 150.5, { held: everything(bare.bytes) })
    expect(ahead.cursor).toEqual(exact.cursor)
    expect(landsBefore(index, bare.bytes, exact.cursor, 150.5)).toBe(0)
  })
})

describe('seeking in files of big clusters and big keyframes (§10.4)', () => {
  const MIB = 1024 * 1024
  // The most asks one seek of those files makes (measured over the targets of the tests: 16, 23, 24 and 17), and a few over it.
  const BOUND_15 = 20
  const BOUND_3 = 27
  const BOUND_6 = 28
  const BOUND_STRETCH = 21
  const BOUND_STRETCH_20 = 27

  it('lands in the cluster at or before the time when every cluster is longer than a guess, with no Cues', () => {
    // 40 clusters of 1 MiB, of unknown size: most guesses land inside one, and find no cluster in their read.
    const unknown = movieOf(seconds(40, { pad: MIB, unknown: true }))
    const sized = movieOf(seconds(24, { pad: MIB }))
    for (const movie of [unknown, sized]) {
      const index = indexOf(movie.bytes)
      expect(index.cues).toBeNull()
      const count = movie.clusters.length
      for (const time of [0.3, 5.5, 13.2, 17, count - 0.5, count + 10]) {
        const expected = Math.min(Math.floor(time), count - 1)
        const exact = seek(index, movie.bytes, time)
        expect(exact.asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
        expect(inCluster(movie.clusters, exact.cursor.at)).toBe(expected)
        expect(landsBefore(index, movie.bytes, exact.cursor, time)).toBe(expected)
        const ahead = seek(index, movie.bytes, time, { held: everything(movie.bytes) })
        expect(ahead.cursor).toEqual(exact.cursor)
      }
    }
  })

  it('crosses clusters of 1.5, 3 and 6 MiB in a few reads, and lands in the cluster at or before the time, with no Cues', () => {
    // Without Cues, with one keyframe a cluster: the clusters of a recording at an ordinary bitrate, and of a high one.
    for (const [count, size, most] of [
      [40, 1.5 * MIB, BOUND_15],
      [30, 3 * MIB, BOUND_3],
      [24, 6 * MIB, BOUND_6],
    ] as const) {
      const movie = movieOf(seconds(count, { pad: size, unknown: true }))
      const index = indexOf(movie.bytes)
      let widest = 0
      for (const share of [0.01, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.99]) {
        const time = share * count
        const exact = seek(index, movie.bytes, time)
        widest = Math.max(widest, exact.asks.length)
        expect(inCluster(movie.clusters, exact.cursor.at), `${size / MIB} MiB at ${time}`).toBe(
          Math.floor(time),
        )
        expect(landsBefore(index, movie.bytes, exact.cursor, time)).toBe(Math.floor(time))
        // A caller that holds the file is given the same cursor, the cap being on the reads needed.
        const ahead = seek(index, movie.bytes, time, { held: everything(movie.bytes) })
        expect(ahead.cursor).toEqual(exact.cursor)
      }
      expect(widest, `${size / MIB} MiB clusters`).toBeLessThanOrEqual(most)
    }
  })

  it('lands right when a stretch of 9 or 20 MiB with no cluster in it lies ahead of the guesses, in reads that grow to 4 MiB and no more', () => {
    for (const [stretch, most] of [
      [9 * MIB, BOUND_STRETCH],
      [20 * MIB, BOUND_STRETCH_20],
    ] as const) {
      // A Tags element between clusters that no SeekHead names: 20 clusters of 100 KB, the stretch of Tags, 20 more clusters.
      const blocks = upTo(40).map((k) => rawCluster(k, 99_000))
      const file = matroskaFile([
        info({ scale: 1_000_000, duration: 40_000 }),
        tracksElement([trackEntry(VP9)]),
        ...blocks.slice(0, 20),
        element(ID.Tags, new Uint8Array(stretch)),
        ...blocks.slice(20),
      ])
      const { bytes } = file
      const index = indexOf(bytes)
      const ranges = upTo(40).map((k) => {
        const part = 2 + k + (k < 20 ? 0 : 1)
        return { start: must(file.offsets[part]), end: file.offsets[part + 1] ?? bytes.length }
      })
      let widest = 0
      for (const time of [0.5, 5.5, 10.9, 19.5, 20.2, 24.9, 31, 39.5, 100]) {
        const exact = seek(index, bytes, time)
        widest = Math.max(widest, exact.asks.length)
        for (const ask of exact.asks) {
          expect(ask.end - ask.start).toBeLessThanOrEqual(FIRST_FRAMES_BYTES)
        }
        const wanted = Math.min(Math.floor(time), 39)
        expect(inCluster(ranges, exact.cursor.at), `${stretch / MIB} MiB at ${time}`).toBe(wanted)
        expect(landsBefore(index, bytes, exact.cursor, time)).toBe(wanted)
        expect(seek(index, bytes, time, { held: everything(bytes) }).cursor).toEqual(exact.cursor)
      }
      expect(widest, `${stretch / MIB} MiB`).toBeLessThanOrEqual(most)
    }
  })

  it('finds a cluster whose header lies across the end of the first read of a guess', () => {
    // Cluster 6 starts 6 bytes before the first guess's read ends, with 1 MiB clusters: the read has its ID and not its size. The pad of cluster 5 moves cluster 6 by as much, and the guess by half as much.
    const pads = upTo(12).map(() => MIB)
    const build = (): Movie =>
      movieOf(
        seconds(12).map((one, k) => ({
          ...one,
          frames: [
            ...one.frames.slice(0, 1),
            { track: 1, time: 1000 * k + 500, size: must(pads[k]) },
          ],
        })),
      )
    const across = (movie: Movie): number => {
      const first = must(movie.clusters[0]).start
      const guess = first + Math.floor((movie.bytes.length - first) / 2)
      return must(movie.clusters[6]).start - (guess + SEARCH_READ - 6)
    }
    let movie = build()
    for (let round = 0; round < 8 && across(movie) !== 0; round += 1) {
      pads[5] = must(pads[5]) - 2 * across(movie)
      movie = build()
    }
    expect(across(movie)).toBe(0)
    const index = indexOf(movie.bytes)
    const { cursor } = seek(index, movie.bytes, 6.5)
    expect(inCluster(movie.clusters, cursor.at)).toBe(6)
    expect(landsBefore(index, movie.bytes, cursor, 6.5)).toBe(6)
  })

  it('confirms a keyframe of 600 KiB, by the Cues and by the search, and finds the point before a cue that lies', () => {
    const key = 600 * 1024
    const clusters = seconds(20, { key })
    const plain = movieOf(clusters)
    // By the search: no Cues.
    const index = indexOf(plain.bytes)
    for (const time of [0.5, 7.5, 12, 19.9]) {
      const { cursor, asks } = seek(index, plain.bytes, time)
      expect(asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
      expect(inCluster(plain.clusters, cursor.at)).toBe(Math.floor(time))
      expect(landsBefore(index, plain.bytes, cursor, time)).toBe(Math.floor(time))
      const ahead = seek(index, plain.bytes, time, { held: everything(plain.bytes) })
      expect(ahead.cursor).toEqual(cursor)
    }

    // By the Cues, where cluster 5 is dated 5.0 s by its cue and holds its keyframe at 5.8 s.
    const lying = seconds(20, { key })
    lying[5] = { timestamp: 5000, frames: [bigKey(5800, key)] }
    const file = movieOf(lying, {
      seek: true,
      cuePoints: (at) =>
        upTo(20).map((k) => ({
          time: 1000 * k,
          cluster: must(at[k]),
          relative: blockAt(plain, k, 0),
        })),
    })
    const opened = indexOf(file.bytes)
    const early = seek(opened, file.bytes, 5.2)
    expect(inCluster(file.clusters, early.cursor.at)).toBe(4)
    expect(landsBefore(opened, file.bytes, early.cursor, 5.2)).toBe(4)
    const ahead = seek(opened, file.bytes, 5.2, { held: everything(file.bytes) })
    expect(ahead.cursor).toEqual(early.cursor)
    // The block is read whole from the cursor, in the one ask.
    const block = dataOf(file, 5) + blockAt(plain, 5, 0)
    expect(early.asks.filter((ask) => ask.start === block)).toHaveLength(1)
    expect(must(early.asks.find((ask) => ask.start === block)).end).toBeGreaterThan(block + key)
    const late = seek(opened, file.bytes, 5.9)
    expect(inCluster(file.clusters, late.cursor.at)).toBe(5)
    expect(landsBefore(opened, file.bytes, late.cursor, 5.9)).toBe(5.8)
  })

  it('confirms a keyframe of 5 MiB, which is over what is read whole, by the header of its block', () => {
    const key = 5 * MIB
    expect(key).toBeGreaterThan(FIRST_FRAMES_BYTES)
    // Cluster 5 holds a keyframe of 5 MiB, the others are small.
    const build = (time: number): MovieCluster[] => {
      const clusters = seconds(8)
      clusters[5] = { timestamp: 5000, frames: [bigKey(time, key)] }
      return clusters
    }
    // By the search.
    const bare = movieOf(build(5000))
    const index = indexOf(bare.bytes)
    const found = seek(index, bare.bytes, 5.5)
    expect(inCluster(bare.clusters, found.cursor.at)).toBe(5)
    expect(landsBefore(index, bare.bytes, found.cursor, 5.5)).toBe(5)
    // A block of 5 MiB that is not a keyframe, with a small keyframe behind it: the header says it is not one, and the keyframe behind is not reached (the block is more than is read whole), so the search goes to the cluster before.
    const behind = seconds(8)
    behind[5] = {
      timestamp: 5000,
      frames: [{ track: 1, time: 5000, size: key }, pictureFrame(5300, 53, true)],
    }
    const delta = movieOf(behind)
    const before = seek(indexOf(delta.bytes), delta.bytes, 5.5)
    expect(inCluster(delta.clusters, before.cursor.at)).toBe(4)
    // By the Cues, with the cue of cluster 5 telling the time of the keyframe (5000) or lying about it (the keyframe is at 5800).
    for (const [time, wanted] of [
      [5000, 5],
      [5800, 4],
    ] as const) {
      const clusters = build(time)
      const plain = movieOf(clusters)
      const file = movieOf(clusters, {
        seek: true,
        cuePoints: (at) =>
          upTo(8).map((k) => ({
            time: 1000 * k,
            cluster: must(at[k]),
            relative: blockAt(plain, k, 0),
          })),
      })
      const opened = indexOf(file.bytes)
      const sought = seek(opened, file.bytes, 5.2)
      expect(inCluster(file.clusters, sought.cursor.at)).toBe(wanted)
      expect(landsBefore(opened, file.bytes, sought.cursor, 5.2)).toBe(wanted)
      const ahead = seek(opened, file.bytes, 5.2, { held: everything(file.bytes) })
      expect(ahead.cursor).toEqual(sought.cursor)
      // None of the asks is for the block, which is more than is read whole.
      for (const ask of sought.asks) expect(ask.end - ask.start).toBeLessThanOrEqual(SEARCH_READ)
    }
  })
})

describe('seeking in a file whose last cluster is cut off (§10.4)', () => {
  it('lands in the cluster before it for a time past the end, and in the same clusters as for a file that is whole for the times before', () => {
    // Info has no Duration, so the open names the last cluster, which the file ends in, 20 bytes after it starts (inside its keyframe block).
    const whole = movieOf(seconds(20, { pad: 99_000 }), { duration: undefined })
    const last = must(whole.clusters[19])
    const bytes = whole.bytes.subarray(0, last.start + 20)
    const index = indexOf(bytes)
    expect(index.lastCluster).toEqual({ start: last.start, timestamp: 19_000 })
    for (const [time, expected] of [
      [0.5, 0],
      [9.9, 9],
      [18.9, 18],
      [19.5, 18],
      [500, 18],
    ] as const) {
      const exact = seek(index, bytes, time)
      expect(exact.asks.length).toBeLessThanOrEqual(MAX_SEEK_READS)
      expect(inCluster(whole.clusters, exact.cursor.at), `at ${time}`).toBe(expected)
      const ahead = seek(index, bytes, time, { held: everything(bytes) })
      expect(ahead.cursor).toEqual(exact.cursor)
    }
  })
})

describe('seeking a large file with no Cues, by time (§10.4)', () => {
  // A file of gigabytes that is never built (`virtualFile`): a small real head, then clusters of 2 s each that begin with a picture keyframe, whose bytes are written when the seek asks for them. The index is the head's, with the Segment ending where the virtual file does.
  const MIB = 1024 * 1024
  const GIB = 1024 * MIB
  /** Where the time of the clusters is a cluster's index times this, in seconds. */
  const EACH = 2
  /** The targets, as shares of the file's length in time: eight for the file of the most care, and four of them (the hardest for the search: near the start, where it has no time to go by, and near the end) for the others, so that the matrix runs in a few seconds. */
  const SHARES = [0.03, 0.17, 0.33, 0.5, 0.61, 0.77, 0.9, 0.99]
  const FEW = [0.03, 0.33, 0.61, 0.99]
  /** The most reads for a seek when the file says the time of its end, and when it does not. */
  const MOST_TIMED = 24
  const MOST_UNTIMED = 36
  const MOST_UNEVEN = 30
  /** The most reads for a seek near the start of a file: the first cluster's time is known at once, so the time is the first guess's. */
  const MOST_NEAR_START = 6

  const head = matroskaFile(
    [
      info({ scale: 1_000_000 }),
      tracksElement([trackEntry(VP9)]),
      cluster(0, [simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [vp9Key(1)] })]),
    ],
    { unknown: true },
  )
  const opened = indexOf(head.bytes)
  const headBytes = head.bytes.subarray(0, opened.firstCluster)

  /** What the file says of its end: the last cluster, or only the duration, or nothing (the open found neither). */
  type Ends = 'cluster' | 'duration' | 'none'

  /** The virtual file of the clusters (cluster k is at `begin` + k * EACH s), and the index of it. */
  function large(
    sizes: readonly number[],
    ends: Ends,
    begin = 0,
  ): { file: VirtualFile; index: MatroskaIndex } {
    const file = virtualFile(
      headBytes,
      sizes.map((size, k) => ({ size, timestamp: 1000 * (begin + EACH * k) })),
    )
    const lastAt = file.starts[sizes.length - 1] ?? 0
    const index: MatroskaIndex = {
      ...opened,
      segment: { data: opened.segment.data, end: file.total },
      durationSeconds: ends === 'none' ? null : begin + EACH * sizes.length,
      lastCluster:
        ends === 'cluster'
          ? { start: lastAt, timestamp: 1000 * (begin + EACH * (sizes.length - 1)) }
          : null,
    }
    return { file, index }
  }

  /** A driven seek of the virtual file: nothing is held to start with, so the asks are the reads the seek counts. */
  function seekIn(index: MatroskaIndex, file: VirtualFile, time: number): Sought {
    const chunks: Chunk[] = []
    const asks: ByteRange[] = []
    for (let turn = 0; turn < TURNS; turn += 1) {
      const step = matroskaSeek(index, time, null, chunks)
      if ('done' in step) return { cursor: step.done, asks }
      const { start, end } = step.need
      expect(Number.isSafeInteger(start) && start >= index.segment.data && start < end).toBe(true)
      expect(end).toBeLessThanOrEqual(index.segment.end)
      expect(heldBytes(chunks, start, end)).toBeNull()
      asks.push(step.need)
      chunks.push({ start, bytes: file.bytes(step.need) })
    }
    throw new Error('the seek went on asking')
  }

  /** Seeks to each time (in seconds) and checks the landing: the latest cluster at or before the time. Gives the most asks of the seeks. */
  function seekTimes(
    sizes: readonly number[],
    ends: Ends,
    what: string,
    most: number,
    times: readonly number[],
  ): number {
    const { file, index } = large(sizes, ends)
    let widest = 0
    for (const time of times) {
      const expected = Math.min(Math.floor(time / EACH), sizes.length - 1)
      const { cursor, asks } = seekIn(index, file, time)
      widest = Math.max(widest, asks.length)
      expect(cursor.at, `${what} at ${time} s: ${asks.length} reads`).toBe(file.starts[expected])
      expect(cursor.searching).toBe(false)
      expect(cursor.cluster).toBeNull()
      expect(asks.length, `${what} at ${time} s`).toBeLessThanOrEqual(most)
    }
    return widest
  }

  /** Seeks to each share of the file's time (see `seekTimes`). */
  function seekAll(
    sizes: readonly number[],
    ends: Ends,
    what: string,
    most: number,
    shares: readonly number[] = FEW,
  ): number {
    const length = EACH * sizes.length
    return seekTimes(
      sizes,
      ends,
      what,
      most,
      shares.map((share) => share * length),
    )
  }

  /** The sizes of `count` clusters of `size` bytes each. */
  function even(gigabytes: number, size: number): number[] {
    return Array.from({ length: Math.floor((gigabytes * GIB) / size) }, () => size)
  }

  it('plays from a landing in a virtual file: the keyframes of its clusters are keyframes at the times given', () => {
    const sizes = Array.from({ length: 8 }, () => MIB)
    const { file, index } = large(sizes, 'cluster')
    const bytes = file.bytes({ start: 0, end: file.total })
    for (const [time, expected] of [
      [0.5, 0],
      [7.9, 3],
      [100, 7],
    ] as const) {
      const { cursor } = seekIn(index, file, time)
      expect(cursor.at).toBe(file.starts[expected])
      expect(landsBefore(index, bytes, cursor, time)).toBe(EACH * expected)
    }
  })

  for (const gigabytes of [4, 8, 16]) {
    for (const mib of [2.4, 5, 10]) {
      const size = Math.round(mib * MIB)
      // The file of 16 GB and 5 MiB clusters is sought at all eight targets.
      const shares = gigabytes === 16 && mib === 5 ? SHARES : FEW

      it(`lands at the latest cluster at or before the time in at most ${MOST_TIMED} reads, in ${gigabytes} GB of clusters of ${mib} MiB, with the last cluster known`, () => {
        const sizes = even(gigabytes, size)
        seekAll(sizes, 'cluster', `${gigabytes} GB, ${mib} MiB`, MOST_TIMED, shares)
      })

      it(`lands at the same cluster in at most ${MOST_UNTIMED} reads when the file says nothing of its end, in ${gigabytes} GB of clusters of ${mib} MiB`, () => {
        const sizes = even(gigabytes, size)
        seekAll(sizes, 'none', `${gigabytes} GB, ${mib} MiB, no end`, MOST_UNTIMED, shares)
      })
    }
  }

  it('lands at the same cluster in as few reads when only the duration says where the end is in time', () => {
    for (const mib of [2.4, 5, 10]) {
      const sizes = even(8, Math.round(mib * MIB))
      seekAll(sizes, 'duration', `8 GB, ${mib} MiB, duration`, MOST_TIMED)
    }
  })

  it(`lands right in at most ${MOST_NEAR_START} reads for 0 s, 0.5 s and 1% of the file, in 16 GB of clusters of 5 and of 10 MiB, with the last cluster known`, () => {
    for (const mib of [5, 10]) {
      const sizes = even(16, Math.round(mib * MIB))
      const percent = (EACH * sizes.length) / 100
      seekTimes(sizes, 'cluster', `16 GB, ${mib} MiB`, MOST_NEAR_START, [0, 0.5, percent])
    }
  })

  it("lands at the first cluster in two reads (the tail and the first cluster's header) for a time at or before it, and searches for a later time, when the first cluster is at 5 s", () => {
    const begin = 5
    const sizes = even(2, 3 * MIB)
    for (const ends of ['cluster', 'duration', 'none'] as const) {
      const { file, index } = large(sizes, ends, begin)
      for (const time of [-1, 0, 3, 4.99, 5]) {
        const { cursor, asks } = seekIn(index, file, time)
        expect(cursor.at, `${ends} at ${time} s`).toBe(file.first)
        expect(asks.length, `${ends} at ${time} s`).toBeLessThanOrEqual(2)
      }
      for (const [time, expected] of [
        [5.5, 0],
        [6.99, 0],
        [7, 1],
        [100, 47],
        [1e6, sizes.length - 1],
      ] as const) {
        const { cursor, asks } = seekIn(index, file, time)
        expect(cursor.at, `${ends} at ${time} s`).toBe(file.starts[expected])
        expect(asks.length, `${ends} at ${time} s`).toBeLessThanOrEqual(MOST_NEAR_START * 2)
      }
    }
  })

  it("searches as before, from the first cluster, when the bytes at the first cluster are no cluster's header", () => {
    // The index puts the first cluster 3 bytes into the real one, a damaged file's: its header reads as nothing, the first cluster has no time, and the search goes on by the byte until a guess finds a cluster.
    const sizes = even(2, 3 * MIB)
    const { file, index } = large(sizes, 'cluster')
    const damaged: MatroskaIndex = { ...index, firstCluster: file.first + 3 }
    for (const [time, expected] of [
      [3, 1],
      [100, 50],
      [1e6, sizes.length - 1],
    ] as const) {
      const { cursor, asks } = seekIn(damaged, file, time)
      expect(cursor.at, `at ${time} s`).toBe(file.starts[expected])
      expect(asks.length, `at ${time} s`).toBeLessThanOrEqual(MAX_SEEK_READS)
    }
  })

  it(`lands at the same cluster in at most ${MOST_UNEVEN} reads when the clusters differ in size and the time is not in proportion to the bytes`, () => {
    // 900 clusters of 1 to 1.5 MiB, then 700 of 3 to 6 MiB, from a sequence that is fixed: 2 s a cluster whatever the size.
    let state = 12345
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0
      return state / 2 ** 32
    }
    const sizes = [
      ...Array.from({ length: 900 }, () => Math.round((1 + 0.5 * next()) * MIB)),
      ...Array.from({ length: 700 }, () => Math.round((3 + 3 * next()) * MIB)),
    ]
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(3 * GIB)
    seekAll(sizes, 'cluster', 'uneven clusters', MOST_UNEVEN, SHARES)
    seekAll(sizes, 'none', 'uneven clusters, no end', MOST_UNTIMED, FEW)
  })
})
