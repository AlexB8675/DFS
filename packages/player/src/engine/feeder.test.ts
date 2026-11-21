import type { ByteRange } from '@dfs/mp4'
import {
  audioEntry,
  avcC,
  box,
  cluster,
  concat,
  ctts,
  cues,
  esds,
  fourcc,
  info,
  matroskaFile,
  matroskaMovie,
  movie,
  seekHead,
  simpleBlock,
  stco,
  stsc,
  stss,
  stsz,
  stts,
  trackEntry,
  tracksElement,
  u32,
  visualEntry,
} from '@dfs/mp4/testing'
import type { EbmlTrackSpec, FilePart, MovieFrame, TrackSpec } from '@dfs/mp4/testing'
import type { TimelineEventInput } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { CHUNK_BYTES, HEAD_BYTES, MAX_CHUNK_BYTES, TAIL_BYTES } from '../limits.ts'
import { Feeder } from './feeder.ts'
import type { Sink } from './feeder.ts'
import type { ByteSource } from './source.ts'
import type { ChosenTracks } from './tracks.ts'
import type { FedRun } from './window.ts'

// The feeder (DESIGN.md §10.4): opens a file through a byte source, seeks it and
// feeds fragments to a sink. Every file is built in code; the source holds it in
// memory and notes what it is asked, and the sink notes what it is given.

const MIB = 1024 * 1024

// ---------------------------------------------------------------------------
// What stands in for the store and for the SourceBuffers

type Note =
  | { op: 'fetchNow'; start: number; end: number; signal: AbortSignal | undefined }
  | { op: 'read'; start: number; end: number; signal: AbortSignal | undefined }
  | { op: 'setPosition'; offset: number }

class MemorySource implements ByteSource {
  readonly notes: Note[] = []
  readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get fileSize(): number {
    return this.bytes.length
  }

  get reads(): ByteRange[] {
    return this.notes.flatMap((note) =>
      note.op === 'read' ? [{ start: note.start, end: note.end }] : [],
    )
  }

  /** Answers a read in place of the file: a promise to give (a failure, a read that never ends), or nothing to let it through. */
  intercept: ((range: ByteRange) => Promise<Uint8Array> | undefined) | null = null

  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    this.notes.push({ op: 'read', start: range.start, end: range.end, signal })
    const taken = this.intercept?.(range)
    if (taken !== undefined) return taken
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error)
    return Promise.resolve(this.bytes.subarray(range.start, Math.min(range.end, this.fileSize)))
  }

  fetchNow(range: ByteRange, signal?: AbortSignal): Promise<void> {
    this.notes.push({ op: 'fetchNow', start: range.start, end: range.end, signal })
    return Promise.resolve()
  }

  setPosition(offset: number): void {
    this.notes.push({ op: 'setPosition', offset })
  }
}

type SinkNote =
  | { op: 'init'; tracks: ChosenTracks }
  | { op: 'append'; kind: 'video' | 'audio'; bytes: Uint8Array; run: FedRun }

class RecordingSink implements Sink {
  readonly notes: SinkNote[] = []
  /** Called after each append is noted. */
  afterAppend: (() => void) | null = null

  init(tracks: ChosenTracks): Promise<void> {
    this.notes.push({ op: 'init', tracks })
    return Promise.resolve()
  }

  append(kind: 'video' | 'audio', bytes: Uint8Array, run: FedRun): Promise<void> {
    this.notes.push({ op: 'append', kind, bytes, run })
    this.afterAppend?.()
    return Promise.resolve()
  }

  get inits(): ChosenTracks[] {
    return this.notes.flatMap((note) => (note.op === 'init' ? [note.tracks] : []))
  }

  appended(kind?: 'video' | 'audio'): { bytes: Uint8Array; run: FedRun }[] {
    return this.notes.flatMap((note) =>
      note.op === 'append' && (kind === undefined || note.kind === kind)
        ? [{ bytes: note.bytes, run: note.run }]
        : [],
    )
  }
}

const SUPPORTED = (): boolean => true

/** Whether two arrays of bytes are the same: `toEqual` takes seconds over megabytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0
}

function errorsOf(events: TimelineEventInput[]): string[] {
  return events.flatMap((event) => (event.type === 'error' ? [event.message] : []))
}

/** What a fragment says: its sequence, track, first decode time, each frame's duration, and the bytes of its `mdat`. */
function look(bytes: Uint8Array): {
  sequence: number
  track: number
  decode: number
  durations: number[]
  payload: Uint8Array
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const walk = (from: number, to: number): { type: string; start: number; end: number }[] => {
    const found: { type: string; start: number; end: number }[] = []
    for (let at = from; at < to;) {
      const size = view.getUint32(at)
      found.push({
        type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
        start: at,
        end: at + size,
      })
      at += size
    }
    return found
  }
  const [moof, mdat] = walk(0, bytes.length)
  if (moof === undefined || mdat === undefined) throw new Error('not a fragment')
  const inner = walk(moof.start + 8, moof.end)
  const mfhd = inner.find((one) => one.type === 'mfhd')
  const traf = inner.find((one) => one.type === 'traf')
  if (mfhd === undefined || traf === undefined) throw new Error('no mfhd or traf')
  const parts = walk(traf.start + 8, traf.end)
  const tfhd = parts.find((one) => one.type === 'tfhd')
  const tfdt = parts.find((one) => one.type === 'tfdt')
  const trun = parts.find((one) => one.type === 'trun')
  if (tfhd === undefined || tfdt === undefined || trun === undefined) throw new Error('no parts')
  const count = view.getUint32(trun.start + 12)
  const durations: number[] = []
  for (let i = 0; i < count; i += 1) durations.push(view.getUint32(trun.start + 20 + i * 16))
  return {
    sequence: view.getUint32(mfhd.start + 12),
    track: view.getUint32(tfhd.start + 12),
    decode: Number(view.getBigUint64(tfdt.start + 12)),
    durations,
    payload: bytes.subarray(mdat.start + 8, mdat.end),
  }
}

