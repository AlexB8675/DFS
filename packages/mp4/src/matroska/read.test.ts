import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import type { Mp4Refusal } from '../errors.ts'
import { heldBytes } from '../source.ts'
import type { ByteRange, Chunk, SoundOffer } from '../source.ts'
import { bits, concat, u16 } from '../testing/build.ts'
import {
  cluster,
  element,
  info,
  matroskaFile,
  matroskaMovie,
  seekHead,
  simpleBlock,
  trackEntry,
  tracksElement,
} from '../testing/ebml.ts'
import type { Movie, MovieCluster, MovieFrame, MovieSpec, TrackSpec } from '../testing/ebml.ts'
import type { RawFrame } from './clusters.ts'
import { readHeader } from './ebml.ts'
import { ac3Config } from './frameheaders.ts'
import { ID } from './ids.ts'
import { HEADER_READ, MAX_INDEX_READS } from './limits.ts'
import { readMatroska } from './read.ts'
import type { MatroskaIndex, MatroskaPlayTrack } from './read.ts'
import { decodeTimes, startDecode } from './timing.ts'

// The index of a Matroska or WebM file (DESIGN.md §10.4, D45): its picture, its
// sounds in order of preference, each with its sample entry, names and timing,
// and its duration, in a few bounded reads. Every file is built in code, field by
// field, by `matroskaMovie`, and every expected value is written out from the
// standards or from what ffmpeg wrote for generated pictures and tones
// (2026-10-25), not computed by the module. Each file is opened the way a caller
// does, by `open`, which holds every ask to the rules on the way.

const MIB = 1024 * 1024

/** What a caller reads first, a megabyte (HEAD_BYTES, which a later task names). */
const HEAD = MIB

/** The most asks a test lets an open make before it calls the open lost: far above the cap. */
const TURNS = 40

const PICTURE_SENTENCE = "The picture track can't be played: "
const SOUND_SENTENCE = "The sound track can't be played: "

interface Opened {
  index: MatroskaIndex
  /** The ranges the open asked for, in order. */
  asks: ByteRange[]
  chunks: Chunk[]
}

/**
 * Opens a file the way a caller does: the first `head` bytes, then each range the
 * reader asks for, until it is done. Every ask is held to the rules on the way:
 * it lies inside the file, it is never a range the reader holds, and a reader that
 * goes on asking is stopped. `asks` is filled even when the file is refused, so
 * that a test can count them. A caller that has read ranges ahead holds them from
 * the start (`ahead`).
 */
