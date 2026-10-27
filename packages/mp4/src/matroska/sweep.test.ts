import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import { framesIn, heldBytes, nextRead, openSource, seekCursor, startCursor } from '../source.ts'
import type { ByteRange, Chunk, Cursor, SourceIndex } from '../source.ts'
import { concat } from '../testing/build.ts'
import {
  cluster,
  info,
  matroskaFile,
  matroskaMovie,
  simpleBlock,
  trackEntry,
  tracksElement,
} from '../testing/ebml.ts'
import type { MovieCluster, MovieFrame, TrackSpec } from '../testing/ebml.ts'
import { MAX_INDEX_READS, MAX_SEEK_READS } from './limits.ts'

// Nothing hangs, and nothing but `Mp4Error` is thrown, for a Matroska file that is
// cut short or damaged (DESIGN.md §10.4, D45). Three files are built in code: B-frames
// and a laced AAC, a WebM of VP9 and Opus, and a recording that is still being
// written (nothing in it has a size). Each is run through the loop that step 5's
// engine runs, by the five functions that are the same for both containers: open
// the file, start at its beginning and read it through, then seek to three times
// (the start, the middle and past the end) and read on from each landing. The loop
// is run on every cut of the file (each length in the first 2 KiB, then every 97
// bytes) and on 2000 files with a byte of each changed, from a seeded generator. A
// file may be turned away at any point, but only as an `Mp4Error`, and the engine's
// reads are held to the rules on the way: every one lies inside the file and is
// never one that the caller holds, the open and each seek ask for no more than
// their caps, and every read of the file's frames reaches its end.

/** What a caller reads first, a megabyte (HEAD_BYTES, which a later task names). */
const HEAD = 1024 * 1024

/** The read that the engine starts with, 64 KiB from where the cursor says, doubled while a call gives nothing. */
const READ = 64 * 1024

/** The most calls of `framesIn` a file is let make: the files here take a handful. */
const CALLS = 10_000

/** The most turns an open or a seek is let make before it is called lost: far above the caps. */
const TURNS = 200

/** The reasons that a Matroska file is refused for: it has no picture, a track that no browser takes, or it is damaged. */
const REASONS: readonly string[] = ['no-picture', 'unsupported-codec', 'damaged']

// ---------------------------------------------------------------------------
// The files.

/** The `avcC` record of x264 for generated 320x240 pictures with B-frames (2026-10-25): `has_b_frames` 2, level 1.3. */
const X264_B_FRAMES =
  '0164000dffe100196764000dacd94141fb0110000003001000000303c0f142996001000668ebe3cb22c0fdf8f800'

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

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

const H264: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_MPEG4/ISO/AVC',
  codecPrivate: fromHex(X264_B_FRAMES),
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

const VP9: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_VP9',
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

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

/** A stereo AAC-LC sound at 48 kHz whose headers are stripped (ContentCompAlgo 3), as the derived corpus files have it. */
const AAC: TrackSpec = {
  number: 2,
  type: 2,
  codecId: 'A_AAC',
  codecPrivate: Uint8Array.of(0x11, 0x90),
  audio: { samplingFrequency: 48000, channels: 2 },
  encodings: [{ compression: { algo: 3, settings: Uint8Array.of(0xff, 0xf1) } }],
}

/** Bytes of a frame that no other frame has: its tag, then its length, then filling. */
function tagged(tag: number, size: number): Uint8Array {
  const out = new Uint8Array(size).fill(0x11)
  out[0] = tag & 0xff
  out[1] = size & 0xff
  return out
}

/** A keyframe of VP9 of this size: its header, then filling. */
function vp9Key(tag: number, size: number): Uint8Array {
  return concat(VP9_KEYFRAME, tagged(tag, size - VP9_KEYFRAME.length))
}

/** The frames of two tracks in the order they are decoded: by time, the picture's first on a tie. */
function merged(picture: MovieFrame[], sound: MovieFrame[]): MovieFrame[] {
  return [...picture, ...sound].sort((a, b) => a.time - b.time || a.track - b.track)
}