// ---------------------------------------------------------------------------
// MP4 files

interface Media {
  count: number
  timescale: number
  /** The duration of every frame, in ticks. */
  duration: number
  size: (index: number) => number
  /** Every this many frames is a keyframe (a picture only). */
  keyEvery?: number
  /** Each frame's composition offset in ticks (a picture only), 0 when not given. */
  cts?: (index: number) => number
}

/** A frame's bytes: its track, its index, and a fill that tells it apart. */
function frameData(track: 'v' | 'a', index: number, size: number): Uint8Array {
  const out = new Uint8Array(size).fill((index * 7 + (track === 'v' ? 1 : 2)) & 255)
  return out
}

const PICTURE = visualEntry('avc1', {}, avcC())
const AAC = audioEntry('mp4a', {}, esds())

interface Mp4Built {
  bytes: Uint8Array
  video: { offset: number; size: number }[]
  audio: { offset: number; size: number }[]
}

function mp4File(options: {
  video: Media
  audio?: Media
  layout?: 'interleaved' | 'video-first' | 'audio-first'
  moov?: 'start' | 'end'
  padding?: number
}): Mp4Built {
  const { video, audio, layout = 'interleaved', moov = 'start', padding = 0 } = options
  const order: { track: 'v' | 'a'; index: number; time: number }[] = []
  for (let i = 0; i < video.count; i += 1) {
    order.push({ track: 'v', index: i, time: (i * video.duration) / video.timescale })
  }
  if (audio) {
    for (let i = 0; i < audio.count; i += 1) {
      order.push({ track: 'a', index: i, time: (i * audio.duration) / audio.timescale })
    }
  }
  if (layout === 'interleaved') {
    order.sort((a, b) => a.time - b.time || (a.track === 'v' ? -1 : 1) - (b.track === 'v' ? -1 : 1))
  } else {
    const first = layout === 'video-first' ? 'v' : 'a'
    order.sort((a, b) => (a.track === b.track ? a.index - b.index : a.track === first ? -1 : 1))
  }

  const ftyp = box('ftyp', fourcc('isom'), u32(0), fourcc('isom'))
  const tracksOf = (offsets: { video: number[]; audio: number[] }): TrackSpec[] => {
    const make = (
      media: Media,
      at: number[],
      id: number,
      handler: string,
      entry: Uint8Array,
      keys: boolean,
    ): TrackSpec => ({
      id,
      handler,
      timescale: media.timescale,
      entries: [entry],
      tables: [
        stts([[media.count, media.duration]]),
        stsz(Array.from({ length: media.count }, (_, i) => media.size(i))),
        stsc([[1, 1]]),
        stco(at),
        ...(media.cts === undefined
          ? []
          : [
              ctts(
                0,
                Array.from({ length: media.count }, (_, i) => [1, media.cts?.(i) ?? 0] as const),
              ),
            ]),
        ...(keys
          ? [
              stss(
                Array.from({ length: media.count }, (_, i) => i)
                  .filter((i) => i % (media.keyEvery ?? 1) === 0)
                  .map((i) => i + 1),
              ),
            ]
          : []),
      ],
    })
    return [
      make(video, offsets.video, 1, 'vide', PICTURE, true),
      ...(audio ? [make(audio, offsets.audio, 2, 'soun', AAC, false)] : []),
    ]
  }
  const zeros = {
    video: new Array<number>(video.count).fill(0),
    audio: new Array<number>(audio?.count ?? 0).fill(0),
  }
  const moovLength = movie({ timescale: 1000, tracks: tracksOf(zeros) }).length
  const dataStart =
    ftyp.length + (moov === 'start' ? moovLength : 0) + 8 /* the mdat's header */ + padding

  const placed = {
    video: [] as { offset: number; size: number }[],
    audio: [] as { offset: number; size: number }[],
  }
  const pieces: Uint8Array[] = []
  let at = dataStart
  for (const { track, index } of order) {
    const media = track === 'v' ? video : audio
    if (media === undefined) continue
    const size = media.size(index)
    placed[track === 'v' ? 'video' : 'audio'][index] = { offset: at, size }
    pieces.push(frameData(track, index, size))
    at += size
  }
  const moovBytes = movie({
    timescale: 1000,
    tracks: tracksOf({
      video: placed.video.map((one) => one.offset),
      audio: placed.audio.map((one) => one.offset),
    }),
  })
  // Written by hand: a hundred thousand pieces are too many arguments for `box`.
  const length = pieces.reduce((sum, piece) => sum + piece.length, 8 + padding)
  const mdat = new Uint8Array(length)
  new DataView(mdat.buffer).setUint32(0, length)
  mdat.set(fourcc('mdat'), 4)
  let written = 8 + padding
  for (const piece of pieces) {
    mdat.set(piece, written)
    written += piece.length
  }
  const bytes = moov === 'start' ? concat(ftyp, moovBytes, mdat) : concat(ftyp, mdat, moovBytes)
  return { bytes, ...placed }
}

/** A picture of 30 frames a second with a keyframe each second, and a sound of 48 kHz frames of 1024 samples, 5 s each. */
function interleaved(
  layout: 'interleaved' | 'video-first' | 'audio-first' = 'interleaved',
): Mp4Built {
  return mp4File({
    video: { count: 150, timescale: 30000, duration: 1000, size: () => 20_000, keyEvery: 30 },
    audio: { count: 235, timescale: 48000, duration: 1024, size: () => 300 },
    layout,
  })
}

async function open(
  bytes: Uint8Array,
  isTypeSupported: (mime: string) => boolean = SUPPORTED,
  options: { cacheBytes?: number; prepare?: (source: MemorySource) => void } = {},
): Promise<{ feeder: Feeder; source: MemorySource; events: TimelineEventInput[] }> {
  const source = new MemorySource(bytes)
  options.prepare?.(source)
  const events: TimelineEventInput[] = []
  const feeder = await Feeder.open(
    source,
    isTypeSupported,
    (event) => events.push(event),
    options.cacheBytes === undefined ? {} : { cacheBytes: options.cacheBytes },
  )
  return { feeder, source, events }
}