function open(
  bytes: Uint8Array,
  {
    head = HEAD,
    asks = [],
    ahead = [],
  }: { head?: number; asks?: ByteRange[]; ahead?: ByteRange[] } = {},
): Opened {
  const chunks: Chunk[] = [
    { start: 0, bytes: bytes.subarray(0, Math.min(head, bytes.length)) },
    ...ahead.map(({ start, end }) => ({ start, bytes: bytes.subarray(start, end) })),
  ]
  for (let turn = 0; turn < TURNS; turn += 1) {
    const step = readMatroska(chunks, bytes.length)
    if ('done' in step) return { index: step.done, asks, chunks }
    const { start, end } = step.need
    expect(Number.isSafeInteger(start) && start >= 0 && start < end && end <= bytes.length).toBe(
      true,
    )
    expect(heldBytes(chunks, start, end)).toBeNull()
    asks.push(step.need)
    chunks.push({ start, bytes: bytes.subarray(start, end) })
  }
  throw new Error('the open went on asking')
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

/** An index as plain data, for the comparison of two: a track's `lace` is a function, which is the same function in no two. */
function plain(index: MatroskaIndex): unknown {
  const strip = (track: MatroskaPlayTrack | null): unknown =>
    track === null ? null : { ...track, read: { ...track.read, lace: undefined } }
  return {
    ...index,
    video: strip(index.video),
    sound: strip(index.sound),
    soundTracks: index.soundTracks.map(strip),
  }
}

/** The offer of a sound that plays, which must be one. */
function playable(offer: SoundOffer | undefined): { id: number; language: string; codec: string } {
  if (offer === undefined || 'refusal' in offer) throw new Error('expected a sound that plays')
  return offer
}

/** The refusal of a sound that doesn't play, which must be one. */
function turnedAway(offer: SoundOffer | undefined): Mp4Error {
  if (offer === undefined || !('refusal' in offer)) throw new Error('expected a refused sound')
  return offer.refusal
}

/** The type of a sample entry, from its bytes. */
function typeOf(entry: Uint8Array): string {
  return String.fromCharCode(...entry.subarray(4, 8))
}

/** The identity matrix of a `tkhd`, as the 36 bytes it is written in. */
const IDENTITY = Uint8Array.of(
  ...[0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ...[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  ...[0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0],
)

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

/** The `avcC` record of x264 for generated 320x240 pictures with B-frames (2026-10-25): `has_b_frames` 2, level 1.3. */
const X264_B_FRAMES =
  '0164000dffe100196764000dacd94141fb0110000003001000000303c0f142996001000668ebe3cb22c0fdf8f800'

/** The uncompressed header of a profile 0 VP9 keyframe: frame marker, profile 0, a keyframe, the sync code, 8 bits and color_space 0 with a limited range. */
const VP9_KEYFRAME = [0x82, 0x49, 0x83, 0x42, 0x00]

/** A keyframe of VP9 of this many bytes (at least the header). */
function key(size = VP9_KEYFRAME.length): Uint8Array {
  return concat(VP9_KEYFRAME, new Uint8Array(size - VP9_KEYFRAME.length))
}

/** An OpusHead (RFC 7845 §5.1): stereo at 48 kHz with a pre-skip of 312 samples, which is 6.5 ms. */
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

/** The first syncframe of AC-3 (ETSI TS 102 366, clause 4): 48 kHz, frmsizecod 0x1C, bsid 8, bsmod 0, acmod 7, with the LFE. */
function ac3Frame(): Uint8Array {
  return Uint8Array.from(
    bits(
      [0x0b77, 16],
      [0, 16], // crc1
      [0, 2], // fscod
      [0x1c, 6], // frmsizecod
      [8, 5], // bsid
      [0, 3], // bsmod
      [7, 3], // acmod
      [0, 4], // cmixlev and surmixlev
      [1, 1], // lfeon
      [0, 32],
    ),
  )
}

/** The picture, as ffmpeg writes a WebM of VP9 for 320x240 at 30 frames a second: no CodecPrivate. */
const VP9: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_VP9',
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

/** A stereo Opus sound of 20 ms frames, whose pre-skip is the CodecDelay. */
function opus(number: number, over: Partial<TrackSpec> = {}): TrackSpec {
  return {
    number,
    type: 2,
    codecId: 'A_OPUS',
    codecPrivate: opusHead(),
    codecDelay: 6_500_000,
    seekPreRoll: 80_000_000,
    defaultDuration: 20_000_000,
    audio: { samplingFrequency: 48000, channels: 2 },
    ...over,
  }
}

/** A stereo AAC-LC sound at 48 kHz (AudioSpecificConfig 0x1190). */
function aac(number: number, over: Partial<TrackSpec> = {}): TrackSpec {
  return {
    number,
    type: 2,
    codecId: 'A_AAC',
    codecPrivate: Uint8Array.of(0x11, 0x90),
    audio: { samplingFrequency: 48000, channels: 2 },
    ...over,
  }
}

function frame(track: number, time: number, over: Partial<MovieFrame> = {}): MovieFrame {
  return { track, time, ...over }
}

/** The first frames of a short clip of the picture (track 1) and a sound (track 2): the picture's first is a keyframe. */
function start(sound = 2): MovieFrame[] {
  return [
    frame(1, 0, { keyframe: true, data: key() }),
    frame(sound, 0, { keyframe: true }),
    frame(1, 33),
    frame(sound, 20, { keyframe: true }),
    frame(1, 67),
    frame(sound, 40, { keyframe: true }),
    frame(1, 100),
  ]
}

/** A movie with an Info Duration of 4021 ticks unless the spec says another (or, with `duration: undefined`, none). */
function movie(spec: MovieSpec): Movie {
  return matroskaMovie({ duration: 4021, ...spec })
}

/** The 3 MiB of Tags that put a Cluster past the first megabyte. */
const TAGS = 3 * MIB

describe('the index of a WebM of VP9 and Opus (§10.4)', () => {
  const file = movie({
    docType: 'webm',
    scale: 1_000_000,
    tracks: [VP9, opus(2, { language: 'jpn' })],
    clusters: [{ timestamp: 0, frames: start() }],
  })

  it('is done in one call with the first megabyte', () => {
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([])
    const first = file.clusters[0]?.start
    expect(index.container).toBe('matroska')
    expect(index.docType).toBe('webm')
    expect(index.timestampScale).toBe(1_000_000)
    expect(index.segment).toEqual({ data: file.segmentData, end: file.bytes.length })
    expect(index.firstCluster).toBe(first)
    expect(index.cues).toBeNull()
    expect(index.reads).toBe(0)
  })

  it("names the picture by the keyframe's header and offsets neither track by anything but the Opus pre-skip", () => {
    const { index } = open(file.bytes)
    expect(index.video.codecNames).toEqual(['vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'])
    expect(index.video.codec).toBe('vp09.00.20.08.01.02.02.02.00')
    expect(typeOf(index.video.entry)).toBe('vp09')
    expect(index.video.timing).toEqual({ offsetSeconds: 0, endSeconds: null })
    const opusTrack = index.soundTracks[0]
    expect(opusTrack?.timing.endSeconds).toBeNull()
    expect(opusTrack?.timing.offsetSeconds).toBe(-0.0065)
  })

  it('has the duration that Info gives, in seconds', () => {
    expect(open(file.bytes).index.durationSeconds).toBe(4.021)
  })

  it('gives each track the header of an init segment', () => {
    const { index } = open(file.bytes)
    expect(index.video.header).toEqual({
      id: 1,
      kind: 'video',
      timescale: 1000,
      language: 'eng',
      width: 320,
      height: 240,
      matrix: IDENTITY,
    })
    expect(index.soundTracks[0]?.header).toEqual({
      id: 2,
      kind: 'audio',
      timescale: 1000,
      language: 'jpn',
      width: 0,
      height: 0,
      matrix: IDENTITY,
    })
    expect(index.video.prefix).toEqual(new Uint8Array(0))
  })

  it('offers the sound, which plays', () => {
    const { index } = open(file.bytes)
    expect(index.sounds).toEqual([
      { id: 2, language: 'jpn', codecNames: ['opus', 'Opus'], codec: 'opus' },
    ])
    expect(index.sound).toBe(index.soundTracks[0])
    expect(typeOf(index.sound?.entry ?? new Uint8Array(8))).toBe('Opus')
  })

  it('gives the cursor what it reads the clusters by', () => {
    const { index } = open(file.bytes)
    // The picture's frames last 33.333333 ticks of a millisecond each (DefaultDuration 33 333 333 ns), and its decode runs ahead of its presentation by nothing.
    expect(index.video.read).toMatchObject({
      number: 1,
      depth: 0,
      depthStated: true,
      frameTicks: 33.333333,
      shift: 0,
      defaultDuration: 33.333333,
    })
    expect(index.video.read.lace(Uint8Array.of(1, 2, 3))).toBeNull()
    // A sound reorders nothing, and its frames last 20 ticks.
    expect(index.soundTracks[0]?.read).toMatchObject({
      number: 2,
      depth: 0,
      depthStated: true,
      frameTicks: 20,
      shift: 0,
      defaultDuration: 20,
    })
  })
})

describe('the index of a file with no sound', () => {
  it('has none to offer, and plays the picture', () => {
    const { index } = open(
      movie({
        tracks: [VP9],
        clusters: [{ timestamp: 0, frames: start().filter((one) => one.track === 1) }],
      }).bytes,
    )
    expect(index.sounds).toEqual([])
    expect(index.sound).toBeNull()
    expect(index.soundTracks).toEqual([])
  })
})

describe('the index of an H.264 picture with B-frames', () => {
  // The evidence: x264's B-frames at 30 frames a second, whose frames in decode order are presented at these times (ms), as ffmpeg wrote them.
  const times = [0, 100, 33, 67, 233, 167, 133, 200]
  const file = movie({
    tracks: [
      {
        number: 1,
        type: 1,
        codecId: 'V_MPEG4/ISO/AVC',
        codecPrivate: fromHex(X264_B_FRAMES),
        defaultDuration: 33_333_333,
        video: { pixelWidth: 320, pixelHeight: 240 },
      },
    ],
    clusters: [
      { timestamp: 0, frames: times.map((time, at) => frame(1, time, { keyframe: at === 0 })) },
    ],
  })

  it('reads the depth from the configuration, and shifts the decode times by the frames before 0', () => {
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([])
    expect(index.video.read).toMatchObject({
      depth: 2,
      depthStated: true,
      shift: 67,
      frameTicks: 33.333333,
    })
    // The first dts is -67 ms, as ffmpeg's remux has it: the SourceBuffer's timestampOffset takes it back.
    expect(index.video.timing.offsetSeconds).toBe(-0.067)
    expect(index.video.codec).toBe('avc1.64000d')
    expect(typeOf(index.video.entry)).toBe('avc1')
  })
})

describe('the index of an AAC sound with a CodecDelay', () => {
  it('offsets the sound by the delay', () => {
    const { index } = open(
      movie({
        tracks: [VP9, aac(2, { codecDelay: 21_333_333 })],
        clusters: [{ timestamp: 0, frames: start() }],
      }).bytes,
    )
    expect(index.soundTracks[0]?.timing.offsetSeconds).toBeCloseTo(-0.021333333, 9)
    expect(index.soundTracks[0]?.codecNames).toEqual(['mp4a.40.2'])
  })
})

describe('the order of the sounds (D45)', () => {
  it('offers six tracks that no one flags as the default in the order of the file, and plays the first', () => {
    const numbers = [2, 3, 4, 5, 6, 7]
    const { index } = open(
      movie({
        tracks: [VP9, ...numbers.map((number) => opus(number, { default: false }))],
        clusters: [
          {
            timestamp: 0,
            frames: [
              ...start(2),
              ...numbers.slice(1).map((number) => frame(number, 0, { keyframe: true })),
            ],
          },
        ],
      }).bytes,
    )
    expect(index.sounds.map((offer) => offer.id)).toEqual(numbers)
    expect(index.soundTracks.map((track) => track.header.id)).toEqual(numbers)
    expect(index.sound?.header.id).toBe(2)
    expect(index.sound).toBe(index.soundTracks[0])
  })

  it('puts the track flagged as the default first', () => {
    const { index } = open(
      movie({
        tracks: [
          VP9,
          opus(2, { default: false }),
          opus(3, { default: true }),
          opus(4, { default: false }),
        ],
        clusters: [
          {
            timestamp: 0,
            frames: [...start(2), frame(3, 0, { keyframe: true }), frame(4, 0, { keyframe: true })],
          },
        ],
      }).bytes,
    )
    expect(index.sounds.map((offer) => offer.id)).toEqual([3, 2, 4])
    expect(index.sound?.header.id).toBe(3)
  })

  it('refuses the first sound that no browser plays, offers the second, and plays none', () => {
    const { index } = open(
      movie({
        tracks: [
          VP9,
          {
            number: 2,
            type: 2,
            codecId: 'A_DTS',
            audio: { samplingFrequency: 48000, channels: 6 },
          },
          aac(3),
        ],
        clusters: [
          {
            timestamp: 0,
            frames: [
              ...start(2),
              frame(3, 0, { keyframe: true }),
              frame(3, 21, { keyframe: true }),
            ],
          },
        ],
      }).bytes,
    )
    expect(index.sounds).toHaveLength(2)
    const first = turnedAway(index.sounds[0])
    expect(first.reason).toBe('unsupported-codec')
    expect(first.message.startsWith(SOUND_SENTENCE)).toBe(true)
    expect(first.message).toContain('A_DTS')
    expect(index.sounds[0]).toMatchObject({ id: 2, language: 'eng' })
    expect(playable(index.sounds[1])).toMatchObject({ id: 3, codec: 'mp4a.40.2' })
    // The first sound is the one that plays (D45), and it can't: the player plays elsewhere, or the user chooses.
    expect(index.sound).toBeNull()
    expect(index.soundTracks.map((track) => track.header.id)).toEqual([3])
  })

  it('does not read on for the frames of a sound that is refused whatever they are', () => {
    // The picture's frames fill the first 3.6 MiB; the DTS sound has no frame at all, and the first 3 frames of the picture and a frame of the AAC are in the first megabyte.
    const frames = [
      frame(1, 0, { keyframe: true, data: key(300 * 1024) }),
      frame(3, 0, { keyframe: true }),
      ...Array.from({ length: 11 }, (_, at) => frame(1, 33 * (at + 1), { size: 300 * 1024 })),
    ]
    const { asks, index } = open(
      movie({
        tracks: [
          VP9,
          {
            number: 2,
            type: 2,
            codecId: 'A_DTS',
            audio: { samplingFrequency: 48000, channels: 6 },
          },
          aac(3),
        ],
        clusters: [{ timestamp: 0, frames }],
      }).bytes,
    )
    expect(asks).toEqual([])
    expect(turnedAway(index.sounds[0]).reason).toBe('unsupported-codec')
  })
})

describe('a first Cluster past the head', () => {
  // 3 MiB of Tags between the Tracks and the first Cluster, which holds the first frames in its first megabyte, and a second Cluster so that the file goes on past it.
  const file = movie({
    tracks: [VP9, opus(2)],
    tags: [TAGS],
    clusters: [
      {
        timestamp: 0,
        frames: [
          frame(1, 0, { keyframe: true, data: key(250 * 1024) }),
          frame(2, 0, { keyframe: true }),
          frame(1, 33, { size: 250 * 1024 }),
          frame(1, 67, { size: 250 * 1024 }),
          frame(2, 20, { keyframe: true }),
        ],
      },
      { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true, size: 300 * 1024 })] },
    ],
  })

  it("needs the Tags' end header, then the next megabyte from the Cluster, and then is done", () => {
    const { index, asks } = open(file.bytes)
    const first = file.clusters[0]?.start ?? NaN
    expect(file.tags[0]?.end).toBe(first)
    expect(asks).toEqual([
      { start: first, end: first + HEADER_READ },
      { start: first, end: first + MIB },
    ])
    expect(index.firstCluster).toBe(first)
    expect(index.video.codec).toBe('vp09.00.20.08.01.02.02.02.00')
    expect(index.sound).toBe(index.soundTracks[0])
  })

  it('is the same index when the caller has read the whole file ahead', () => {
    const exact = open(file.bytes)
    const ahead: Chunk[] = [{ start: 0, bytes: file.bytes.subarray(0, HEAD) }]
    for (let at = HEAD; at < file.bytes.length; at += MIB) {
      ahead.push({ start: at, bytes: file.bytes.subarray(at, at + MIB) })
    }
    const step = readMatroska(ahead, file.bytes.length)
    if (!('done' in step)) throw new Error('expected the index')
    expect(plain(step.done)).toEqual(plain(exact.index))
  })
})