/**
 * x264's B-frames at 30 frames a second, presented in the orders that the
 * decoder sends them, and an AAC sound laced three frames to a block (Xiph's
 * lacing, one frame of 300 bytes so that a size takes a run of 255), with a SeekHead
 * and Cues that name the first and the third cluster.
 */
function bFramesWithLacedAac(): Uint8Array {
  const pictureTimes = [
    [0, 100, 33, 67],
    [233, 167, 133, 200],
    [267, 367, 300, 334, 500, 434, 400, 467],
  ]
  const soundTimes = [
    [0, 64],
    [128, 192],
    [256, 320, 384],
  ]
  const clusterTimes = [0, 133, 267]
  let pictureCount = 0
  let soundCount = 0
  const clusters = pictureTimes.map((times, which): MovieCluster => {
    const picture = times.map((time, at): MovieFrame => {
      const data = tagged(0x20 + pictureCount, 60 + 3 * pictureCount)
      pictureCount += 1
      return { track: 1, time, keyframe: at === 0 && which !== 1, data }
    })
    const sound = (soundTimes[which] ?? []).map((time): MovieFrame => {
      const laced = [0, 1, 2].map(() => {
        const frame = tagged(0x80 + soundCount, soundCount === 9 ? 300 : 40 + (soundCount % 5))
        soundCount += 1
        return frame
      })
      return { track: 2, time, keyframe: true, lace: { lacing: 'xiph', frames: laced } }
    })
    return { timestamp: clusterTimes[which] ?? 0, frames: merged(picture, sound) }
  })
  return matroskaMovie({
    duration: 4021,
    scale: 1_000_000,
    seek: true,
    tracks: [H264, AAC],
    clusters,
    cuePoints: (positions) => [
      { time: 0, track: 1, cluster: positions[0] ?? 0 },
      { time: 267, track: 1, cluster: positions[2] ?? 0 },
    ],
  }).bytes
}

/** The frames of one cluster of the WebM or the recording: eight pictures 33 ms apart and a sound of 20 ms frames, two to a block. */
function clusterOf(
  start: number,
  { laced, groups }: { laced: 'ebml' | 'fixed' | null; groups: boolean },
): MovieFrame[] {
  const picture = Array.from({ length: 8 }, (_, at): MovieFrame => {
    const time = start + Math.round(at * 33.3333)
    const data = at === 0 ? vp9Key(start / 1000, 90) : tagged(at, 60 + at)
    return {
      track: 1,
      time,
      keyframe: at === 0,
      data,
      ...(groups && at % 3 === 1 ? { duration: 33 } : {}),
    }
  })
  const sound = Array.from({ length: 6 }, (_, at): MovieFrame => {
    const time = start + at * 40
    if (laced === null) return { track: 2, time, keyframe: true, data: tagged(0x40 + at, 30 + at) }
    // 'fixed' needs equal sizes; 'ebml' takes any.
    const sizes = laced === 'fixed' ? [34, 34] : [30 + at, 40 - at]
    return {
      track: 2,
      time,
      keyframe: true,
      lace: { lacing: laced, frames: sizes.map((size, n) => tagged(0x50 + at * 2 + n, size)) },
    }
  })
  return merged(picture, sound)
}

/** A WebM of VP9 and Opus: a SeekHead, three clusters (one with block groups, ebml-laced sound) and Tags before them, and no Cues. */
function webmOfVp9AndOpus(): Uint8Array {
  return matroskaMovie({
    docType: 'webm',
    duration: 3300,
    scale: 1_000_000,
    seek: true,
    tags: [90],
    tracks: [VP9, OPUS],
    clusters: [
      { timestamp: 0, frames: clusterOf(0, { laced: 'ebml', groups: true }) },
      { timestamp: 1000, frames: clusterOf(1000, { laced: 'fixed', groups: false }) },
      { timestamp: 2000, frames: clusterOf(2000, { laced: null, groups: true }) },
    ],
  }).bytes
}