/** Feeds until the file ends, or `until` is reached, and gives the answer. */
async function feedAll(
  feeder: Feeder,
  sink: Sink,
  until = Infinity,
  signal = new AbortController().signal,
): Promise<'more' | 'ended'> {
  return feeder.feed(until, sink, signal)
}

// ---------------------------------------------------------------------------
// Opening

describe('opening a file', () => {
  it('reads the head and the tail at once, and an MP4 with its moov at the end needs nothing more', async () => {
    const built = mp4File({
      video: { count: 40, timescale: 30000, duration: 1000, size: () => 100_000, keyEvery: 10 },
      moov: 'end',
    })
    expect(built.bytes.length).toBeGreaterThan(HEAD_BYTES + TAIL_BYTES)
    const { feeder, source } = await open(built.bytes)
    const size = built.bytes.length
    // The tail is asked for at once (fetchNow), and the reader's need for the moov is one plain read of it.
    expect(source.reads).toHaveLength(2)
    expect(source.reads[0]).toEqual({ start: 0, end: HEAD_BYTES })
    expect(source.reads[1]?.end).toBe(size)
    expect(source.reads[1]?.start).toBeGreaterThanOrEqual(size - TAIL_BYTES)
    const fetched = source.notes.flatMap((note) => (note.op === 'fetchNow' ? [note] : []))
    expect(fetched.map((note) => note.start)).toEqual([0, size - TAIL_BYTES])
    // Both are asked for before either is waited for.
    const firstRead = source.notes.findIndex((note) => note.op === 'read')
    expect(source.notes.slice(0, firstRead).map((note) => note.op)).toEqual([
      'fetchNow',
      'fetchNow',
    ])
    expect(feeder.durationSeconds).not.toBeNull()
    expect(feeder.index.container).toBe('mp4')
    expect(feeder.tracks.audio).toBeNull()
  })

  it('reads the moov over a megabyte as one read that overlaps the tail', async () => {
    // Over 140 000 frames of one byte each: a moov of 1.1 MB at the end, behind 3 MiB of padding.
    const built = mp4File({
      video: { count: 140_000, timescale: 30000, duration: 1000, size: () => 1, keyEvery: 30 },
      moov: 'end',
      padding: 3 * MIB,
    })
    const { source } = await open(built.bytes)
    expect(source.reads).toHaveLength(2)
    expect(source.reads[0]).toEqual({ start: 0, end: HEAD_BYTES })
    expect(source.reads[1]?.start).toBeLessThan(built.bytes.length - TAIL_BYTES)
  })

  it('reads a small file whole as its head, with no tail beyond it', async () => {
    const built = mp4File({
      video: { count: 10, timescale: 30000, duration: 1000, size: () => 100, keyEvery: 5 },
    })
    const { source } = await open(built.bytes)
    expect(source.reads).toEqual([{ start: 0, end: built.bytes.length }])
  })

  it('rejects with the sentence when no name of the picture is taken, and logs it', async () => {
    const built = interleaved()
    const events: TimelineEventInput[] = []
    const source = new MemorySource(built.bytes)
    const refused = await Feeder.open(
      source,
      () => false,
      (event) => events.push(event),
    ).catch((error: unknown) => error)
    expect(refused).toMatchObject({ reason: 'codec' })
    const { refusal } = refused as { refusal: string }
    expect(refusal).toMatch(/Media Source takes none of/)
    expect(errorsOf(events)).toEqual([refusal])
    expect(events[0]).toMatchObject({ type: 'error', from: 'engine', code: null })
  })

  it("rejects with the reader's sentence for a file it turns away, and logs it", async () => {
    const events: TimelineEventInput[] = []
    const source = new MemorySource(new Uint8Array(100).fill(7))
    const refused = await Feeder.open(source, SUPPORTED, (event) => events.push(event)).catch(
      (error: unknown) => error,
    )
    expect(refused).toMatchObject({ reason: 'damaged' })
    expect(errorsOf(events)).toEqual([(refused as { refusal: string }).refusal])
  })
})

// ---------------------------------------------------------------------------
// Feeding an MP4

