import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import type { Mp4Refusal } from '../errors.ts'
import { heldBytes } from '../source.ts'
import type { ByteRange, Chunk, SoundOffer } from '../source.ts'
import { bits, concat } from '../testing/build.ts'
import { matroskaMovie } from '../testing/ebml.ts'
import type { Movie, MovieFrame, MovieSpec, TrackSpec } from '../testing/ebml.ts'
import { ac3Config } from './frameheaders.ts'
import { HEADER_READ, MAX_INDEX_READS } from './limits.ts'
import { readMatroska } from './read.ts'
import type { MatroskaIndex, MatroskaPlayTrack } from './read.ts'

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
 * that a test can count them.
 */
function open(
  bytes: Uint8Array,
  { head = HEAD, asks = [] }: { head?: number; asks?: ByteRange[] } = {},
): Opened {
  const chunks: Chunk[] = [{ start: 0, bytes: bytes.subarray(0, Math.min(head, bytes.length)) }]
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
    // The 2 frames it has are pts 0 and 100, in a stream that ends there: the last gets the least pts and the first one frame less.
    expect(index.video.read).toMatchObject({ depth: 2, shift: 33 })
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

  it('is null when the tail holds no cluster, as when the last one is larger than the tail', () => {
    const file = movie({
      duration: undefined,
      tracks: [VP9, opus(2)],
      clusters: [
        { timestamp: 0, frames: start() },
        { timestamp: 1000, frames: [frame(1, 1000, { keyframe: true, size: 2 * MIB })] },
      ],
    })
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([{ start: file.bytes.length - MIB, end: file.bytes.length }])
    expect(index.durationSeconds).toBeNull()
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

describe('the reads that opening a file takes (the cap)', () => {
  /** A file with this many Tags of 2 MiB before its first Cluster, which take a read each to pass. */
  function tagged(count: number): Movie {
    return movie({
      tracks: [VP9, opus(2)],
      tags: Array.from({ length: count }, () => 2 * MIB),
      clusters: [{ timestamp: 0, frames: start() }],
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

  it('opens a file whose head takes 11 reads, for the first frames are the 12th', () => {
    const file = tagged(MAX_INDEX_READS - 1)
    const { index, asks } = open(file.bytes)
    expect(asks).toHaveLength(MAX_INDEX_READS - 1)
    expect(index.video.codec).toBe('vp09.00.20.08.01.02.02.02.00')
    // A caller that has read it all is no worse off, and no better.
    const step = readMatroska(ahead(file.bytes), file.bytes.length)
    expect('done' in step).toBe(true)
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

describe('the Tracks element', () => {
  it('is asked for whole when the head does not hold it', () => {
    // Tracks of 100 000 bytes with a head of 256: the head finds where the Tracks end and where the Cluster is, and the Tracks themselves are another ask.
    const file = movie({
      tracks: [VP9, opus(2), { number: 3, type: 17, extra: [new Uint8Array(100_000)] }],
      clusters: [{ timestamp: 0, frames: start() }],
    })
    const { index, asks } = open(file.bytes, { head: 256 })
    expect(asks).toEqual([{ start: file.tracks.end, end: file.bytes.length }, file.tracks])
    expect(plain(index)).toEqual(plain(open(file.bytes).index))
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