describe('a first block that ends where the first read does, in a cluster of unknown size', () => {
  // A block in a cluster of unknown size is taken once the ID of the element after it is held (1 to 4 bytes), so a read that ends at the block's end, or a few bytes after, does not hold it: the next read does, and the index is the one of a caller that holds the file.
  it('is the index of a caller that holds the whole file, for a block that ends 8 bytes before the read to 8 after it', () => {
    for (let delta = -8; delta <= 8; delta += 1) {
      const build = (size: number): Movie =>
        movie({
          tracks: [VP9, opus(2)],
          clusters: [
            {
              timestamp: 0,
              unknown: true,
              frames: [
                frame(1, 0, { keyframe: true, data: key(size) }),
                frame(2, 0, { keyframe: true }),
                frame(1, 33),
                frame(2, 20, { keyframe: true }),
                frame(1, 67),
                frame(2, 40, { keyframe: true }),
                frame(1, 100),
              ],
            },
            { timestamp: 1000, unknown: true, frames: [frame(1, 1000, { keyframe: true })] },
          ],
        })
      // The first block ends at the end of the head when its frame is the rest of it after the cluster's header, its Timestamp and its own header (12, 3 and 8 bytes). (A file of this size writes the Segment's size in the same bytes as one of a megabyte less a thousand.)
      const first = build(HEAD - 1000).clusters[0]?.start ?? NaN
      const size = HEAD - first - 12 - 3 - 8 + delta
      const file = build(size)
      // The premise: the first block of the cluster (after its Timestamp) ends `delta` bytes from the head's end.
      const cluster = readHeader(file.bytes, first, file.bytes.length)
      const stamp = readHeader(file.bytes, cluster?.data ?? NaN, file.bytes.length)
      const block = readHeader(file.bytes, stamp?.end ?? NaN, file.bytes.length)
      expect(block?.end).toBe(HEAD + delta)
      const opened = open(file.bytes)
      expect(opened.asks.length).toBeLessThanOrEqual(MAX_INDEX_READS)
      const ahead: Chunk[] = [{ start: 0, bytes: file.bytes.subarray(0, HEAD) }]
      for (let at = HEAD; at < file.bytes.length; at += MIB) {
        ahead.push({ start: at, bytes: file.bytes.subarray(at, at + MIB) })
      }
      const held = readMatroska(ahead, file.bytes.length)
      if (!('done' in held)) throw new Error('expected the index')
      expect(plain(opened.index), `a block ending ${delta} bytes from the head's end`).toEqual(
        plain(held.done),
      )
    }
  })
})

describe('a picture with large frames', () => {
  /** An H.264 picture of depth 2, as x264 writes B-frames, whose frames in decode order are presented at these times (ms). */
  const H264: TrackSpec = {
    number: 1,
    type: 1,
    codecId: 'V_MPEG4/ISO/AVC',
    codecPrivate: fromHex(X264_B_FRAMES),
    defaultDuration: 33_333_333,
    video: { pixelWidth: 320, pixelHeight: 240 },
  }
  const times = [0, 100, 33, 67, 233, 167, 133, 200]

  /** A movie of this picture, its frames of this size, the first a keyframe. */
  function large(track: TrackSpec, size: number): Movie {
    return movie({
      tracks: [track],
      clusters: [
        {
          timestamp: 0,
          frames: times.map((time, at) =>
            frame(1, time, { keyframe: at === 0, data: at === 0 ? key(size) : undefined, size }),
          ),
        },
      ],
    })
  }

  it('reads a megabyte at a time until the picture has its 3 frames (depth 2), and no more', () => {
    // The head holds the first frame whole; the next megabyte holds the next 2 (the third ends at 1.8 MiB), and the 5 that follow are not asked for.
    const { asks, index } = open(large(H264, 600 * 1024).bytes)
    expect(asks).toEqual([{ start: MIB, end: 2 * MIB }])
    expect(index.video.read).toMatchObject({ depth: 2, depthStated: true, shift: 67 })
  })

  it('needs only 2 frames of a picture that does not reorder', () => {
    const { asks, index } = open(large(VP9, 600 * 1024).bytes)
    expect(asks).toEqual([{ start: MIB, end: 2 * MIB }])
    expect(index.video.read.depth).toBe(0)
  })

  it('stops at 4 MiB from the first Cluster, and goes on with the frames it has', () => {
    // Frames of 1.5 MiB: the second is whole in the fourth megabyte and the third is past the bound, so a depth of 2 is never satisfied.
    const file = large(H264, 1.5 * MIB)
    const first = file.clusters[0]?.start ?? NaN
    const { asks, index } = open(file.bytes)
    expect(asks).toEqual([
      { start: MIB, end: 2 * MIB },
      { start: 2 * MIB, end: 3 * MIB },
      { start: 3 * MIB, end: 4 * MIB },
      { start: 4 * MIB, end: first + 4 * MIB },
    ])
    // It has 2 frames of the 3 that depth 2 needs, with the rest of the Segment behind: the shift is 2 x 2 frames of 33.333333 ticks, rounded, and 1, less the least pts seen, 0.
    expect(index.video.read).toMatchObject({ depth: 2, shift: 134 })
  })
})

/** An exp-Golomb code (ITU-T H.264 §9.1) as a field of `bits`: the value plus 1, in as many bits as twice its length less one. */
function ue(value: number): readonly [number, number] {
  return [value + 1, 2 * Math.floor(Math.log2(value + 1)) + 1]
}

/** The `avcC` of a Main profile picture of 320x240 and 4 reference frames whose SPS has no VUI, and so states no bitstream restriction: its reorder depth is the most that H.264 holds back, 15, and is not stated. */
function unstatedAvc(): Uint8Array {
  const rbsp = bits(
    [77, 8], // profile_idc
    [0, 8], // the constraint flags
    [30, 8], // level_idc
    ue(0), // seq_parameter_set_id
    ue(0), // log2_max_frame_num_minus4
    ue(0), // pic_order_cnt_type
    ue(2), // log2_max_pic_order_cnt_lsb_minus4
    ue(4), // max_num_ref_frames
    [0, 1], // gaps_in_frame_num_value_allowed_flag
    ue(19), // pic_width_in_mbs_minus1
    ue(14), // pic_height_in_map_units_minus1
    [1, 1], // frame_mbs_only_flag
    [1, 1], // direct_8x8_inference_flag
    [0, 1], // frame_cropping_flag
    [0, 1], // vui_parameters_present_flag
  )
  const sps = concat([0x67], rbsp)
  return concat(
    [1, 77, 0, 30, 0xff, 0xe1],
    u16(sps.length),
    sps,
    [1],
    u16(4),
    [0x68, 0xeb, 0xe3, 0xcb],
  )
}

describe("a picture whose first frames don't all fit in the first read", () => {
  const FRAME_TICKS = 33.333333
  const DEPTH = 15
  const H264: TrackSpec = {
    number: 1,
    type: 1,
    codecId: 'V_MPEG4/ISO/AVC',
    codecPrivate: unstatedAvc(),
    defaultDuration: 33_333_333,
    video: { pixelWidth: 320, pixelHeight: 240 },
  }

  /** A movie of the picture with frames of this size at these times (ms) in decode order, the first a keyframe. */
  function frames(size: number, times: readonly number[]): Movie {
    return movie({
      tracks: [H264],
      clusters: [
        {
          timestamp: 0,
          frames: times.map((time, at) => frame(1, time, { keyframe: at === 0, size })),
        },
      ],
    })
  }

  it('takes its depth as the most that H.264 holds back, which its SPS does not state', () => {
    const { index } = open(frames(10, [0, 33, 67]).bytes)
    expect(index.video.read).toMatchObject({ depth: DEPTH, depthStated: false })
    expect(index.video.codec).toBe('avc1.4d001e')
  })

  it('shifts by the longest the first decode time can be before 0, when the 4 MiB hold only 3 frames of the 16', () => {
    // Frames of 1.2 MiB: 3 of them end before the bound at 4 MiB from the first Cluster, the fourth does not, and 3 more follow.
    const times = [200, 233, 267, 300, 333, 367]
    const { index, asks } = open(frames(Math.floor(1.2 * MIB), times).bytes)
    expect(asks).toHaveLength(4)
    // The least presentation time seen is 200, and the 16 frames could start 15 frames before the least: 2 x 15 x 33.333333 is 999.99999, which is 1000 rounded, and 1 more, less 200.
    expect(index.video.read.shift).toBe(1000 + 1 - 200)
    expect(index.video.timing.offsetSeconds).toBe(-0.801)
  })

  it('keeps the exact shift when the file ends before 16 frames, for there are no others', () => {
    // Three frames in a file of 3 frames: the first decode time is 2 frames before the least presentation time, as it is for a stream that ends.
    const { index } = open(frames(10, [0, 33, 67]).bytes)
    expect(index.video.read.shift).toBe(67)
    expect(index.video.timing.offsetSeconds).toBe(-0.067)
  })

  const orders: [string, (at: number) => number][] = [
    ['frames in rising order', (at) => Math.round(at * FRAME_TICKS)],
    // The worst case of an open GOP: each of the 15 frames after the keyframe is presented before all the ones decoded before it.
    [
      'frames presented before the keyframe',
      (at) => (at <= 15 ? 500 - Math.round(at * FRAME_TICKS) : (at - 15) * 33),
    ],
  ]
  describe.each(orders)('with %s', (_, time) => {
    const stream = Array.from({ length: 18 }, (_unused, at) => time(at))
    const whole: RawFrame[] = stream.slice(0, 16).map((pts, at) => ({
      track: 1,
      offset: at,
      size: 1,
      pts,
      keyframe: at === 0,
      duration: FRAME_TICKS,
      body: at,
    }))
    // What the cursor gives the first frame once it has all 16: its decode time.
    const first = decodeTimes(startDecode(DEPTH, FRAME_TICKS), whole, true).timed[0]?.dts ?? NaN

    it.each(Array.from({ length: 16 }, (_unused, at) => at + 1))(
      'shifts enough for the first decode time of the 16 when the first read holds %i',
      (count) => {
        // The size is the mean of the sizes at which `count` and `count + 1` frames end at the bound, and 2 frames more follow.
        const size = Math.floor((4 * MIB) / count / 2 + (4 * MIB) / (count + 1) / 2)
        const { index } = open(frames(size, stream.slice(0, count + 2)).bytes)
        const { shift } = index.video.read
        expect(first).toBeGreaterThanOrEqual(-shift)
        if (count < DEPTH + 1) {
          const least = Math.min(...stream.slice(0, count))
          expect(shift).toBe(Math.max(0, Math.round(2 * DEPTH * FRAME_TICKS) + 1 - least))
        }
      },
    )
  })
})