describe('feeding an MP4 (§10.4)', () => {
  it('feeds fragments in time order, each of at most a second, and says where each lies', async () => {
    const built = interleaved()
    const { feeder } = await open(built.bytes)
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink, 3)).toBe('more')
    expect(sink.inits).toHaveLength(1)
    expect(sink.inits[0]?.audio).not.toBeNull()

    const video = sink.appended('video')
    const audio = sink.appended('audio')
    expect(video.length).toBeGreaterThanOrEqual(3)
    expect(audio.length).toBeGreaterThanOrEqual(3)
    for (const kind of [video, audio]) {
      kind.forEach(({ run }, i) => {
        expect(run.end - run.start).toBeLessThanOrEqual(1 + 1e-9)
        const before = kind[i - 1]
        if (before) expect(run.start).toBeGreaterThanOrEqual(before.run.end - 1e-9)
      })
    }
    // The first picture fragment starts at a keyframe, and a run's keyframe is its first frame's sync flag.
    expect(video[0]?.run.keyframe).toBe(true)
    for (const { run } of video) {
      const first = Math.round(run.start * 30)
      expect(run.keyframe).toBe(first % 30 === 0)
    }
    // Both are fed up to the time, the picture at least to it.
    expect(video.at(-1)?.run.end).toBeGreaterThanOrEqual(3 - 1e-9)

    // Sequence numbers count from 1 for each track.
    expect(video.map(({ bytes }) => look(bytes).sequence)).toEqual(video.map((_, i) => i + 1))
    expect(audio.map(({ bytes }) => look(bytes).sequence)).toEqual(audio.map((_, i) => i + 1))
    expect(look(video[0]?.bytes ?? new Uint8Array()).track).toBe(1)
    expect(look(audio[0]?.bytes ?? new Uint8Array()).track).toBe(2)
  })

  it('records where each run lies, and the picture answers for a time', async () => {
    const built = interleaved()
    const { feeder } = await open(built.bytes)
    await feedAll(feeder, new RecordingSink(), 3)
    expect(feeder.positions.offsetAt(0)).toBe(built.video[0]?.offset)
    // The second second starts at frame 30.
    expect(feeder.positions.offsetAt(1.2)).toBeGreaterThanOrEqual(
      built.video[30]?.offset ?? Infinity,
    )
    expect(feeder.positions.offsetAt(1.2)).toBeLessThanOrEqual(built.video[36]?.offset ?? 0)
  })

  it("feeds every frame once to the end, and says 'ended'", async () => {
    const built = interleaved()
    const { feeder } = await open(built.bytes)
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink)).toBe('ended')
    const video = concat(...sink.appended('video').map(({ bytes }) => look(bytes).payload))
    const expected = concat(...built.video.map((one, i) => frameData('v', i, one.size)))
    expect(same(video, expected)).toBe(true)
    const audio = concat(...sink.appended('audio').map(({ bytes }) => look(bytes).payload))
    expect(same(audio, concat(...built.audio.map((one, i) => frameData('a', i, one.size))))).toBe(
      true,
    )
    // And it stays ended.
    expect(await feedAll(feeder, sink)).toBe('ended')
  })

  it('keeps decode times continuous across the edge of a chunk', async () => {
    // 20 KB frames: a chunk of a mebibyte holds about 50, and a second is 30.
    const built = interleaved()
    const { feeder, source } = await open(built.bytes)
    const sink = new RecordingSink()
    await feedAll(feeder, sink)
    expect(source.reads.some((read) => read.start > 0)).toBe(true)
    const video = sink.appended('video').map(({ bytes }) => look(bytes))
    video.forEach((fragment, i) => {
      const before = video[i - 1]
      if (before === undefined) return
      const end = before.decode + before.durations.reduce((sum, ticks) => sum + ticks, 0)
      expect(fragment.decode).toBe(end)
    })
  })

  it('reads in chunks that stay bounded and feeds a sound that lies after the picture, in step', async () => {
    const built = interleaved('video-first')
    expect(built.audio[0]?.offset ?? 0).toBeGreaterThan(built.video.at(-1)?.offset ?? 0)
    const { feeder, source } = await open(built.bytes)
    const sink = new RecordingSink()
    await feedAll(feeder, sink, 2)
    const audio = sink.appended('audio')
    expect(audio.length).toBeGreaterThan(0)
    expect(audio[0]?.run.start).toBeCloseTo(0, 6)
    expect(sink.inits[0]?.audio).not.toBeNull()
    expect(sink.appended('video').at(-1)?.run.end).toBeGreaterThanOrEqual(2 - 1e-9)
    // After the open's head and tail, no read is bigger than a chunk.
    for (const read of source.reads.slice(2)) {
      expect(read.end - read.start).toBeLessThanOrEqual(CHUNK_BYTES)
    }
  })

  it('feeds a sound that lies before the picture too', async () => {
    const built = interleaved('audio-first')
    const { feeder } = await open(built.bytes)
    const sink = new RecordingSink()
    await feedAll(feeder, sink, 2)
    expect(sink.appended('audio').length).toBeGreaterThan(0)
    expect(sink.appended('video').at(-1)?.run.end).toBeGreaterThanOrEqual(2 - 1e-9)
  })

  it('answers a frame over 32 MiB with a damaged-file error that names the bound, and logs it', async () => {
    const built = mp4File({
      video: {
        count: 2,
        timescale: 30000,
        duration: 1000,
        size: (i) => (i === 0 ? 33 * MIB : 100),
        keyEvery: 1,
      },
    })
    const { feeder, source, events } = await open(built.bytes)
    const failed = await feedAll(feeder, new RecordingSink()).catch((error: unknown) => error)
    expect(failed).toMatchObject({ name: 'Mp4Error', reason: 'damaged' })
    const offset = built.video[0]?.offset ?? 0
    expect((failed as Error).message).toBe(
      `No frame completes within 32 MiB from offset ${offset}.`,
    )
    expect(errorsOf(events)).toEqual([(failed as Error).message])
    // 1, 2, 4, 8, 16 and 32 MiB, each read from the frame's own offset.
    const frameReads = source.reads.filter((read) => read.start === offset)
    expect(frameReads.map((read) => read.end - read.start)).toEqual([
      CHUNK_BYTES,
      2 * MIB,
      4 * MIB,
      8 * MIB,
      16 * MIB,
      MAX_CHUNK_BYTES,
    ])
  })
})

describe('seeking an MP4 (§10.4)', () => {
  it('starts the picture at the keyframe and the sound at the frame that covers it, and moves the position', async () => {
    const built = interleaved()
    const { feeder, source } = await open(built.bytes)
    await feeder.seek(2.5, new AbortController().signal)
    const set = source.notes.filter((note) => note.op === 'setPosition')
    // The download follows the picture (R42): the sound frame that covers 2.0 s lies before the keyframe, and the
    // position is still the keyframe's. The sound's chunk is read by the feeder's own read.
    expect(built.audio[93]?.offset ?? Infinity).toBeLessThan(built.video[60]?.offset ?? 0)
    expect(set).toEqual([{ op: 'setPosition', offset: built.video[60]?.offset }])
    const sink = new RecordingSink()
    await feedAll(feeder, sink, 3.5)
    const video = sink.appended('video')
    const audio = sink.appended('audio')
    expect(video[0]?.run.start).toBeCloseTo(2, 6)
    expect(video[0]?.run.keyframe).toBe(true)
    // The frame at 1.984 s covers 2.0 s: it starts at or before the keyframe and lasts past it.
    const start = audio[0]?.run.start ?? NaN
    expect(start).toBeLessThanOrEqual(2 + 1e-9)
    expect(start).toBeGreaterThan(2 - 1024 / 48000 - 1e-9)
  })

  it('goes on from the sequence numbers it had', async () => {
    const built = interleaved()
    const { feeder } = await open(built.bytes)
    const sink = new RecordingSink()
    await feedAll(feeder, sink, 1)
    const count = sink.appended('video').length
    await feeder.seek(3, new AbortController().signal)
    await feedAll(feeder, sink, 4)
    const after = sink.appended('video').slice(count)
    expect(look(after[0]?.bytes ?? new Uint8Array()).sequence).toBe(count + 1)
  })
})