/** A recording that is still being written: the Segment and the Clusters have the unknown size, Info has no Duration, and there are no Cues. */
function liveRecording(): Uint8Array {
  const block = (frame: MovieFrame, start: number): Uint8Array =>
    simpleBlock({
      track: frame.track,
      timecode: frame.time - start,
      keyframe: frame.keyframe,
      frames: frame.lace === undefined ? [frame.data ?? new Uint8Array(8)] : frame.lace.frames,
      lacing: frame.lace?.lacing,
    })
  const parts = [
    info({ scale: 1_000_000 }),
    tracksElement([trackEntry(VP9), trackEntry(OPUS)]),
    ...[0, 1000, 2000].map((start) =>
      cluster(
        start,
        clusterOf(start, { laced: start === 1000 ? 'ebml' : null, groups: false }).map((frame) =>
          block(frame, start),
        ),
        { unknown: true },
      ),
    ),
  ]
  return matroskaFile(parts, { unknown: true }).bytes
}

// ---------------------------------------------------------------------------
// The loop.

/** What one run of the loop did, for the checks that it did something. */
interface Outcome {
  /** The file was opened. */
  opened: boolean
  /** The loop read the file through to the end: `nextRead` gave null. */
  played: boolean
  /** The frames given in all. */
  frames: number
  /** The seeks that gave a cursor, and the reads on from those cursors that reached the end. */
  seeks: number
  afterSeeks: number
}

/** An `Mp4Error` the reader gave for a file, which must be a refusal with a reason and a sentence. */
function refusal(error: Mp4Error): void {
  expect(REASONS).toContain(error.reason)
  expect(error.message).not.toBe('')
}

/** What `run` gives, or null if the reader turned the file away with an `Mp4Error`; anything else thrown goes on. */
function refused<T>(run: () => T): T | null {
  try {
    return run()
  } catch (error) {
    if (!(error instanceof Mp4Error)) throw error
    refusal(error)
    return null
  }
}

/**
 * Answers a range that the reader asked for, from the file's bytes, holding the
 * ask to the rules: it is a range of the file, it is not empty, and the chunks do
 * not hold it.
 */
function answer(chunks: Chunk[], bytes: Uint8Array, need: ByteRange): void {
  const { start, end } = need
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end) {
    throw new Error(`asked for ${start} to ${end}, which is no range`)
  }
  if (end > bytes.length)
    throw new Error(`asked for ${start} to ${end} of a file of ${bytes.length}`)
  if (heldBytes(chunks, start, end) !== null) throw new Error(`asked for ${start} to ${end}, held`)
  chunks.push({ start, bytes: bytes.subarray(start, end) })
}

/** Opens the file the way a caller does. Gives the index, or null when the file is turned away, and how many ranges it asked for. */
function open(bytes: Uint8Array): { index: SourceIndex | null; asks: number } {
  const chunks: Chunk[] = [{ start: 0, bytes: bytes.subarray(0, Math.min(HEAD, bytes.length)) }]
  let asks = 0
  for (let turn = 0; turn < TURNS; turn += 1) {
    const step = refused(() => openSource(chunks, bytes.length))
    if (step === null) return { index: null, asks }
    if ('done' in step) return { index: step.done, asks }
    answer(chunks, bytes, step.need)
    asks += 1
  }
  throw new Error(`the open went on asking after ${TURNS} turns`)
}

/**
 * Reads the file through from the cursor, as the engine does: from where `nextRead`
 * says, 64 KiB, doubled while a call leaves the cursor where it was and gives no
 * frame. A call that gives nothing when the chunk already reaches the file's end is
 * a hang, and is said at once. Gives the frames given, and whether the loop reached
 * the end (it did not when the reader turned the file away on the way).
 */