describe('the entry of a sound made from its first frame', () => {
  it("has the dac3 of an AC-3 sound's first frame, which is not in the head", () => {
    const frameBytes = ac3Frame()
    const file = movie({
      tracks: [
        VP9,
        { number: 2, type: 2, codecId: 'A_AC3', audio: { samplingFrequency: 48000, channels: 6 } },
      ],
      clusters: [
        {
          timestamp: 0,
          frames: [
            frame(1, 0, { keyframe: true, data: key(600 * 1024) }),
            frame(1, 33, { size: 600 * 1024 }),
            frame(2, 0, { keyframe: true, data: frameBytes }),
            frame(1, 67, { size: 600 * 1024 }),
          ],
        },
      ],
    })
    const { index, asks } = open(file.bytes)
    // The next megabyte is asked for, and the Segment ends before it does.
    expect(asks).toEqual([{ start: MIB, end: file.bytes.length }])
    const offer = playable(index.sounds[0])
    expect(offer).toMatchObject({ id: 2, codec: 'ac-3' })
    const entry = index.sound?.entry ?? new Uint8Array(0)
    expect(typeOf(entry)).toBe('ac-3')
    // An audio sample entry holds 36 bytes before its boxes.
    expect(entry.subarray(36)).toEqual(ac3Config(frameBytes))
  })

  it('has the dac3 of the frame with the sync word that header stripping took from it', () => {
    const whole = ac3Frame()
    const file = movie({
      tracks: [
        VP9,
        {
          number: 2,
          type: 2,
          codecId: 'A_AC3',
          audio: { samplingFrequency: 48000, channels: 6 },
          encodings: [{ compression: { algo: 3, settings: Uint8Array.of(0x0b, 0x77) } }],
        },
      ],
      clusters: [
        {
          timestamp: 0,
          frames: [
            frame(1, 0, { keyframe: true, data: key() }),
            frame(2, 0, { keyframe: true, data: whole.subarray(2) }),
            frame(1, 33),
          ],
        },
      ],
    })
    const { index } = open(file.bytes)
    const track = index.soundTracks[0]
    expect(track?.entry.subarray(36)).toEqual(ac3Config(whole))
    expect(track?.prefix).toEqual(Uint8Array.of(0x0b, 0x77))
    // A frame is told by its stored bytes with what was stripped put back: 1536 samples of 48000 a second, in ticks of a millisecond.
    expect(track?.read.lace(whole.subarray(2))).toBe(32)
  })

  it('offers an E-AC-3 sound that has no frame in 4 MiB as damaged, and plays the picture', () => {
    const file = movie({
      tracks: [
        VP9,
        { number: 2, type: 2, codecId: 'A_EAC3', audio: { samplingFrequency: 48000, channels: 2 } },
      ],
      clusters: [
        {
          timestamp: 0,
          frames: Array.from({ length: 40 }, (_, at) =>
            frame(1, 33 * at, { keyframe: at === 0, data: key(128 * 1024) }),
          ),
        },
      ],
    })
    const first = file.clusters[0]?.start ?? NaN
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([
      { start: MIB, end: 2 * MIB },
      { start: 2 * MIB, end: 3 * MIB },
      { start: 3 * MIB, end: 4 * MIB },
      { start: 4 * MIB, end: first + 4 * MIB },
    ])
    const error = turnedAway(index.sounds[0])
    expect(error.reason).toBe('damaged')
    expect(error.message.startsWith(SOUND_SENTENCE)).toBe(true)
    expect(error.message).toContain('no frame of the track in the first 4 MiB of clusters')
    expect(index.sound).toBeNull()
    expect(index.soundTracks).toEqual([])
    expect(index.video.codec).toBe('vp09.00.20.08.01.02.02.02.00')
  })
})

describe('the duration, when Info has none', () => {
  /** A file of 3 clusters: the first holds the first frames, the second a frame of 1.5 MiB that puts the end of the file past the first megabyte, and the third the end of the film. */
  function ending(over: Partial<MovieSpec> = {}): Movie {
    return movie({
      duration: undefined,
      tracks: [VP9, opus(2)],
      clusters: [
        { timestamp: 0, frames: start() },
        { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true, size: 1.5 * MIB })] },
        {
          timestamp: 2000,
          frames: [
            frame(1, 2000, { keyframe: true, data: key() }),
            frame(2, 2000, { keyframe: true }),
            frame(1, 2033),
            frame(2, 2020, { keyframe: true }),
            frame(1, 2067),
            frame(2, 2040, { keyframe: true }),
            frame(2, 2060, { keyframe: true }),
          ],
        },
      ],
      ...over,
    })
  }

  it("asks for the file's last megabyte and takes the end of the last frame of the last cluster in it", () => {
    const file = ending()
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([{ start: file.bytes.length - MIB, end: file.bytes.length }])
    // The picture's last frame is presented at 2067 and lasts 33.333333 ticks, which is 2100 when rounded; the sound's last, 2060 and 20 ticks, is 2080.
    expect(index.durationSeconds).toBe(2.1)
    // The index says where the last cluster is: the third, whose Timestamp is 2000.
    expect(index.lastCluster).toEqual({ start: file.clusters[2]?.start, timestamp: 2000 })
  })

  it("takes the BlockDuration of the last frame when it has one, and a frame's length from its track's frames when it has none", () => {
    // No DefaultDuration on the picture: a frame lasts the least gap between the first ones, 40. The last frame has a BlockDuration of 55.
    const file = ending({
      tracks: [{ ...VP9, defaultDuration: undefined }, opus(2)],
      clusters: [
        {
          timestamp: 0,
          frames: [
            frame(1, 0, { keyframe: true, data: key() }),
            frame(2, 0, { keyframe: true }),
            frame(1, 40),
            frame(1, 80),
          ],
        },
        { timestamp: 1000, frames: [frame(1, 1000, { size: 1.5 * MIB })] },
        {
          timestamp: 2000,
          frames: [
            frame(1, 2000, { keyframe: true, data: key() }),
            frame(2, 2000),
            frame(1, 2090, { duration: 55 }),
          ],
        },
      ],
    })
    const { index } = open(file.bytes)
    expect(index.video.read.frameTicks).toBe(40)
    expect(index.durationSeconds).toBe(2.145)
  })

  it('takes a Duration of 0 for none, as a recording that is still being written leaves it', () => {
    const file = movie({
      duration: 0,
      tracks: [VP9, opus(2)],
      clusters: [
        { timestamp: 0, frames: start() },
        { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true }), frame(1, 1033)] },
      ],
    })
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([])
    expect(index.durationSeconds).toBe(1.066)
    expect(index.lastCluster).toEqual({ start: file.clusters[1]?.start, timestamp: 1000 })
  })

  it('is the same index when the caller has read the whole file ahead', () => {
    const file = ending()
    const exact = open(file.bytes)
    const ahead: Chunk[] = [{ start: 0, bytes: file.bytes.subarray(0, HEAD) }]
    for (let at = HEAD; at < file.bytes.length; at += MIB) {
      ahead.push({ start: at, bytes: file.bytes.subarray(at, at + MIB) })
    }
    const step = readMatroska(ahead, file.bytes.length)
    if (!('done' in step)) throw new Error('expected the index')
    expect(plain(step.done)).toEqual(plain(exact.index))
  })

  it('needs no read when the whole file is in the head', () => {
    const file = movie({
      duration: undefined,
      tracks: [VP9, opus(2)],
      clusters: [
        { timestamp: 0, frames: start() },
        { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true }), frame(1, 1033)] },
      ],
    })
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([])
    // The picture's last frame is at 1033 and lasts 33 ticks when rounded; the sound's last end is 60.
    expect(index.durationSeconds).toBe(1.066)
  })

  it('reads back from the end when the last cluster is larger than the tail, and takes its end', () => {
    const file = movie({
      duration: undefined,
      tracks: [VP9, opus(2)],
      clusters: [
        { timestamp: 0, frames: start() },
        { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true, size: 2 * MIB })] },
      ],
    })
    const { index, asks } = open(file.bytes)
    const end = file.bytes.length
    // The last cluster starts a little before 2 MiB from the end: the second megabyte back is the second read, and the window after it (4 MiB from the end) is held by the head.
    expect(asks).toEqual([
      { start: end - MIB, end },
      { start: end - 2 * MIB, end: end - MIB },
    ])
    expect(index.lastCluster).toEqual({ start: file.clusters[1]?.start, timestamp: 1000 })
    // The picture's frame is presented at 1000 and lasts 33.333333 ticks, 33 when rounded.
    expect(index.durationSeconds).toBe(1.033)
  })

  it('does not look before the first Cluster', () => {
    const file = movie({
      duration: undefined,
      tracks: [VP9, opus(2)],
      tags: [1.5 * MIB],
      clusters: [{ timestamp: 0, frames: start() }],
    })
    const first = file.clusters[0]?.start ?? NaN
    const { index, asks } = open(file.bytes)
    // The last megabyte starts before the first Cluster, and the tail starts at the Cluster: the one ask is the head's own, for the header after the Tags, which holds the rest of the file.
    expect(file.bytes.length - MIB).toBeLessThan(first)
    expect(asks).toEqual([{ start: first, end: file.bytes.length }])
    expect(index.durationSeconds).toBe(0.133)
  })
})