// ---------------------------------------------------------------------------
// Matroska

const VP9_KEY = Uint8Array.of(0x82, 0x49, 0x83, 0x42, 0x00)

const WEBM_VIDEO: EbmlTrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_VP9',
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

const OPUS_HEAD = Uint8Array.of(
  ...Array.from('OpusHead', (letter) => letter.charCodeAt(0)),
  ...[1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0],
)

const WEBM_OPUS: EbmlTrackSpec = {
  number: 2,
  type: 2,
  codecId: 'A_OPUS',
  codecPrivate: OPUS_HEAD,
  codecDelay: 6_500_000,
  seekPreRoll: 80_000_000,
  defaultDuration: 20_000_000,
  audio: { samplingFrequency: 48000, channels: 2 },
}

/** The bytes of a picture frame of a WebM: a keyframe starts with a VP9 keyframe's header. */
function pictureFrame(index: number, size: number, key: boolean): Uint8Array {
  const data = new Uint8Array(size).fill((index + 1) & 255)
  if (key) data.set(VP9_KEY)
  return data
}

/** A WebM of `seconds` clusters, each of 30 pictures of `size` bytes and, from the second `soundFrom`, 50 sound frames. */
function webm(options: { seconds: number; size: number; soundFrom?: number | null }): {
  bytes: Uint8Array
  pictures: Uint8Array[]
  clusters: { start: number; end: number }[]
} {
  const { seconds, size, soundFrom = 0 } = options
  const pictures: Uint8Array[] = []
  const clusters = Array.from({ length: seconds }, (_, second) => {
    const frames: MovieFrame[] = []
    for (let i = 0; i < 30; i += 1) {
      const index = second * 30 + i
      const data = pictureFrame(index, size, i === 0)
      pictures.push(data)
      frames.push({
        track: 1,
        time: second * 1000 + Math.round((i * 1000) / 30),
        keyframe: i === 0,
        data,
      })
      if (soundFrom !== null && second >= soundFrom && i < 25) {
        for (const j of [0, 1]) {
          frames.push({ track: 2, time: second * 1000 + i * 40 + j * 20, keyframe: true })
        }
      }
    }
    return { timestamp: second * 1000, frames }
  })
  const file = matroskaMovie({
    docType: 'webm',
    scale: 1_000_000,
    duration: seconds * 1000,
    tracks: [WEBM_VIDEO, WEBM_OPUS],
    clusters,
  })
  return { bytes: file.bytes, pictures, clusters: file.clusters }
}

describe('feeding a Matroska file (§10.4)', () => {
  it("feeds every picture once, in order, to the end, and says 'ended'", async () => {
    const { bytes, pictures } = webm({ seconds: 4, size: 30_000 })
    const { feeder, source } = await open(bytes)
    expect(feeder.index.container).toBe('matroska')
    expect(feeder.durationSeconds).toBeCloseTo(4, 6)
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink)).toBe('ended')
    expect(sink.inits).toHaveLength(1)
    expect(sink.inits[0]?.audio).not.toBeNull()
    const video = sink.appended('video')
    const payload = concat(...video.map(({ bytes: fragment }) => look(fragment).payload))
    expect(same(payload, concat(...pictures))).toBe(true)
    for (const { run } of video) expect(run.end - run.start).toBeLessThanOrEqual(1 + 1e-9)
    expect(video[0]?.run.keyframe).toBe(true)
    expect(source.reads.length).toBeGreaterThan(2)
  })

  it('writes a fragment from bytes of an earlier chunk when its frames lie in one', async () => {
    // Frames of 400 KB with no BlockDuration: a frame waits for the next to say how long it lasts, so
    // a table of a later chunk holds a frame whose bytes lie in the one before.
    const frames: MovieFrame[] = []
    const pictures: Uint8Array[] = []
    for (let i = 0; i < 10; i += 1) {
      const data = pictureFrame(i, 400_000, i === 0)
      pictures.push(data)
      frames.push({ track: 1, time: Math.round((i * 1000) / 30), keyframe: i === 0, data })
    }
    const file = matroskaMovie({
      docType: 'webm',
      scale: 1_000_000,
      duration: 400,
      tracks: [WEBM_VIDEO],
      clusters: [{ timestamp: 0, frames }],
    })
    const { feeder, source } = await open(file.bytes)
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink)).toBe('ended')
    const payload = concat(...sink.appended('video').map(({ bytes }) => look(bytes).payload))
    expect(same(payload, concat(...pictures))).toBe(true)
    // Some read went back behind the chunks already read.
    let furthest = 0
    let wentBack = false
    for (const read of source.reads.slice(2)) {
      if (read.start < furthest) wentBack = true
      furthest = Math.max(furthest, read.start)
    }
    expect(wentBack).toBe(true)
  })

  it('goes on with no sound when the first three seconds of picture hold none, and holds them until then', async () => {
    const { bytes, pictures } = webm({ seconds: 6, size: 30_000, soundFrom: 5 })
    const { feeder } = await open(bytes)
    expect(feeder.tracks.audio).not.toBeNull()
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink)).toBe('ended')
    // `init` comes once, before every append, and says there is no sound.
    expect(sink.inits).toHaveLength(1)
    expect(sink.inits[0]?.audio).toBeNull()
    expect(sink.notes[0]?.op).toBe('init')
    // No sound is ever written, though the file has some from the fifth second; the picture is fed whole, once.
    expect(sink.appended('audio')).toHaveLength(0)
    const video = sink.appended('video')
    const payload = concat(...video.map(({ bytes: fragment }) => look(fragment).payload))
    expect(same(payload, concat(...pictures))).toBe(true)
    video.forEach(({ run }, i) => {
      const before = video[i - 1]
      if (before) expect(run.start).toBeGreaterThanOrEqual(before.run.end - 1e-9)
    })
  })

  it('logs the damage it passes over, naming the bytes, and goes on', async () => {
    const { bytes, clusters } = webm({ seconds: 4, size: 30_000 })
    const damaged = clusters[1]
    if (damaged === undefined) throw new Error('no cluster')
    const broken = bytes.slice()
    broken.fill(0x55, damaged.start, damaged.start + 64)
    const { feeder, events } = await open(broken)
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink)).toBe('ended')
    const logged = errorsOf(events)
    expect(logged.length).toBeGreaterThan(0)
    for (const message of logged)
      expect(message).toMatch(/^Passed over damaged bytes \d+ to \d+ of the file/)
    // The seconds around the damage are fed.
    expect(sink.appended('video').at(-1)?.run.end).toBeGreaterThan(3)
  })

  it('does not change the decision at a later seek, and ends when the picture does', async () => {
    const { bytes } = webm({ seconds: 6, size: 30_000, soundFrom: 5 })
    const { feeder } = await open(bytes)
    const sink = new RecordingSink()
    await feedAll(feeder, sink, 3)
    await feeder.seek(5, new AbortController().signal)
    expect(await feedAll(feeder, sink)).toBe('ended')
    expect(sink.inits).toHaveLength(1)
    expect(sink.appended('audio')).toHaveLength(0)
  })

  it('writes a sound that is in the first chunk without waiting for three seconds', async () => {
    const { bytes } = webm({ seconds: 6, size: 30_000, soundFrom: 0 })
    const { feeder } = await open(bytes)
    const sink = new RecordingSink()
    await feedAll(feeder, sink, 0.5)
    expect(sink.inits).toHaveLength(1)
    expect(sink.inits[0]?.audio).not.toBeNull()
    // Less than three seconds of picture were fed: nothing waited.
    expect(sink.appended('video').at(-1)?.run.end ?? 99).toBeLessThan(3)
    expect(sink.appended('audio').length).toBeGreaterThan(0)
  })
})