function play(
  index: SourceIndex,
  bytes: Uint8Array,
  state: Cursor,
): { frames: number; played: boolean } {
  const size = bytes.length
  let cursor = state
  let length = READ
  let frames = 0
  for (let call = 0; call < CALLS; call += 1) {
    const at = nextRead(index, cursor)
    if (at === null) return { frames, played: true }
    if (!Number.isSafeInteger(at) || at < 0 || at > size) {
      throw new Error(`nextRead gave ${at} for a file of ${size}`)
    }
    const end = Math.min(size, at + length)
    const given = refused(() =>
      framesIn(index, cursor, { start: at, bytes: bytes.subarray(at, end) }),
    )
    if (given === null) return { frames, played: false }
    for (const track of given.frames) {
      expect(track.table.count).toBeGreaterThan(0)
      for (let i = 0; i < track.table.count; i += 1) {
        const offset = track.table.offsets[i] ?? -1
        const frame = track.table.sizes[i] ?? -1
        if (offset < 0 || frame < 0 || offset + frame > size) {
          throw new Error(`a frame of ${frame} bytes at ${offset} is outside a file of ${size}`)
        }
      }
      frames += track.table.count
    }
    const next = nextRead(index, given.cursor)
    if (next !== null && next < at) throw new Error(`the cursor went back from ${at} to ${next}`)
    if (next === at && given.frames.length === 0) {
      if (end >= size)
        throw new Error(`a hang: nothing is given from ${at} with the file read to its end`)
      length *= 2
    } else {
      length = READ
    }
    cursor = given.cursor
  }
  throw new Error(`the loop did not reach the end in ${CALLS} calls`)
}

/** Seeks to `seconds` the way a caller does, from the head alone. Gives the cursor, or null when the file is turned away, and how many ranges it asked for. */
function seek(
  index: SourceIndex,
  bytes: Uint8Array,
  seconds: number,
): { cursor: Cursor | null; asks: number } {
  const sound = index.sound?.header.id ?? null
  const chunks: Chunk[] = [{ start: 0, bytes: bytes.subarray(0, Math.min(HEAD, bytes.length)) }]
  let asks = 0
  for (let turn = 0; turn < TURNS; turn += 1) {
    const step = refused(() => seekCursor(index, seconds, sound, chunks))
    if (step === null) return { cursor: null, asks }
    if ('done' in step) return { cursor: step.done, asks }
    answer(chunks, bytes, step.need)
    asks += 1
  }
  throw new Error(`the seek went on asking after ${TURNS} turns`)
}

/** The loop for one file: open it, read it through, seek to three times and read on from each landing. Throws for anything but an `Mp4Error`, and for a rule broken. */
function run(bytes: Uint8Array): Outcome {
  const { index, asks } = open(bytes)
  const outcome: Outcome = { opened: false, played: false, frames: 0, seeks: 0, afterSeeks: 0 }
  // The cap holds for a file that is turned away too, after however many ranges it asked for.
  if (asks > MAX_INDEX_READS) throw new Error(`the open asked for ${asks} ranges after the head`)
  if (index === null) return outcome
  outcome.opened = true

  const sound = index.sound?.header.id ?? null
  const start = refused(() => startCursor(index, sound))
  if (start !== null) {
    const read = play(index, bytes, start)
    outcome.played = read.played
    outcome.frames = read.frames
  }

  const end = index.durationSeconds ?? 10
  for (const seconds of [0, end / 2, end + 100]) {
    const sought = seek(index, bytes, seconds)
    if (sought.asks > MAX_SEEK_READS) {
      throw new Error(`the seek to ${seconds} s asked for ${sought.asks} ranges`)
    }
    if (sought.cursor === null) continue
    outcome.seeks += 1
    // The cursor that a seek gives is one that can be read on from, to the end.
    const after = play(index, bytes, sought.cursor)
    if (after.played) outcome.afterSeeks += 1
  }
  return outcome
}

/** A generator of numbers in [0, 1) from a seed (mulberry32): the same mutations on every run and every machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** The lengths a file is cut at: every length in the first 2 KiB, then one every 97 bytes, and the whole file is not among them. */
function cuts(size: number): number[] {
  const out: number[] = []
  for (let length = 0; length < Math.min(size, 2048); length += 1) out.push(length)
  for (let length = 2048; length < size; length += 97) out.push(length)
  return out
}