describe('the duration, read back from the end when Info has none (§10.4)', () => {
  /** Ten clusters of one picture, a second apart. Each holds a keyframe, a frame, a padding frame of `pad` bytes (the last cluster's, of `lastPad` when given) and three more frames, the last presented 167 ms into the cluster, so a cluster is a little over `pad` bytes. */
  function tenClusters(pad: number, unknown: boolean, lastPad = pad): MovieCluster[] {
    return Array.from({ length: 10 }, (_, at) => {
      const time = at * 1000
      return {
        timestamp: time,
        unknown,
        frames: [
          frame(1, time, { keyframe: true, data: key() }),
          frame(1, time + 33),
          frame(1, time + 67, { size: at === 9 ? lastPad : pad }),
          frame(1, time + 100),
          frame(1, time + 133),
          frame(1, time + 167),
        ],
      }
    })
  }

  /** A recording whose Info has no Duration and which has no Cues, as one that was cut off leaves it. */
  function recording(pad: number, unknown: boolean, lastPad = pad): Movie {
    return movie({
      duration: undefined,
      tracks: [VP9],
      clusters: tenClusters(pad, unknown, lastPad),
    })
  }

  /** The windows of a search back from `end`, as many as `count`: a megabyte, then the megabyte before it, then the 2, 4 and 8 before those, each ending where the one before began. */
  function windows(end: number, count: number): ByteRange[] {
    return Array.from({ length: count }, (_, at) =>
      at === 0
        ? { start: end - MIB, end }
        : { start: end - 2 ** at * MIB, end: end - 2 ** (at - 1) * MIB },
    )
  }

  /** A file from `from` on, in ranges of a megabyte that touch: what a caller that has read it ahead holds. */
  function chunked(bytes: Uint8Array, from = 0): ByteRange[] {
    const out: ByteRange[] = []
    for (let at = from; at < bytes.length; at += MIB) {
      out.push({ start: at, end: Math.min(at + MIB, bytes.length) })
    }
    return out
  }

  // The last cluster is the tenth, whose Timestamp is 9000. Its frames are at 9000, 9033, 9067 (the padding), 9100, 9133 and 9167, and a frame lasts 33.333333 ticks of a millisecond (33 when rounded), so a whole file ends at 9200. A cut inside the last frame (a block of 14 bytes) leaves 9133, which ends at 9166; one inside the padding leaves 9033, which ends at 9066.
  // The windows needed are of what lies from the last cluster's start (a little over its padding) to the end: the first megabyte, the next, then 2, 4 and 8 more, so that 2 MiB and a little needs 3 windows and 5 MiB and a little needs 4; half of each (a cut inside the padding) needs 2 and 3.
  const layouts: {
    name: string
    unknown: boolean
    cut: (last: ByteRange) => number
    seconds: number
    windows: Record<number, number>
  }[] = [
    {
      name: 'a whole file',
      unknown: false,
      cut: (last) => last.end,
      seconds: 9.2,
      windows: { 2: 3, 5: 4 },
    },
    {
      name: 'a file cut off inside its last frame',
      unknown: false,
      cut: (last) => last.end - 5,
      seconds: 9.166,
      windows: { 2: 3, 5: 4 },
    },
    {
      name: 'a file cut off inside its last cluster, in the padding',
      unknown: false,
      cut: (last) => last.start + Math.floor((last.end - last.start) / 2),
      seconds: 9.066,
      windows: { 2: 2, 5: 3 },
    },
    {
      name: 'a whole file of clusters of unknown size',
      unknown: true,
      cut: (last) => last.end,
      seconds: 9.2,
      windows: { 2: 3, 5: 4 },
    },
    {
      name: 'a file of clusters of unknown size cut off inside the last, in the padding',
      unknown: true,
      cut: (last) => last.start + Math.floor((last.end - last.start) / 2),
      seconds: 9.066,
      windows: { 2: 2, 5: 3 },
    },
  ]

  describe.each([2, 5])('with clusters of %i MiB', (mib) => {
    it.each(layouts)(
      'finds the last cluster and the end of its last whole frame in $name',
      (layout) => {
        const file = recording(mib * MIB, layout.unknown)
        const last = file.clusters[9]
        if (last === undefined) throw new Error('expected ten clusters')
        const bytes = file.bytes.subarray(0, layout.cut(last))
        const count = layout.windows[mib] ?? NaN
        const { index, asks } = open(bytes)
        expect(index.durationSeconds).toBe(layout.seconds)
        expect(index.lastCluster).toEqual({ start: last.start, timestamp: 9000 })
        // Nothing is asked for but the windows, and each is a read.
        expect(asks).toEqual(windows(bytes.length, count))
        expect(index.reads).toBe(count)
        expect(index.reads).toBeLessThanOrEqual(MAX_INDEX_READS)
      },
    )
  })

  it('finds a last cluster whose header lies across the boundary of two windows, for the search is of the whole tail and not of the new window', () => {
    // The last cluster is made to start 6 bytes before the megabyte that ends the file: its ID and the first 2 bytes of its size are in the second window, and the rest of its header, with the Timestamp, is in the first.
    const sized = recording(MIB, false)
    const measured = sized.clusters[9]
    if (measured === undefined) throw new Error('expected ten clusters')
    const padding = MIB + (MIB + 6) - (measured.end - measured.start)
    const file = recording(MIB, false, padding)
    const last = file.clusters[9]
    expect(file.bytes.length - (last?.start ?? NaN)).toBe(MIB + 6)
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual(windows(file.bytes.length, 2))
    expect(index.lastCluster).toEqual({ start: last?.start, timestamp: 9000 })
    expect(index.durationSeconds).toBe(9.2)
  })

  describe('when the last cluster is cut off before its first frame', () => {
    // The ninth cluster (Timestamp 8000) ends at 8167 + 33 = 8200; the tenth is the last, and the cut leaves it no whole frame.
    it.each([9, 12])(
      'takes the end of the cluster before it, and names the last, when the file ends %i bytes into it',
      (into) => {
        // The header of a cluster of a few frames is 9 bytes (its ID, a size of 1 byte and the Timestamp), and the first block, the keyframe's, follows: 12 bytes is inside it.
        const file = recording(8, false)
        const last = file.clusters[9]
        const header = readHeader(file.bytes, last?.start ?? NaN, file.bytes.length)
        const stamp = readHeader(file.bytes, header?.data ?? NaN, file.bytes.length)
        expect((stamp?.end ?? NaN) - (last?.start ?? NaN)).toBe(9)
        const { index, asks } = open(file.bytes.subarray(0, (last?.start ?? NaN) + into))
        expect(asks).toEqual([])
        expect(index.lastCluster).toEqual({ start: last?.start, timestamp: 9000 })
        expect(index.durationSeconds).toBe(8.2)
      },
    )

    it('has no cluster there when the file ends in the Timestamp, so the cluster before is the last', () => {
      const file = recording(8, false)
      const last = file.clusters[9]
      const { index } = open(file.bytes.subarray(0, (last?.start ?? NaN) + 8))
      expect(index.lastCluster).toEqual({ start: file.clusters[8]?.start, timestamp: 8000 })
      expect(index.durationSeconds).toBe(8.2)
    })

    it('reads back another window when the cluster before starts outside the first, and gives the same end', () => {
      // The clusters are 2 MiB and a little: the file ends 20 bytes into the tenth, inside its keyframe's block. The first window holds the tenth's header and the last megabyte of the ninth, the second the middle of the ninth, and the ninth's start is in the third.
      const file = recording(2 * MIB, false)
      const last = file.clusters[9]
      const bytes = file.bytes.subarray(0, (last?.start ?? NaN) + 20)
      const { index, asks } = open(bytes)
      expect(asks).toEqual(windows(bytes.length, 3))
      expect(index.reads).toBe(3)
      expect(index.lastCluster).toEqual({ start: last?.start, timestamp: 9000 })
      expect(index.durationSeconds).toBe(8.2)
    })

    it('names the last cluster and gives no duration when the open has no read left to go back for the cluster before', () => {
      // A cluster of 2 MiB and a little before the last, which is cut 15 bytes in (inside its keyframe's block), behind 10 reads of the head and a cluster of 1.5 MiB (so that the head's own megabyte from the first Cluster holds nothing of the window cut at the first Cluster): the first two windows are the 11th and 12th and hold none of the cluster before, and the third, which would, is the 13th, which is not asked for.
      const file = movie({
        duration: undefined,
        tracks: [VP9],
        tags: [1.25 * MIB, ...Array.from({ length: 8 }, () => 100 * 1024)],
        clusters: [
          { timestamp: 0, frames: start().filter((one) => one.track === 1) },
          {
            timestamp: 500,
            frames: [
              frame(1, 500, { keyframe: true, data: key() }),
              frame(1, 533, { size: 1.5 * MIB }),
            ],
          },
          {
            timestamp: 1000,
            frames: [
              frame(1, 1000, { keyframe: true, data: key() }),
              frame(1, 1033, { size: 2 * MIB }),
              frame(1, 1067),
            ],
          },
          { timestamp: 2000, frames: [frame(1, 2000, { keyframe: true, data: key() })] },
        ],
      })
      const last = file.clusters[3]
      const bytes = file.bytes.subarray(0, (last?.start ?? NaN) + 15)
      const { index, asks } = open(bytes)
      expect(asks).toHaveLength(MAX_INDEX_READS)
      expect(asks.slice(10)).toEqual(windows(bytes.length, 2))
      expect(index.reads).toBe(MAX_INDEX_READS)
      expect(index.lastCluster).toEqual({ start: last?.start, timestamp: 2000 })
      expect(index.durationSeconds).toBeNull()
    })
  })

  it('is the same index, with the same reads, when the caller has read the file ahead or part of it', () => {
    const file = recording(5 * MIB, false)
    const exact = open(file.bytes)
    const all = open(file.bytes, { ahead: chunked(file.bytes) })
    expect(all.asks).toEqual([])
    expect(plain(all.index)).toEqual(plain(exact.index))
    expect(all.index.reads).toBe(4)
    // The last 3 MiB, 1 MiB at a time: the window of 2 MiB before them is held in part, and is asked for whole.
    const part = open(file.bytes, { ahead: chunked(file.bytes, file.bytes.length - 3 * MIB) })
    expect(plain(part.index)).toEqual(plain(exact.index))
    expect(part.asks).toEqual(windows(file.bytes.length, 4).slice(2))
  })

  it('asks for nothing at the end when Info has a Duration, and names no last cluster', () => {
    const file = movie({
      tracks: [VP9],
      clusters: [
        { timestamp: 0, frames: start().filter((one) => one.track === 1) },
        { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true, size: 3 * MIB })] },
      ],
    })
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([])
    expect(index.reads).toBe(0)
    expect(index.durationSeconds).toBe(4.021)
    expect(index.lastCluster).toBeNull()
  })

  describe("within the open's reads", () => {
    /** Two clusters: a small one, and a last of `pad` bytes and a little more, behind Tags that take `headReads` reads of the head to pass (the first lies past the head's megabyte, and each of the others is further than one header read from the one before). The last frame is presented at 1100, which ends at 1133. */
    function behindTags(headReads: number, pad: number): Movie {
      return movie({
        duration: undefined,
        tracks: [VP9],
        tags: [1.25 * MIB, ...Array.from({ length: headReads - 2 }, () => 100 * 1024)],
        clusters: [
          { timestamp: 0, frames: start().filter((one) => one.track === 1) },
          {
            timestamp: 1000,
            frames: [
              frame(1, 1000, { keyframe: true, data: key() }),
              frame(1, 1033),
              frame(1, 1067, { size: pad }),
              frame(1, 1100),
            ],
          },
        ],
      })
    }

    it('takes the 12th read for the last window it can, and finds the cluster that lies in the window after it', () => {
      // A last cluster of 16 MiB and a little: the windows of 1, 1, 2, 4 and 8 MiB reach its padding (5 reads), and the window after them, of the 16 MiB before, is cut to start at the first Cluster, where the head's own read of the header already holds it (no read). The head took 7.
      const file = behindTags(7, 16 * MIB)
      const { index, asks } = open(file.bytes)
      expect(asks).toHaveLength(MAX_INDEX_READS)
      expect(asks.slice(7)).toEqual(windows(file.bytes.length, 5))
      expect(index.reads).toBe(MAX_INDEX_READS)
      expect(index.durationSeconds).toBe(1.133)
      expect(index.lastCluster).toEqual({ start: file.clusters[1]?.start, timestamp: 1000 })
    })

    it('stops without a duration, and opens, when the next window would be the 13th read', () => {
      // The same file behind one more read of the head: the window of 8 MiB is the 13th, and is not asked for.
      const file = behindTags(8, 16 * MIB)
      const { index, asks } = open(file.bytes)
      expect(asks).toHaveLength(MAX_INDEX_READS)
      expect(asks.slice(8)).toEqual(windows(file.bytes.length, 4))
      expect(index.reads).toBe(MAX_INDEX_READS)
      expect(index.durationSeconds).toBeNull()
      expect(index.lastCluster).toBeNull()
      expect(index.video.codec).toBe('vp09.00.20.08.01.02.02.02.00')
      // A caller that has read it all ahead is given the same index.
      const all = open(file.bytes, { ahead: chunked(file.bytes) })
      expect(plain(all.index)).toEqual(plain(index))
    })

    it('opens a file whose last cluster is 64 MiB and a little, with no duration, when the head left too few reads', () => {
      // The windows of 1, 1, 2, 4, 8 and 16 MiB are the 7th to the 12th read; the cluster is in the window of 32 MiB after them.
      const file = behindTags(6, 64 * MIB)
      const { index, asks } = open(file.bytes)
      expect(asks).toHaveLength(MAX_INDEX_READS)
      expect(asks.slice(6)).toEqual(windows(file.bytes.length, 6))
      expect(index.durationSeconds).toBeNull()
      expect(index.lastCluster).toBeNull()
      expect(index.reads).toBe(MAX_INDEX_READS)
    })
  })
})