/** A WebM whose Cues lie between two clusters of over a megabyte each, so that neither the head nor the tail holds them. */
function withCues(): { bytes: Uint8Array; cues: number; clusters: number[]; at: number[] } {
  const big = (second: number): Uint8Array =>
    cluster(second * 2000, [
      simpleBlock({
        track: 1,
        timecode: 0,
        keyframe: true,
        frames: [concat(VP9_KEY, new Uint8Array(1_200_000))],
      }),
      simpleBlock({ track: 1, timecode: 33, frames: [new Uint8Array(8)] }),
    ])
  const parts: FilePart[] = [
    (at) =>
      seekHead([
        [0x1549a966, at[1] ?? 0],
        [0x1654ae6b, at[2] ?? 0],
        [0x1c53bb6b, at[4] ?? 0],
      ]),
    info({ scale: 1_000_000, duration: 4000 }),
    tracksElement([trackEntry(WEBM_VIDEO)]),
    big(0),
    (at) =>
      cues(
        [
          { time: 0, cluster: at[3] ?? 0 },
          { time: 2000, cluster: at[5] ?? 0 },
        ],
        { positionWidth: 8 },
      ),
    big(1),
  ]
  const file = matroskaFile(parts, { header: undefined })
  return {
    bytes: file.bytes,
    cues: file.offsets[4] ?? 0,
    clusters: [file.offsets[3] ?? 0, file.offsets[5] ?? 0],
    at: file.offsets,
  }
}

describe('seeking a Matroska file (§10.4)', () => {
  it('sets the position to the time-interpolated estimate before the first read the seek needs', async () => {
    // No Cues: the seek searches the clusters, which it reads.
    const { bytes } = webm({ seconds: 6, size: 30_000 })
    const { feeder, source } = await open(bytes)
    if (feeder.index.container !== 'matroska') throw new Error('expected Matroska')
    const { firstCluster, segment } = feeder.index
    const opened = source.notes.length
    await feeder.seek(3, new AbortController().signal)
    const noted = source.notes.slice(opened)
    const estimate = firstCluster + (3 / 6) * (segment.end - firstCluster)
    expect(noted[0]).toEqual({ op: 'setPosition', offset: Math.floor(estimate) })
    expect(noted.some((note) => note.op === 'read')).toBe(true)
    // And at the end it is where the seek chose to start reading, which is a cluster's start.
    const last = noted.filter((note) => note.op === 'setPosition').at(-1)
    expect(last?.op === 'setPosition' ? last.offset : -1).toBeGreaterThanOrEqual(firstCluster)
  })

  it('reads the Cues once: no seek reads them again', async () => {
    const file = withCues()
    const { feeder, source } = await open(file.bytes)
    const cuesEnd = file.at[5] ?? 0
    const touchesCues = (read: ByteRange): boolean => read.start < cuesEnd && read.end > file.cues
    // Opening needed them (the reader looks for the last cluster and the Cues), and the cache keeps them.
    expect(source.reads.some(touchesCues)).toBe(true)
    const before = source.reads.length
    await feeder.seek(2, new AbortController().signal)
    await feeder.seek(0.5, new AbortController().signal)
    await feeder.seek(2, new AbortController().signal)
    expect(source.reads.slice(before).filter(touchesCues)).toEqual([])
  })

  it('sets no estimate for a seek that the cache serves, only the position it ends at', async () => {
    const file = withCues()
    const { feeder, source } = await open(file.bytes)
    const signal = new AbortController().signal
    await feeder.seek(2, signal)
    const before = source.notes.length
    await feeder.seek(2, signal)
    const noted = source.notes.slice(before)
    // Nothing was read, and the only position is the one the seek ends at.
    expect(noted.map((note) => note.op)).toEqual(['setPosition'])
    expect(file.clusters).toContain(noted[0]?.op === 'setPosition' ? noted[0].offset : -1)
  })
})

// ---------------------------------------------------------------------------
// What the first review found (R29)