const FILES: { name: string; bytes: Uint8Array }[] = [
  { name: 'B-frames and laced AAC', bytes: bFramesWithLacedAac() },
  { name: 'WebM of VP9 and Opus', bytes: webmOfVp9AndOpus() },
  { name: 'recording of unknown sizes', bytes: liveRecording() },
]

/** The runs of a file and what became of them, for the checks that the sweep did something. */
interface Totals {
  runs: number
  opened: number
  played: number
  seeked: number
  afterSeeks: number
}

/** Runs the loop on every file `files` gives; every failure is in the list, named by what was done to the file. */
function sweep(
  files: { label: string; bytes: Uint8Array }[],
  failures: string[],
  totals: Totals,
): void {
  for (const { label, bytes } of files) {
    totals.runs += 1
    try {
      const outcome = run(bytes)
      if (outcome.opened) totals.opened += 1
      if (outcome.played) totals.played += 1
      if (outcome.seeks > 0) totals.seeked += 1
      if (outcome.afterSeeks > 0) totals.afterSeeks += 1
    } catch (error) {
      failures.push(
        `${label}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      )
    }
  }
}

describe('a Matroska file that is cut short or damaged (§10.4)', () => {
  for (const { name, bytes } of FILES) {
    describe(name, () => {
      it('is a file that opens, plays through to its end and seeks, before it is cut or changed', () => {
        const outcome = run(bytes)
        expect(outcome.opened).toBe(true)
        expect(outcome.played).toBe(true)
        expect(outcome.frames).toBeGreaterThan(8)
        expect(outcome.seeks).toBe(3)
        expect(outcome.afterSeeks).toBe(3)
        expect(bytes.length).toBeGreaterThan(2048)
      })

      it('throws nothing but Mp4Error, hangs nowhere and keeps to its reads, cut at every length', () => {
        const failures: string[] = []
        const totals: Totals = { runs: 0, opened: 0, played: 0, seeked: 0, afterSeeks: 0 }
        sweep(
          cuts(bytes.length).map((length) => ({
            label: `cut to ${length} of ${bytes.length}`,
            bytes: bytes.subarray(0, length),
          })),
          failures,
          totals,
        )
        expect(failures.slice(0, 10)).toEqual([])
        // The sweep is not empty: files cut late enough still open and play, and the cuts before the first cluster are turned away.
        expect(totals.opened).toBeGreaterThan(totals.runs / 4)
        expect(totals.opened).toBeLessThan(totals.runs)
        expect(totals.played).toBeGreaterThan(totals.runs / 4)
        expect(totals.afterSeeks).toBeGreaterThan(totals.runs / 4)
      }, 120_000)

      it('throws nothing but Mp4Error, hangs nowhere and keeps to its reads, with a byte changed', () => {
        const failures: string[] = []
        const totals: Totals = { runs: 0, opened: 0, played: 0, seeked: 0, afterSeeks: 0 }
        const next = generator(0x5eed + bytes.length)
        const changed = Array.from({ length: 2000 }, () => {
          const at = Math.floor(next() * bytes.length)
          const copy = bytes.slice()
          copy[at] = (copy[at] ?? 0) ^ (1 + Math.floor(next() * 255))
          return { label: `byte ${at} of ${bytes.length} changed to ${copy[at]}`, bytes: copy }
        })
        sweep(changed, failures, totals)
        expect(failures.slice(0, 10)).toEqual([])
        // Most changes are to a frame's bytes or to something the reader skips, and the file still plays.
        expect(totals.opened).toBeGreaterThan(totals.runs / 2)
        expect(totals.played).toBeGreaterThan(totals.runs / 2)
        expect(totals.seeked).toBeGreaterThan(totals.runs / 2)
        expect(totals.afterSeeks).toBeGreaterThan(totals.runs / 2)
      }, 120_000)
    })
  }
})