describe('the reads that opening a file takes (the cap)', () => {
  /** A file with this many Tags of 2 MiB before its first Cluster, which take a read each to pass. The Cluster is larger than the header read that follows the last of them, so that the first frames are a read of their own. */
  function tagged(count: number): Movie {
    return movie({
      tracks: [VP9, opus(2)],
      tags: Array.from({ length: count }, () => 2 * MIB),
      clusters: [
        {
          timestamp: 0,
          frames: [
            frame(1, 0, { keyframe: true, data: key(100 * 1024) }),
            frame(2, 0, { keyframe: true }),
            frame(1, 33, { size: 100 * 1024 }),
            frame(2, 20, { keyframe: true }),
          ],
        },
      ],
    })
  }

  /** The whole file read ahead, in chunks of a megabyte that touch. */
  function ahead(bytes: Uint8Array): Chunk[] {
    const chunks: Chunk[] = []
    for (let at = 0; at < bytes.length; at += MIB) {
      chunks.push({ start: at, bytes: bytes.subarray(at, at + MIB) })
    }
    return chunks
  }

  it('opens a file that needs exactly 12 reads: the head takes 11, and the first frames are the 12th', () => {
    const file = tagged(MAX_INDEX_READS - 1)
    const { index, asks } = open(file.bytes)
    expect(asks).toHaveLength(MAX_INDEX_READS)
    expect(index.reads).toBe(MAX_INDEX_READS)
    expect(index.video.codec).toBe('vp09.00.20.08.01.02.02.02.00')
    // A caller that has read it all is no worse off, and no better.
    const step = readMatroska(ahead(file.bytes), file.bytes.length)
    expect('done' in step && step.done.reads).toBe(MAX_INDEX_READS)
  })

  it('refuses a file whose first frames would be the 13th read, with a sentence that names the cap', () => {
    const file = tagged(MAX_INDEX_READS)
    const asks: ByteRange[] = []
    const error = refused('damaged', () => open(file.bytes, { asks }))
    expect(asks).toHaveLength(MAX_INDEX_READS)
    expect(error.message).toContain(String(MAX_INDEX_READS))
    expect(error.message).toMatch(/reads/)
  })

  it('counts what the open needed, not what the caller read ahead', () => {
    const file = tagged(MAX_INDEX_READS)
    refused('damaged', () => readMatroska(ahead(file.bytes), file.bytes.length))
  })

  it('refuses a file whose head and first frames add up to more than the cap', () => {
    // The head takes 10 reads; the first frames take 3 more, for the picture has frames of a megabyte.
    const times = [0, 100, 33, 67]
    const file = movie({
      tracks: [
        {
          number: 1,
          type: 1,
          codecId: 'V_MPEG4/ISO/AVC',
          codecPrivate: fromHex(X264_B_FRAMES),
          defaultDuration: 33_333_333,
          video: { pixelWidth: 320, pixelHeight: 240 },
        },
      ],
      tags: Array.from({ length: 10 }, () => 2 * MIB),
      clusters: [
        {
          timestamp: 0,
          frames: times.map((time, at) => frame(1, time, { keyframe: at === 0, size: MIB })),
        },
      ],
    })
    const asks: ByteRange[] = []
    const error = refused('damaged', () => open(file.bytes, { asks }))
    // 10 for the head and 2 for the first frames; the third window is the 13th read, and is not asked for.
    expect(asks).toHaveLength(MAX_INDEX_READS)
    expect(error.message).toContain(String(MAX_INDEX_READS))
  })
})