describe('what opening and seeking hold (R29 a, e, j, k)', () => {
  const livelock = (source: MemorySource): void => {
    source.intercept = () =>
      source.reads.length > 60 ? Promise.reject(new Error('read again and again')) : undefined
  }

  it('finishes an open that needs two reads that together exceed the cache, reading each range once', async () => {
    // The first keyframe is 2.5 MB: opening reads on from the head, and what it read does not fit the cache.
    const file = matroskaMovie({
      docType: 'webm',
      scale: 1_000_000,
      duration: 2000,
      tracks: [WEBM_VIDEO],
      clusters: [
        {
          timestamp: 0,
          frames: [{ track: 1, time: 0, keyframe: true, data: pictureFrame(0, 2_500_000, true) }],
        },
        {
          timestamp: 1000,
          frames: [
            { track: 1, time: 1000, keyframe: true, data: pictureFrame(1, 2_500_000, true) },
          ],
        },
      ],
    })
    const { source } = await open(file.bytes, SUPPORTED, {
      cacheBytes: 1_500_000,
      prepare: livelock,
    })
    const keys = source.reads.map((read) => `${read.start}-${read.end}`)
    expect(source.reads.length).toBeGreaterThanOrEqual(3)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('finishes a seek over what the cache holds, with the seeks after it served from it', async () => {
    const file = withCues()
    const { feeder, source } = await open(file.bytes, SUPPORTED, {
      cacheBytes: 1_500_000,
      prepare: livelock,
    })
    const signal = new AbortController().signal
    await feeder.seek(2, signal)
    await feeder.seek(0.5, signal)
    expect(source.reads.length).toBeLessThan(30)
  })

  it('finishes a seek that needs more than the cache holds', async () => {
    const { bytes } = webm({ seconds: 6, size: 400_000 })
    const { feeder, source } = await open(bytes, SUPPORTED, {
      cacheBytes: 1_100_000,
      prepare: livelock,
    })
    await feeder.seek(4, new AbortController().signal)
    expect(source.reads.length).toBeLessThan(40)
  })

  it('holds nothing of an MP4 after it is open, and something of a Matroska file', async () => {
    const { feeder } = await open(interleaved().bytes)
    expect(feeder.cachedBytes).toBe(0)
    const matroska = await open(webm({ seconds: 2, size: 30_000 }).bytes)
    expect(matroska.feeder.cachedBytes).toBeGreaterThan(0)
  })

  it('opens a faststart MP4 while the read of the tail never ends', async () => {
    const built = mp4File({
      video: { count: 40, timescale: 30000, duration: 1000, size: () => 100_000, keyEvery: 10 },
    })
    const size = built.bytes.length
    expect(size).toBeGreaterThan(HEAD_BYTES + TAIL_BYTES)
    const { feeder, source } = await open(built.bytes, SUPPORTED, {
      prepare: (one) => {
        one.intercept = (range) =>
          range.start === size - TAIL_BYTES ? new Promise<Uint8Array>(() => undefined) : undefined
      },
    })
    expect(feeder.index.container).toBe('mp4')
    // The tail was still asked for at once.
    expect(source.notes.filter((note) => note.op === 'fetchNow')).toHaveLength(2)
  })
})

describe('the sound decision and what each feed reaches (R29 b, c)', () => {
  it('plays the sound of a picture-first MP4 whose first megabyte of picture covers over three seconds', async () => {
    const built = mp4File({
      video: { count: 150, timescale: 30000, duration: 1000, size: () => 7000, keyEvery: 30 },
      audio: { count: 235, timescale: 48000, duration: 1024, size: () => 300 },
      layout: 'video-first',
    })
    const { feeder } = await open(built.bytes)
    const sink = new RecordingSink()
    await feedAll(feeder, sink, 2)
    expect(sink.inits[0]?.audio).not.toBeNull()
    expect(sink.appended('audio').length).toBeGreaterThan(0)
  })

  it('feeds every track to the target, and feeds the sound again when it is behind', async () => {
    const built = mp4File({
      video: { count: 150, timescale: 30000, duration: 1000, size: () => 15_000, keyEvery: 30 },
      audio: { count: 235, timescale: 48000, duration: 1024, size: () => 40_000 },
      layout: 'video-first',
    })
    const { feeder } = await open(built.bytes)
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink, 2)).toBe('more')
    expect(sink.appended('video').at(-1)?.run.end).toBeGreaterThanOrEqual(2)
    expect(sink.appended('audio').at(-1)?.run.end).toBeGreaterThanOrEqual(2)
    expect(await feedAll(feeder, sink, 4)).toBe('more')
    expect(sink.appended('audio').at(-1)?.run.end).toBeGreaterThanOrEqual(4)
  })
})

/** A WebM of one cluster of ten pictures of 400 KB with no BlockDuration: a frame's bytes lie in the chunk before its table. */
function straddling(): { bytes: Uint8Array; pictures: Uint8Array[] } {
  const frames: MovieFrame[] = []
  const pictures: Uint8Array[] = []
  for (let i = 0; i < 10; i += 1) {
    const data = pictureFrame(i, 400_000, i === 0)
    pictures.push(data)
    frames.push({ track: 1, time: Math.round((i * 1000) / 30), keyframe: i === 0, data })
  }
  const file = matroskaMovie({
    docType: 'webm',
    scale: 1_000_000,
    duration: 400,
    tracks: [WEBM_VIDEO],
    clusters: [{ timestamp: 0, frames }],
  })
  return { bytes: file.bytes, pictures }
}