describe('what the open counts as a read', () => {
  it('counts nothing for the Tracks that a SeekHead names, when the head already read the bytes', () => {
    // The Tracks are after the Cluster, behind more Tags: the head reads the header after the first Tags (1), and the header at the Tracks, whose 64 KiB hold the whole element (2). The first frames are another read (3); the Tracks are none.
    const blocks = start().map((one) =>
      simpleBlock({
        track: one.track,
        timecode: one.time,
        frames: [one.data ?? new Uint8Array(8)],
        keyframe: one.keyframe,
      }),
    )
    const file = matroskaFile([
      (at) =>
        seekHead([
          [ID.Info, at[1] ?? 0],
          [ID.Tracks, at[5] ?? 0],
        ]),
      info({ duration: 4021 }),
      element(ID.Tags, new Uint8Array(2 * MIB)),
      cluster(0, blocks),
      element(ID.Tags, new Uint8Array(100_000)),
      tracksElement([trackEntry(VP9), trackEntry(opus(2))]),
    ])
    const first = file.offsets[3] ?? NaN
    const tracks = file.offsets[5] ?? NaN
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([
      { start: first, end: first + HEADER_READ },
      { start: tracks, end: file.bytes.length },
      { start: first, end: file.bytes.length },
    ])
    expect(index.reads).toBe(3)
    expect(index.firstCluster).toBe(first)
    expect(index.video.codec).toBe('vp09.00.20.08.01.02.02.02.00')
  })

  it("counts nothing for the first frames that the head's header read holds", () => {
    // 3 MiB of Tags, and a Cluster that the 64 KiB read after them holds to the file's end: that read is the only one.
    const file = movie({
      tracks: [VP9, opus(2)],
      tags: [TAGS],
      clusters: [{ timestamp: 0, frames: start() }],
    })
    const { index, asks } = open(file.bytes)
    expect(asks).toHaveLength(1)
    expect(index.reads).toBe(1)
  })

  it('counts nothing for the tail that the first frames read already reached', () => {
    // A file of a little over 3 MiB with no Duration, and a sound with no frame, so that the first frames are read to the Segment's end in 3 windows. The last megabyte is in them.
    const frames = (at: number): MovieFrame[] => [
      frame(1, at * 1000, {
        keyframe: at === 0,
        data: at === 0 ? key(640 * 1024) : undefined,
        size: 640 * 1024,
      }),
    ]
    const file = movie({
      duration: undefined,
      tracks: [VP9, opus(2)],
      clusters: [0, 1, 2, 3, 4].map((at) => ({ timestamp: at * 1000, frames: frames(at) })),
    })
    const { index, asks } = open(file.bytes)
    expect(file.bytes.length).toBeGreaterThan(3 * MIB)
    expect(asks).toEqual([
      { start: MIB, end: 2 * MIB },
      { start: 2 * MIB, end: 3 * MIB },
      { start: 3 * MIB, end: file.bytes.length },
    ])
    expect(index.reads).toBe(3)
    // The last frame is at 4000 ms and lasts 33.333333 ticks, 33 when rounded.
    expect(index.durationSeconds).toBe(4.033)
  })

  it('counts the tail when the first frames did not reach it', () => {
    const file = movie({
      duration: undefined,
      tracks: [VP9, opus(2)],
      clusters: [
        { timestamp: 0, frames: start() },
        { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true, size: 1.5 * MIB })] },
        { timestamp: 2000, frames: [frame(1, 2000, { keyframe: true })] },
      ],
    })
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([{ start: file.bytes.length - MIB, end: file.bytes.length }])
    expect(index.reads).toBe(1)
  })
})

describe('the Tracks element', () => {
  it('is asked for whole when the head does not hold it', () => {
    // Tracks of 100 000 bytes with a head of 256: the head finds where the Tracks end and where the Cluster is, and the Tracks themselves are another ask.
    const file = movie({
      tracks: [VP9, opus(2), { number: 3, type: 17, extra: [new Uint8Array(100_000)] }],
      clusters: [{ timestamp: 0, frames: start() }],
    })
    const { index, asks } = open(file.bytes, { head: 256 })
    expect(asks).toEqual([{ start: file.tracks.end, end: file.bytes.length }, file.tracks])
    // The head holds less, so it took more reads to open; the rest is the same.
    expect(plain({ ...index, reads: 0 })).toEqual(plain({ ...open(file.bytes).index, reads: 0 }))
  })

  it('refuses one larger than 16 MiB without asking for it', () => {
    const file = movie({
      tracks: [VP9, opus(2), { number: 3, type: 17, extra: [new Uint8Array(17 * MIB)] }],
      clusters: [{ timestamp: 0, frames: start() }],
    })
    const asks: ByteRange[] = []
    const error = refused('damaged', () => open(file.bytes, { asks }))
    expect(asks.every((ask) => ask.start >= file.tracks.end)).toBe(true)
    expect(error.message).toContain('Tracks')
  })

  it('is read for the entries up to MAX_TRACK_ENTRIES when it holds 16 MiB of empty ones after the picture and a sound, and the file opens at once', () => {
    // 8 million entries of an ID and a size of 0 each, built in a loop, as the Tracks element's last child.
    const empties = new Uint8Array(16 * MIB - 4096)
    for (let at = 0; at < empties.length; at += 2) {
      empties[at] = ID.TrackEntry
      empties[at + 1] = 0x80
    }
    const blocks = start().map((one) =>
      simpleBlock({
        track: one.track,
        timecode: one.time,
        frames: [one.data ?? new Uint8Array(8)],
        keyframe: one.keyframe,
      }),
    )
    const file = matroskaFile([
      info({ duration: 4021 }),
      tracksElement([trackEntry(VP9), trackEntry(opus(2)), empties]),
      cluster(0, blocks),
    ])

    const before = performance.now()
    const { index } = open(file.bytes)
    const took = performance.now() - before

    expect(took).toBeLessThan(2000)
    expect(index.video.header.id).toBe(1)
    expect(index.soundTracks.map((track) => track.header.id)).toEqual([2])
  }, 120_000)

  describe('when the entry of a track holds 16 MiB of empty elements (MAX_ENTRY_CHILDREN)', () => {
    // 8 million elements of the ID 0x80 and a size of 0 each (every byte is 0x80), as the last children of one entry.
    const flood = new Uint8Array(16 * MIB - 8192).fill(0x80)
    const blocks = start().map((one) =>
      simpleBlock({
        track: one.track,
        timecode: one.time,
        frames: [one.data ?? new Uint8Array(8)],
        keyframe: one.keyframe,
      }),
    )
    const fileOf = (tracks: Uint8Array[]): Uint8Array =>
      matroskaFile([info({ duration: 4021 }), tracksElement(tracks), cluster(0, blocks)]).bytes

    it('opens the file and offers the sound of that entry as one that does not play, when another track is the picture', () => {
      const bytes = fileOf([
        trackEntry(VP9),
        trackEntry({ ...opus(2), extra: [flood] }),
        trackEntry(opus(3)),
      ])
      const before = performance.now()
      const { index } = open(bytes)
      const took = performance.now() - before

      expect(took).toBeLessThan(2000)
      expect(index.video.header.id).toBe(1)
      expect(index.sounds).toHaveLength(2)
      const flooded = turnedAway(index.sounds[0])
      expect(flooded.reason).toBe('damaged')
      expect(flooded.message.startsWith(SOUND_SENTENCE)).toBe(true)
      expect(flooded.message).toContain('more than 1024 children')
      expect(playable(index.sounds[1]).id).toBe(3)
    }, 120_000)

    it('refuses the file as having a picture that cannot be read, when the entry is the first picture', () => {
      const bytes = fileOf([trackEntry({ ...VP9, extra: [flood] }), trackEntry(opus(2))])
      const error = refused('damaged', () => open(bytes))
      expect(error.message.startsWith(PICTURE_SENTENCE)).toBe(true)
      expect(error.message).toContain('more than 1024 children')
    }, 120_000)
  })
})

describe('the Cues', () => {
  it('are the head: where only a SeekHead says they are, unread', () => {
    const file = movie({
      seek: true,
      cues: true,
      tracks: [VP9, opus(2)],
      clusters: [{ timestamp: 0, frames: start() }],
    })
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([])
    expect(index.cues).toEqual({ start: file.cues, end: null })
  })

  it('are none when nothing says where they are', () => {
    const file = movie({
      cues: true,
      tracks: [VP9, opus(2)],
      clusters: [{ timestamp: 0, frames: start() }],
    })
    expect(open(file.bytes).index.cues).toBeNull()
  })
})

describe('the picture that cannot play', () => {
  const clip = [{ timestamp: 0, frames: start() }]

  it('turns away a file with no picture', () => {
    const file = movie({
      tracks: [opus(2)],
      clusters: [{ timestamp: 0, frames: [frame(2, 0, { keyframe: true })] }],
    })
    refused('no-picture', () => open(file.bytes))
  })

  it('refuses a codec that no browser plays in MP4, before it reads a frame', () => {
    const file = movie({
      tracks: [{ ...VP9, codecId: 'V_VP8' }, opus(2)],
      clusters: clip,
    })
    const asks: ByteRange[] = []
    const error = refused('unsupported-codec', () => open(file.bytes, { asks }))
    expect(error.message.startsWith(PICTURE_SENTENCE)).toBe(true)
    expect(error.message).toContain('V_VP8')
    expect(asks).toEqual([])
  })

  it('is damaged when the track could not be read, with the sentence the picture gets', () => {
    const file = movie({
      tracks: [{ ...VP9, video: { pixelHeight: 240 } }, opus(2)],
      clusters: clip,
    })
    const error = refused('damaged', () => open(file.bytes))
    expect(error.message.startsWith(PICTURE_SENTENCE)).toBe(true)
  })

  it('keeps the reason of a track that was read and refused, and says the sentence once', () => {
    const file = movie({
      tracks: [{ ...VP9, encodings: [{ compression: { algo: 1 } }] }, opus(2)],
      clusters: clip,
    })
    const error = refused('unsupported-codec', () => open(file.bytes))
    expect(error.message.startsWith(PICTURE_SENTENCE)).toBe(true)
    expect(error.message.lastIndexOf(PICTURE_SENTENCE)).toBe(0)
    expect(error.message).toContain('bzlib')
  })

  it('is damaged when its configuration cannot give the reorder depth', () => {
    const file = movie({
      tracks: [{ ...VP9, codecId: 'V_MPEG4/ISO/AVC' }, opus(2)],
      clusters: clip,
    })
    const asks: ByteRange[] = []
    const error = refused('damaged', () => open(file.bytes, { asks }))
    expect(error.message.startsWith(PICTURE_SENTENCE)).toBe(true)
    expect(error.message).toContain('CodecPrivate')
    expect(asks).toEqual([])
  })

  it('is damaged when none of its first frames is a keyframe', () => {
    const file = movie({
      tracks: [VP9, opus(2)],
      clusters: [
        {
          timestamp: 0,
          frames: [frame(1, 0), frame(1, 33), frame(2, 0, { keyframe: true })],
        },
      ],
    })
    const error = refused('damaged', () => open(file.bytes))
    expect(error.message.startsWith(PICTURE_SENTENCE)).toBe(true)
    expect(error.message).toContain('no keyframe in the first 4 MiB of clusters')
  })

  it('is damaged when the keyframe it is made from is no keyframe of its codec', () => {
    const file = movie({
      tracks: [VP9, opus(2)],
      clusters: [
        {
          timestamp: 0,
          frames: [frame(1, 0, { keyframe: true, data: [1, 2, 3] }), frame(1, 33)],
        },
      ],
    })
    const error = refused('damaged', () => open(file.bytes))
    expect(error.message.startsWith(PICTURE_SENTENCE)).toBe(true)
  })
})

describe('a picture that does not begin at a keyframe', () => {
  it('starts at its first keyframe, as the cursor will, and makes its entry from it', () => {
    const { index } = open(
      movie({
        tracks: [VP9, opus(2)],
        clusters: [
          {
            timestamp: 0,
            frames: [
              frame(1, 0),
              frame(2, 0, { keyframe: true }),
              frame(1, 33, { keyframe: true, data: key() }),
              frame(1, 67),
            ],
          },
        ],
      }).bytes,
    )
    expect(index.video.codecNames).toEqual(['vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'])
    expect(index.video.read.shift).toBe(0)
  })

  it('counts the frames it needs from the keyframe, and so reads on for them', () => {
    // The leading frame is a megabyte; the keyframe and the frame after it are a megabyte each behind it, so 2 frames from the keyframe are not in the first 2 MiB.
    const file = movie({
      tracks: [VP9],
      clusters: [
        {
          timestamp: 0,
          frames: [
            frame(1, 0, { size: MIB }),
            frame(1, 33, { keyframe: true, data: key(MIB) }),
            frame(1, 67, { size: MIB }),
            frame(1, 100, { size: MIB }),
          ],
        },
      ],
    })
    const { asks } = open(file.bytes)
    expect(asks).toEqual([
      { start: MIB, end: 2 * MIB },
      { start: 2 * MIB, end: 3 * MIB },
      { start: 3 * MIB, end: 4 * MIB },
    ])
  })
})

describe('the sounds that cannot play', () => {
  /** A clip whose sounds are these tracks, each with a frame. */
  function clip(sounds: number[]): { timestamp: number; frames: MovieFrame[] }[] {
    return [
      {
        timestamp: 0,
        frames: [
          ...start(sounds[0] ?? 2),
          ...sounds.slice(1).map((number) => frame(number, 0, { keyframe: true })),
        ],
      },
    ]
  }

  it('offers a sound that could not be read as damaged, and goes on to the next', () => {
    const { index } = open(
      movie({
        tracks: [
          VP9,
          { number: 2, type: 2, audio: { samplingFrequency: 48000, channels: 2 } },
          opus(3),
        ],
        clusters: clip([2, 3]),
      }).bytes,
    )
    const error = turnedAway(index.sounds[0])
    expect(error.reason).toBe('damaged')
    expect(error.message.startsWith(SOUND_SENTENCE)).toBe(true)
    expect(index.sounds[0]).toMatchObject({ id: 2 })
    expect(playable(index.sounds[1])).toMatchObject({ id: 3 })
    expect(index.sound).toBeNull()
    expect(index.soundTracks.map((track) => track.header.id)).toEqual([3])
  })

  it('offers a sound that was read and refused with its sentence once, and its reason', () => {
    const { index } = open(
      movie({
        tracks: [VP9, opus(2, { encodings: [{ compression: { algo: 2 } }] })],
        clusters: clip([2]),
      }).bytes,
    )
    const error = turnedAway(index.sounds[0])
    expect(error.reason).toBe('unsupported-codec')
    expect(error.message.lastIndexOf(SOUND_SENTENCE)).toBe(0)
    expect(error.message).toContain('lzo1x')
  })

  it('offers a sound whose entry is damaged as refused, with the sentence', () => {
    const { index } = open(
      movie({
        tracks: [VP9, opus(2, { codecPrivate: undefined })],
        clusters: clip([2]),
      }).bytes,
    )
    const error = turnedAway(index.sounds[0])
    expect(error.reason).toBe('damaged')
    expect(error.message.startsWith(SOUND_SENTENCE)).toBe(true)
  })

  it("refuses a sound that has the picture's number, for their frames could not be told apart", () => {
    const { index } = open(
      movie({
        tracks: [VP9, opus(1)],
        clusters: [{ timestamp: 0, frames: start(2) }],
      }).bytes,
    )
    const error = turnedAway(index.sounds[0])
    expect(error.reason).toBe('damaged')
    expect(error.message).toContain('TrackNumber')
    expect(index.soundTracks).toEqual([])
  })
})

describe("the timing of a track's first frames", () => {
  it('shifts a sound whose first frame is before 0 by that, on top of its pre-skip', () => {
    const { index } = open(
      movie({
        tracks: [VP9, opus(2)],
        clusters: [
          {
            timestamp: 0,
            frames: [
              frame(1, 0, { keyframe: true, data: key() }),
              frame(2, -7, { keyframe: true }),
              frame(1, 33),
              frame(2, 13, { keyframe: true }),
            ],
          },
        ],
      }).bytes,
    )
    expect(index.soundTracks[0]?.read.shift).toBe(7)
    expect(index.soundTracks[0]?.timing.offsetSeconds).toBeCloseTo(-0.0135, 9)
  })

  it('takes the length of a frame from the least gap between the first ones when the track has no DefaultDuration', () => {
    const { index } = open(
      movie({
        tracks: [{ ...VP9, defaultDuration: undefined }, opus(2, { defaultDuration: undefined })],
        clusters: [
          {
            timestamp: 0,
            frames: [
              frame(1, 0, { keyframe: true, data: key() }),
              frame(2, 0, { keyframe: true }),
              frame(1, 40),
              frame(2, 21, { keyframe: true }),
              frame(1, 90),
              frame(2, 40, { keyframe: true }),
            ],
          },
        ],
      }).bytes,
    )
    expect(index.video.read).toMatchObject({ frameTicks: 40, defaultDuration: null })
    expect(index.soundTracks[0]?.read).toMatchObject({ frameTicks: 19, defaultDuration: null })
  })

  it('takes 1 where there is no gap to measure, and plays a sound that has no frame', () => {
    const { index } = open(
      movie({
        tracks: [{ ...VP9, defaultDuration: undefined }, opus(2, { defaultDuration: undefined })],
        clusters: [{ timestamp: 0, frames: [frame(1, 0, { keyframe: true, data: key() })] }],
      }).bytes,
    )
    // Only a codec that is made from its first frame needs one: this sound plays from 0.
    expect(index.video.read.frameTicks).toBe(1)
    expect(index.soundTracks[0]?.read).toMatchObject({ frameTicks: 1, shift: 0 })
    expect(index.sound).toBe(index.soundTracks[0])
  })

  it('counts a shift in nanoseconds when a second is not a whole number of ticks', () => {
    const { index } = open(
      movie({
        scale: 333_333,
        tracks: [VP9, opus(2, { codecDelay: 0 })],
        clusters: [
          {
            timestamp: 0,
            frames: [
              frame(1, 0, { keyframe: true, data: key() }),
              frame(2, -3, { keyframe: true }),
              frame(1, 3),
            ],
          },
        ],
      }).bytes,
    )
    // The tracks count in nanoseconds then: 3 ticks of 333 333 ns are 999 999 ns, which come off the offset as seconds.
    expect(index.video.header.timescale).toBe(1e9)
    expect(index.soundTracks[0]?.header.timescale).toBe(1e9)
    expect(index.soundTracks[0]?.read.shift).toBe(999_999)
    expect(index.soundTracks[0]?.timing.offsetSeconds).toBeCloseTo(-0.000999999, 12)
    expect(index.soundTracks[0]?.read.frameTicks).toBe(20_000_000 / 333_333)
  })
})