describe('what a chunk commits (R29 d, f, g)', () => {
  it('loses no frame and leaves no gap in the sequence when a read of a span fails once', async () => {
    const { bytes, pictures } = straddling()
    const { feeder, source } = await open(bytes)
    let furthest = 0
    let failed = false
    source.intercept = (range) => {
      const back = range.start < furthest
      furthest = Math.max(furthest, range.start)
      if (!back || failed) return undefined
      failed = true
      return Promise.reject(new Error('the store failed'))
    }
    const sink = new RecordingSink()
    const signal = new AbortController().signal
    await expect(feedAll(feeder, sink, Infinity, signal)).rejects.toThrow('the store failed')
    expect(await feedAll(feeder, sink, Infinity, signal)).toBe('ended')
    const video = sink.appended('video')
    expect(video.map(({ bytes: one }) => look(one).sequence)).toEqual(video.map((_, i) => i + 1))
    const payload = concat(...video.map(({ bytes: one }) => look(one).payload))
    expect(same(payload, concat(...pictures))).toBe(true)
  })

  it("keeps a track's fragments in decode order when a later run starts before an earlier one", async () => {
    const built = mp4File({
      video: {
        count: 90,
        timescale: 30000,
        duration: 1000,
        size: () => 1000,
        keyEvery: 30,
        // The first second is shown from 3 s on, the second from 1 s: its run starts below the one before.
        cts: (i) => (i < 30 ? 90_000 : 0),
      },
    })
    const { feeder } = await open(built.bytes)
    const sink = new RecordingSink()
    expect(await feedAll(feeder, sink)).toBe('ended')
    const video = sink.appended('video')
    expect(video.length).toBeGreaterThanOrEqual(3)
    expect(video.map(({ bytes }) => look(bytes).sequence)).toEqual(video.map((_, i) => i + 1))
    const decodes = video.map(({ bytes }) => look(bytes).decode)
    expect(decodes).toEqual([...decodes].sort((a, b) => a - b))
    expect(video[1]?.run.start).toBeLessThan(video[0]?.run.start ?? 0)
  })

  it('stops the held appends when the signal aborts during them', async () => {
    const { bytes } = webm({ seconds: 6, size: 30_000, soundFrom: 5 })
    const { feeder } = await open(bytes)
    const sink = new RecordingSink()
    const controller = new AbortController()
    sink.afterAppend = () => {
      controller.abort(new Error('stopped'))
    }
    await expect(feedAll(feeder, sink, Infinity, controller.signal)).rejects.toThrow('stopped')
    expect(sink.appended()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// What the second review found (R30)

describe('the tail and the signal of an open (R30 1, 2, 3)', () => {
  it('calls the tail off when the open ends, though it was never used', async () => {
    const built = mp4File({
      video: { count: 40, timescale: 30000, duration: 1000, size: () => 100_000, keyEvery: 10 },
    })
    const { source } = await open(built.bytes)
    const tail = source.notes.find((note) => note.op === 'fetchNow' && note.start > 0)
    expect(tail?.op === 'fetchNow' ? tail.signal : undefined).toBeDefined()
    expect(tail?.op === 'fetchNow' ? tail.signal?.aborted : false).toBe(true)
    // And it was never read: nothing is left waiting for it.
    expect(source.reads).toEqual([{ start: 0, end: HEAD_BYTES }])
  })

  it('rejects an open aborted while it reads, with the signal reason and no event', async () => {
    const built = mp4File({
      video: { count: 40, timescale: 30000, duration: 1000, size: () => 100_000, keyEvery: 10 },
      moov: 'end',
    })
    const source = new MemorySource(built.bytes)
    const controller = new AbortController()
    source.intercept = (range) => {
      if (range.start === 0) return undefined
      controller.abort(new Error('closed'))
      return Promise.reject(controller.signal.reason as Error)
    }
    const events: TimelineEventInput[] = []
    const failed = await Feeder.open(source, SUPPORTED, (event) => events.push(event), {
      signal: controller.signal,
    }).catch((error: unknown) => error)
    expect(failed).toEqual(new Error('closed'))
    expect(events).toEqual([])
    const tail = source.notes.find((note) => note.op === 'fetchNow' && note.start > 0)
    expect(tail?.op === 'fetchNow' ? tail.signal?.aborted : false).toBe(true)
    // The signal went to every read.
    for (const note of source.notes) {
      if (note.op === 'read') expect(note.signal).toBe(controller.signal)
    }
  })

  it('keeps what an aborted seek read, so the next seek does not read it again', async () => {
    const { bytes } = webm({ seconds: 6, size: 400_000 })
    const { feeder, source } = await open(bytes)
    const controller = new AbortController()
    const before = source.reads.length
    let count = 0
    source.intercept = () => {
      count += 1
      if (count === 2) controller.abort(new Error('moved on'))
      return undefined
    }
    await expect(feeder.seek(4, controller.signal)).rejects.toThrow('moved on')
    const read = source.reads.slice(before)
    // The first read was held, and the second was the one cut short.
    expect(read.length).toBe(2)
    source.intercept = null
    const between = source.reads.length
    await feeder.seek(4, new AbortController().signal)
    const again = source.reads.slice(between).map((one) => `${one.start}-${one.end}`)
    const first1 = read[0]
    expect(again).not.toContain(`${first1?.start}-${first1?.end}`)
  })
})

// ---------------------------------------------------------------------------
// Signals

describe('the signal (§10.4)', () => {
  it('gives every read the signal, and an abort stops the feed with no error event', async () => {
    const built = interleaved()
    const { feeder, source, events } = await open(built.bytes)
    const controller = new AbortController()
    const sink = new RecordingSink()
    const before = source.notes.length
    await feeder.feed(1, sink, controller.signal)
    const fed = source.notes.slice(before).flatMap((note) => (note.op === 'read' ? [note] : []))
    expect(fed.length).toBeGreaterThan(0)
    for (const read of fed) expect(read.signal).toBe(controller.signal)

    controller.abort(new Error('stopped'))
    const failed = await feeder.feed(5, sink, controller.signal).catch((error: unknown) => error)
    expect(failed).toEqual(new Error('stopped'))
    expect(errorsOf(events)).toEqual([])
  })

  it('stops a seek of a Matroska file with the signal too', async () => {
    const file = withCues()
    const { feeder, events } = await open(file.bytes)
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const failed = await feeder.seek(2, controller.signal).catch((error: unknown) => error)
    expect(failed).toEqual(new Error('gone'))
    expect(errorsOf(events)).toEqual([])
  })
})
