import { describe, expect, it } from 'vitest'
import { codecNames } from '../codecs.ts'
import { Mp4Error } from '../errors.ts'
import type { Mp4Refusal } from '../errors.ts'
import {
  av1C,
  avcC,
  bits,
  box,
  concat,
  dolbyVisionConfig,
  hvcC,
  IDENTITY_MATRIX,
  u16,
  visualEntry,
  vpcC,
} from '../testing/build.ts'
import { trackEntry, tracksElement } from '../testing/ebml.ts'
import type { TrackSpec } from '../testing/ebml.ts'
import { readHeader } from './ebml.ts'
import { needsKeyframe, pictureEntry, pictureMatrix, pictureSize, vp9Header } from './pictures.ts'
import { readTracks } from './tracks.ts'
import type { MatroskaColour, MatroskaTrack } from './tracks.ts'

// The sample entry that each Matroska picture codec stands for, the vpcC that
// VP9 is given, Dolby Vision's entries, and the matrix and size of a picture
// (DESIGN.md §10.4, D45). Every input is built in code, byte by byte, and every
// entry is named by `codecNames` as the index will name it.

/** The Dolby Vision configuration boxes as BlockAddIDTypes, which are their types as numbers. */
const DVCC = 0x64766343
const DVVC = 0x64767643
const DVWC = 0x64767743

/** What a picture entry holds before its child boxes: its box header, then 78 bytes. */
const CHILDREN = 8 + 78

const NO_COLOUR: MatroskaColour = {
  matrix: null,
  primaries: null,
  transfer: null,
  range: null,
  bitsPerChannel: null,
  chromaSubsamplingHorz: null,
  chromaSubsamplingVert: null,
  chromaSitingHorz: null,
  chromaSitingVert: null,
}

/** Bytes as a view onto a longer array, which is how the reader gives them, so that a read that forgets where a view begins reads the wrong bytes. */
function view(bytes: Uint8Array): Uint8Array {
  return concat([9, 9, 9], bytes, [7, 7]).subarray(3, 3 + bytes.length)
}

interface PictureSpec {
  codecId: string
  codecPrivate?: Uint8Array | null
  defaultDuration?: number | null
  pixelWidth?: number
  pixelHeight?: number
  displayWidth?: number | null
  displayHeight?: number | null
  displayUnit?: number
  colour?: Partial<MatroskaColour>
  rollDegrees?: number | null
  blockAdditions?: { type: number; extraData: Uint8Array }[]
}

/** A picture track as the reader gives it, with what the spec leaves out as a track that says nothing of it has. */
function picture(spec: PictureSpec): MatroskaTrack {
  return {
    number: 1,
    kind: 'video',
    enabled: true,
    default: true,
    forced: false,
    language: 'eng',
    codecId: spec.codecId,
    codecPrivate: spec.codecPrivate ? view(spec.codecPrivate) : null,
    codecDelay: 0,
    seekPreRoll: 0,
    defaultDuration: spec.defaultDuration ?? null,
    video: {
      pixelWidth: spec.pixelWidth ?? 1920,
      pixelHeight: spec.pixelHeight ?? 1080,
      displayWidth: spec.displayWidth ?? null,
      displayHeight: spec.displayHeight ?? null,
      displayUnit: spec.displayUnit ?? 0,
      colour: { ...NO_COLOUR, ...spec.colour },
      rollDegrees: spec.rollDegrees ?? null,
    },
    audio: null,
    stripped: new Uint8Array(0),
    blockAdditions: (spec.blockAdditions ?? []).map(({ type, extraData }) => ({
      type,
      extraData: view(extraData),
    })),
    refusal: null,
    problem: null,
  }
}

/** The one track of a Tracks element built from an entry, read as a file's would be. */
function parsed(spec: TrackSpec): MatroskaTrack {
  const bytes = tracksElement([trackEntry(spec)])
  const tracks = readHeader(bytes, 0, bytes.length)
  if (tracks === null) throw new Error('the Tracks header is not whole')
  const { tracks: found, damage } = readTracks(bytes, tracks)
  expect(damage).toBeNull()
  const [track, ...more] = found
  if (track === undefined || more.length > 0) throw new Error('expected one track')
  expect(track.problem).toBeNull()
  return track
}

/** The type of an entry, read from its bytes. */
function typeOf(entry: Uint8Array): string {
  return String.fromCharCode(...entry.subarray(4, 8))
}

/** The names that `codecNames` gives an entry, as the index will ask for them. */
function names(entry: Uint8Array): string[] {
  return codecNames({ type: typeOf(entry), bytes: entry, stsdVersion: 0 })
}

/** The bytes inside a whole box, which is what a CodecPrivate and a record are. */
function body(whole: Uint8Array): Uint8Array {
  return whole.subarray(8)
}

/** What `run` throws, which must be an `Mp4Error` of this reason, and a sentence that reads after "The picture track can't be played: ". */
function refused(reason: Mp4Refusal, run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe(reason)
    expect((error as Mp4Error).message).toMatch(/^[a-z]/)
    return error as Mp4Error
  }
  throw new Error(`expected an Mp4Error (${reason})`)
}

/** An `hvcC` record with arrays of these NAL unit types (32 is a VPS, 33 an SPS and 34 a PPS), each holding one unit. */
function hevcRecord(types: readonly number[]): Uint8Array {
  return concat(
    hvcC().subarray(8, 8 + 22), // the fields before the number of arrays
    [types.length],
    ...types.map((type) => [0x80 | type, ...u16(1), ...u16(2), 0x40 + type, 1]),
  )
}

/** A Dolby Vision record, as BlockAddIDExtraData holds it, of the compatibility ID given. */
function dvRecord({
  profile = 8,
  level = 6,
  compatibility = 0,
}: {
  profile?: number
  level?: number
  compatibility?: number
} = {}): Uint8Array {
  const record = body(dolbyVisionConfig('dvcC', { profile, level }))
  const copy = new Uint8Array(record)
  copy[4] = compatibility << 4
  return copy
}

describe('the entry of an AVC picture', () => {
  it('is an avc1 entry with the avcC of the CodecPrivate', () => {
    const config = avcC({ profile: 0x64, level: 0x1f })
    const entry = pictureEntry(
      picture({ codecId: 'V_MPEG4/ISO/AVC', codecPrivate: body(config) }),
      null,
    )
    expect(typeOf(entry)).toBe('avc1')
    expect(names(entry)).toEqual(['avc1.64001f'])
    expect(entry).toEqual(visualEntry('avc1', { width: 1920, height: 1080 }, config))
  })

  it('has the pixel size of the picture, not its display size', () => {
    const entry = pictureEntry(
      picture({
        codecId: 'V_MPEG4/ISO/AVC',
        codecPrivate: body(avcC()),
        pixelWidth: 1440,
        pixelHeight: 1080,
        displayWidth: 1920,
        displayHeight: 1080,
      }),
      null,
    )
    expect(entry).toEqual(visualEntry('avc1', { width: 1440, height: 1080 }, avcC()))
    // The fields, from the top: the size, the type, 6 reserved bytes, the data reference index, then the rest.
    expect(Array.from(entry.subarray(0, 4))).toEqual([0, 0, 0, entry.length])
    expect(Array.from(entry.subarray(8, 16))).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(Array.from(entry.subarray(32, 36))).toEqual([0x05, 0xa0, 0x04, 0x38])
    expect(Array.from(entry.subarray(36, 44))).toEqual([0, 0x48, 0, 0, 0, 0x48, 0, 0])
    expect(Array.from(entry.subarray(82, 86))).toEqual([0, 0x18, 0xff, 0xff])
  })

  it('does not share its bytes with the CodecPrivate', () => {
    const track = picture({ codecId: 'V_MPEG4/ISO/AVC', codecPrivate: body(avcC()) })
    const entry = pictureEntry(track, null)
    const before = new Uint8Array(entry)
    track.codecPrivate?.fill(0)
    expect(entry).toEqual(before)
  })

  it('is damaged without a CodecPrivate, which the sentence names as the avcC', () => {
    for (const codecPrivate of [null, new Uint8Array(0)]) {
      const error = refused('damaged', () =>
        pictureEntry(picture({ codecId: 'V_MPEG4/ISO/AVC', codecPrivate }), null),
      )
      expect(error.message).toContain('avcC')
    }
  })
})

describe('the entry of an HEVC picture', () => {
  it('is an hvc1 entry when the record holds a VPS, an SPS and a PPS', () => {
    const config = box('hvcC', hevcRecord([32, 33, 34]))
    const entry = pictureEntry(
      picture({ codecId: 'V_MPEGH/ISO/HEVC', codecPrivate: body(config) }),
      null,
    )
    expect(typeOf(entry)).toBe('hvc1')
    expect(names(entry)).toEqual(['hvc1.2.4.L153.B0'])
    expect(entry).toEqual(visualEntry('hvc1', { width: 1920, height: 1080 }, config))
  })

  it.each([
    ['a VPS', [33, 34]],
    ['an SPS', [32, 34]],
    ['a PPS', [32, 33]],
    ['any array', []],
  ])('is an hev1 entry when the record holds no array of %s', (_what, types) => {
    const config = box('hvcC', hevcRecord(types))
    const entry = pictureEntry(
      picture({ codecId: 'V_MPEGH/ISO/HEVC', codecPrivate: body(config) }),
      null,
    )
    expect(typeOf(entry)).toBe('hev1')
    expect(names(entry)).toEqual(['hev1.2.4.L153.B0'])
    expect(entry).toEqual(visualEntry('hev1', { width: 1920, height: 1080 }, config))
  })

  it('does not count an array of no units, nor an array of another type, as the parameter set', () => {
    // The VPS array holds no unit; a fourth array, of SEI (39), takes the place of the PPS.
    const record = concat(
      hvcC().subarray(8, 8 + 22),
      [4],
      [0x80 | 32, ...u16(0)],
      [0x80 | 33, ...u16(1), ...u16(1), 0x41],
      [0x80 | 34, ...u16(0)],
      [0x80 | 39, ...u16(1), ...u16(1), 0x4e],
    )
    const entry = pictureEntry(picture({ codecId: 'V_MPEGH/ISO/HEVC', codecPrivate: record }), null)
    expect(typeOf(entry)).toBe('hev1')
  })

  it('is damaged when the arrays of the record are cut short, with the hvcC in the sentence', () => {
    const whole = hevcRecord([32, 33, 34])
    // Short of the number of arrays, short of an array's header, and short of a unit.
    for (const length of [20, 22, 24, 26, whole.length - 1]) {
      const error = refused('damaged', () =>
        pictureEntry(
          picture({ codecId: 'V_MPEGH/ISO/HEVC', codecPrivate: whole.subarray(0, length) }),
          null,
        ),
      )
      expect(error.message, `${length} bytes`).toContain('hvcC')
    }
  })

  it('is damaged without a CodecPrivate, which the sentence names as the hvcC', () => {
    const error = refused('damaged', () =>
      pictureEntry(picture({ codecId: 'V_MPEGH/ISO/HEVC' }), null),
    )
    expect(error.message).toContain('hvcC')
  })
})

describe('the entry of an AV1 picture', () => {
  it('is an av01 entry with the av1C of the CodecPrivate', () => {
    const config = av1C({ level: 8 })
    const entry = pictureEntry(picture({ codecId: 'V_AV1', codecPrivate: body(config) }), null)
    expect(typeOf(entry)).toBe('av01')
    expect(names(entry)).toEqual(['av01.0.08M.08'])
    expect(entry).toEqual(visualEntry('av01', { width: 1920, height: 1080 }, config))
  })

  it('is damaged without a CodecPrivate, which the sentence names as the av1C', () => {
    const error = refused('damaged', () => pictureEntry(picture({ codecId: 'V_AV1' }), null))
    expect(error.message).toContain('av1C')
  })
})

/**
 * A VP9 keyframe's uncompressed header (VP9 bitstream specification §6.2), field
 * by field, then the colour configuration it is given: the fields of color_config.
 */
function keyframe(profile: number, ...colour: (readonly [value: number, width: number])[]) {
  return Uint8Array.from(
    bits(
      [2, 2], // frame_marker
      [profile & 1, 1], // profile_low_bit
      [profile >> 1, 1], // profile_high_bit
      ...(profile === 3 ? [[0, 1] as const] : []), // reserved_zero
      [0, 1], // show_existing_frame
      [0, 1], // frame_type: a keyframe
      [1, 1], // show_frame
      [0, 1], // error_resilient_mode
      [0x49, 8], // frame_sync_code
      [0x83, 8],
      [0x42, 8],
      ...colour,
    ),
  )
}

/** A profile 0 keyframe: 8 bits, color_space 0 and a limited range. */
const PROFILE_0 = keyframe(0, [0, 3], [0, 1])

describe('vp9Header', () => {
  it('reads a profile 0 keyframe', () => {
    expect(Array.from(PROFILE_0)).toEqual([0x82, 0x49, 0x83, 0x42, 0x00])
    expect(vp9Header(PROFILE_0)).toEqual({
      profile: 0,
      bitDepth: 8,
      subsampling: '420',
      fullRange: false,
    })
  })

  it('reads the profile with its low bit first, so that a profile 2 keyframe is not a profile 1', () => {
    const frame = Uint8Array.of(0x92, 0x49, 0x83, 0x42, 0x00)
    expect(Array.from(keyframe(2, [0, 1], [0, 3], [0, 1]))).toEqual(Array.from(frame))
    expect(vp9Header(frame)).toEqual({
      profile: 2,
      bitDepth: 10,
      subsampling: '420',
      fullRange: false,
    })
  })

  it('reads a bit depth of 12, and the colour range', () => {
    expect(vp9Header(keyframe(2, [1, 1], [0, 3], [1, 1]))).toEqual({
      profile: 2,
      bitDepth: 12,
      subsampling: '420',
      fullRange: true,
    })
  })

  it.each([
    ['4:4:4', 0, 0, '444'],
    ['4:2:2', 1, 0, '422'],
    ['4:4:0', 0, 1, '440'],
    ['4:2:0', 1, 1, '420'],
  ] as const)(
    'reads %s from the subsampling bits of a profile 1 keyframe',
    (_what, x, y, found) => {
      const header = vp9Header(keyframe(1, [1, 3], [0, 1], [x, 1], [y, 1], [0, 1]))
      expect(header).toEqual({ profile: 1, bitDepth: 8, subsampling: found, fullRange: false })
    },
  )

  it('reads a profile 3 keyframe, whose reserved bit moves the rest off the byte boundaries', () => {
    expect(vp9Header(keyframe(3, [0, 1], [1, 3], [1, 1], [0, 1], [0, 1], [0, 1]))).toEqual({
      profile: 3,
      bitDepth: 10,
      subsampling: '444',
      fullRange: true,
    })
  })

  it('reads RGB as 4:4:4 of the full range, in the profiles that have it', () => {
    expect(vp9Header(keyframe(1, [7, 3], [0, 1]))).toEqual({
      profile: 1,
      bitDepth: 8,
      subsampling: '444',
      fullRange: true,
    })
    expect(vp9Header(keyframe(0, [7, 3], [0, 1]))).toBeNull()
    expect(vp9Header(keyframe(2, [0, 1], [7, 3], [0, 1]))).toBeNull()
  })

  it('reads a view of bytes that do not begin at 0, and ignores what follows the header', () => {
    expect(vp9Header(view(concat(PROFILE_0, [0xde, 0xad, 0xbe, 0xef])))?.profile).toBe(0)
  })

  it('is null for a frame that is not a keyframe', () => {
    // frame_type 1: an inter frame.
    const inter = Uint8Array.from(
      bits([2, 2], [0, 1], [0, 1], [0, 1], [1, 1], [1, 1], [0, 1], [0, 8], [0, 8], [0, 8], [0, 8]),
    )
    expect(vp9Header(inter)).toBeNull()
    // show_existing_frame 1: a frame shown again.
    const shown = Uint8Array.from(bits([2, 2], [0, 1], [0, 1], [1, 1], [3, 3]))
    expect(vp9Header(shown)).toBeNull()
  })

  it('is null for a frame with no frame marker or no sync code', () => {
    expect(vp9Header(Uint8Array.of(0x42, 0x49, 0x83, 0x42, 0x00))).toBeNull()
    expect(vp9Header(Uint8Array.of(0x82, 0x49, 0x83, 0x43, 0x00))).toBeNull()
    expect(vp9Header(Uint8Array.of(0x82, 0x00, 0x83, 0x42, 0x00))).toBeNull()
  })

  it('is null for a frame cut short, and throws nothing', () => {
    expect(vp9Header(new Uint8Array(0))).toBeNull()
    expect(vp9Header(PROFILE_0.subarray(0, 1))).toBeNull()
    expect(vp9Header(PROFILE_0.subarray(0, 4))).toBeNull()
    // A profile 1 keyframe that stops inside the subsampling bits.
    const profile1 = keyframe(1, [1, 3], [0, 1], [1, 1], [1, 1], [0, 1])
    expect(vp9Header(profile1)).not.toBeNull()
    expect(vp9Header(profile1.subarray(0, 4))).toBeNull()
  })
})

describe('needsKeyframe', () => {
  // The features, each an ID byte, a length byte and its value.
  const bytes = (...parts: number[]) => Uint8Array.from(parts)
  it.each([
    ['no CodecPrivate', null, true],
    ['an empty CodecPrivate', new Uint8Array(0), true],
    ['the level alone', bytes(2, 1, 31), true],
    ['no chroma', bytes(1, 1, 0, 2, 1, 31, 3, 1, 10), true],
    ['no bit depth', bytes(1, 1, 0, 2, 1, 31, 4, 1, 1), true],
    ['no profile', bytes(2, 1, 31, 3, 1, 10, 4, 1, 1), true],
    ['a feature cut short', bytes(1, 1, 0, 3, 1, 10, 4, 1), true],
    ['a feature whose value is two bytes', bytes(1, 1, 0, 3, 1, 10, 4, 2, 0, 1), true],
    ['a bit depth that 4 bits can not hold', bytes(1, 1, 0, 3, 1, 16, 4, 1, 1), true],
    ['a chroma that 3 bits can not hold', bytes(1, 1, 0, 3, 1, 10, 4, 1, 8), true],
    ['profile, bit depth and chroma', bytes(1, 1, 0, 3, 1, 10, 4, 1, 1), false],
    ['all four', bytes(1, 1, 0, 2, 1, 31, 3, 1, 10, 4, 1, 1), false],
    ['all four, in another order', bytes(4, 1, 1, 3, 1, 10, 2, 1, 31, 1, 1, 0), false],
    [
      'a feature repeated, the first of which counts',
      bytes(1, 1, 0, 3, 1, 10, 4, 1, 1, 4, 1, 9),
      false,
    ],
  ])('with %s, a VP9 needs a keyframe: %s', (_what, codecPrivate, expected) => {
    expect(needsKeyframe(picture({ codecId: 'V_VP9', codecPrivate }))).toBe(expected)
  })

  it('is false for every other codec, whatever its CodecPrivate', () => {
    for (const codecId of ['V_AV1', 'V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC', 'V_VP8']) {
      expect(needsKeyframe(picture({ codecId }))).toBe(false)
    }
  })
})

/** The vpcC box at the end of an entry that has no other box. */
function vpcCOf(entry: Uint8Array): Uint8Array {
  return entry.subarray(CHILDREN)
}

describe('the entry of a VP9 picture', () => {
  const FEATURES = Uint8Array.of(1, 1, 0, 2, 1, 31, 3, 1, 10, 4, 1, 1)

  it('is a vp09 entry with the vpcC that the features of the CodecPrivate give', () => {
    const entry = pictureEntry(picture({ codecId: 'V_VP9', codecPrivate: FEATURES }), null)
    expect(typeOf(entry)).toBe('vp09')
    expect(names(entry)).toEqual(['vp09.00.31.10.01.02.02.02.00', 'vp09.00.31.10'])
    expect(entry).toEqual(
      visualEntry(
        'vp09',
        { width: 1920, height: 1080 },
        vpcC({ profile: 0, level: 31, bitDepth: 10, chromaSubsampling: 1 }),
      ),
    )
  })

  it('has the vpcC that ffmpeg wrote for a WebM of 320x240 at 30 frames a second and no CodecPrivate', () => {
    const track = picture({
      codecId: 'V_VP9',
      pixelWidth: 320,
      pixelHeight: 240,
      defaultDuration: 33_333_333,
    })
    expect(needsKeyframe(track)).toBe(true)
    const entry = pictureEntry(track, view(PROFILE_0))
    expect(names(entry)).toEqual(['vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'])
    expect(Array.from(body(vpcCOf(entry)))).toEqual([
      ...[0x01, 0x00, 0x00, 0x00], // version 1, flags 0
      ...[0x00, 0x14], // profile 0, level 20
      0x82, // 8 bits, chroma 1, limited range
      ...[0x02, 0x02, 0x02], // primaries, transfer, matrix
      ...[0x00, 0x00], // no codec initialization data
    ])
    expect(entry).toEqual(visualEntry('vp09', { width: 320, height: 240 }, vpcCOf(entry)))
  })

  it('takes a bit depth of 10 from a profile 2 keyframe', () => {
    const track = picture({ codecId: 'V_VP9', pixelWidth: 320, pixelHeight: 240 })
    const entry = pictureEntry(track, keyframe(2, [0, 1], [0, 3], [0, 1]))
    expect(names(entry)[0]).toBe('vp09.02.20.10.01.02.02.02.00')
    expect(body(vpcCOf(entry))[6]).toBe(0xa2)
  })

  it('takes each field that the features do not give from the keyframe, and the ones they give from them', () => {
    // The features give the profile 2 and the level 31; the keyframe is 8 bits of profile 0.
    const track = picture({ codecId: 'V_VP9', codecPrivate: Uint8Array.of(1, 1, 2, 2, 1, 31) })
    const entry = pictureEntry(track, PROFILE_0)
    expect(names(entry)[0]).toBe('vp09.02.31.08.01.02.02.02.00')
  })

  it('takes the first of a feature that the CodecPrivate gives twice, and passes one it can not read', () => {
    // The profile twice, the bit depth cut short before a good one, then the level and the chroma.
    const codecPrivate = Uint8Array.of(1, 1, 2, 1, 1, 0, 3, 2, 8, 0, 3, 1, 10, 2, 1, 31, 4, 1, 1)
    const entry = pictureEntry(picture({ codecId: 'V_VP9', codecPrivate }), null)
    expect(names(entry)[0]).toBe('vp09.02.31.10.01.02.02.02.00')
  })

  it('needs no keyframe when the features give all it needs, and uses one it is given only for the range', () => {
    const track = picture({ codecId: 'V_VP9', codecPrivate: FEATURES })
    expect(pictureEntry(track, keyframe(0, [0, 3], [1, 1]))).toEqual(
      visualEntry(
        'vp09',
        { width: 1920, height: 1080 },
        vpcC({ profile: 0, level: 31, bitDepth: 10, chromaSubsampling: 1, fullRange: true }),
      ),
    )
    // A keyframe that can not be read is no harm then.
    expect(pictureEntry(track, Uint8Array.of(1, 2, 3))).toEqual(pictureEntry(track, null))
  })

  it('takes the level from the features when they give it, and works it out when they do not', () => {
    const size = { pixelWidth: 3840, pixelHeight: 2160, defaultDuration: 16_666_667 }
    const given = picture({ codecId: 'V_VP9', codecPrivate: Uint8Array.of(2, 1, 41), ...size })
    expect(names(pictureEntry(given, PROFILE_0))[0]).toBe('vp09.00.41.08.01.02.02.02.00')
    const worked = picture({ codecId: 'V_VP9', ...size })
    expect(names(pictureEntry(worked, PROFILE_0))[0]).toBe('vp09.00.51.08.01.02.02.02.00')
  })

  describe('the level, when the features give none', () => {
    // [width, height, DefaultDuration, level]: the lowest whose picture size and luma samples per second both hold.
    it.each([
      [176, 144, 66_666_667, 10], // 15 frames a second
      [320, 240, 33_333_333, 20], // the picture is above level 11's size
      [640, 360, 33_333_333, 21], // 230400 pixels, 6912000 samples a second
      [1280, 720, 33_333_333, 31], // 921600 pixels, 27648000 samples a second
      [1280, 720, 16_666_667, 40], // 55296000 samples a second is above level 31's
      [1920, 1080, 33_333_333, 40], // 2073600 pixels, 62208000 samples a second
      [1920, 1080, 16_666_667, 41], // 124416000 samples a second
      [1920, 1080, null, 40], // no DefaultDuration: no samples a second, the size alone
      [3840, 2160, 33_333_333, 50],
      [3840, 2160, 16_666_667, 51],
      [3840, 2160, 8_333_333, 52],
      [7680, 4320, 33_333_333, 60],
      [7680, 4320, 16_666_667, 61],
      [7680, 4320, 8_333_333, 62],
      [65535, 65535, 33_333_333, 62], // past the limits of the last level
      [0, 0, 33_333_333, 0], // no picture size
    ])('is the level of %ix%i at a duration of %s: %i', (width, height, duration, level) => {
      const track = picture({
        codecId: 'V_VP9',
        pixelWidth: width,
        pixelHeight: height,
        defaultDuration: duration,
      })
      const entry = pictureEntry(track, PROFILE_0)
      expect(body(vpcCOf(entry))[5]).toBe(level)
    })
  })

  describe('the chroma, when the features give none', () => {
    const chromaOf = (entry: Uint8Array) => ((body(vpcCOf(entry))[6] ?? 0) >> 1) & 7
    const track = (colour: Partial<MatroskaColour> = {}) => picture({ codecId: 'V_VP9', colour })

    it('is 1 for 4:2:0, and 0 when it is sited at the left and half way up', () => {
      expect(chromaOf(pictureEntry(track(), PROFILE_0))).toBe(1)
      expect(
        chromaOf(pictureEntry(track({ chromaSitingHorz: 1, chromaSitingVert: 2 }), PROFILE_0)),
      ).toBe(0)
      expect(
        chromaOf(pictureEntry(track({ chromaSitingHorz: 1, chromaSitingVert: 1 }), PROFILE_0)),
      ).toBe(1)
      expect(chromaOf(pictureEntry(track({ chromaSitingHorz: 1 }), PROFILE_0))).toBe(1)
      expect(chromaOf(pictureEntry(track({ chromaSitingVert: 2 }), PROFILE_0))).toBe(1)
    })

    it('is 2 for 4:2:2 and 3 for 4:4:4, whatever the siting says', () => {
      const siting = { chromaSitingHorz: 1, chromaSitingVert: 2 }
      const x422 = keyframe(1, [0, 3], [0, 1], [1, 1], [0, 1], [0, 1])
      const x444 = keyframe(1, [0, 3], [0, 1], [0, 1], [0, 1], [0, 1])
      expect(chromaOf(pictureEntry(track(siting), x422))).toBe(2)
      expect(chromaOf(pictureEntry(track(siting), x444))).toBe(3)
    })

    it('is refused for 4:4:0, which the vpcC has no code for', () => {
      const x440 = keyframe(1, [0, 3], [0, 1], [0, 1], [1, 1], [0, 1])
      const error = refused('unsupported-codec', () => pictureEntry(track(), x440))
      expect(error.message).toContain('4:4:0')
    })

    it('is not asked when the features give it, so 4:4:0 in the keyframe is no harm then', () => {
      const x440 = keyframe(1, [0, 3], [0, 1], [0, 1], [1, 1], [0, 1])
      const given = picture({
        codecId: 'V_VP9',
        codecPrivate: Uint8Array.of(1, 1, 1, 3, 1, 8, 4, 1, 3),
      })
      expect(chromaOf(pictureEntry(given, x440))).toBe(3)
    })
  })

  describe('the colour', () => {
    it('is the primaries, the transfer and the matrix of Colour, and 2 for each it leaves out', () => {
      const colour = { primaries: 9, transfer: 16, matrix: 9 }
      const entry = pictureEntry(picture({ codecId: 'V_VP9', colour }), PROFILE_0)
      expect(Array.from(body(vpcCOf(entry)).subarray(7, 10))).toEqual([9, 16, 9])
      const some = pictureEntry(picture({ codecId: 'V_VP9', colour: { transfer: 1 } }), PROFILE_0)
      expect(Array.from(body(vpcCOf(some)).subarray(7, 10))).toEqual([2, 1, 2])
    })

    it('is unspecified (2) for a code that does not fit a byte', () => {
      const colour = { primaries: 256, transfer: 300, matrix: 255 }
      const entry = pictureEntry(picture({ codecId: 'V_VP9', colour }), PROFILE_0)
      expect(Array.from(body(vpcCOf(entry)).subarray(7, 10))).toEqual([2, 2, 255])
    })

    it('is the full range when Colour says its Range is 2, else the range of the keyframe, else limited', () => {
      const fullFrame = keyframe(0, [0, 3], [1, 1])
      const rangeOf = (colour: Partial<MatroskaColour>, frame: Uint8Array | null) =>
        (body(vpcCOf(pictureEntry(picture({ codecId: 'V_VP9', colour }), frame)))[6] ?? 0) & 1
      expect(rangeOf({ range: 2 }, PROFILE_0)).toBe(1)
      expect(rangeOf({}, fullFrame)).toBe(1)
      expect(rangeOf({ range: 1 }, PROFILE_0)).toBe(0)
      expect(rangeOf({}, PROFILE_0)).toBe(0)
      // Features that give it all, and no keyframe: limited, with Colour's range the one thing that can say otherwise.
      const features = Uint8Array.of(1, 1, 0, 3, 1, 8, 4, 1, 1)
      const alone = (colour: Partial<MatroskaColour>) =>
        (body(
          vpcCOf(pictureEntry(picture({ codecId: 'V_VP9', codecPrivate: features, colour }), null)),
        )[6] ?? 0) & 1
      expect(alone({})).toBe(0)
      expect(alone({ range: 2 })).toBe(1)
    })
  })

  describe('is damaged', () => {
    it('with neither features nor a keyframe', () => {
      const error = refused('damaged', () => pictureEntry(picture({ codecId: 'V_VP9' }), null))
      expect(error.message).toContain('profile')
      expect(error.message).toContain('bit depth')
      expect(error.message).toContain('chroma')
    })

    it('with features that miss a field and no keyframe', () => {
      const error = refused('damaged', () =>
        pictureEntry(
          picture({ codecId: 'V_VP9', codecPrivate: Uint8Array.of(1, 1, 0, 3, 1, 8) }),
          null,
        ),
      )
      expect(error.message).toContain('chroma')
      expect(error.message).not.toContain('bit depth')
    })

    it('with a keyframe that can not be read', () => {
      const inter = Uint8Array.from(
        bits([2, 2], [0, 1], [0, 1], [0, 1], [1, 1], [1, 1], [0, 1], [0, 8], [0, 8], [0, 8]),
      )
      for (const frame of [inter, PROFILE_0.subarray(0, 4), new Uint8Array(0)]) {
        refused('damaged', () => pictureEntry(picture({ codecId: 'V_VP9' }), frame))
      }
    })
  })
})

describe('the entry of a Dolby Vision picture', () => {
  const hevc = box('hvcC', hevcRecord([32, 33, 34]))
  const hevcWithoutVps = box('hvcC', hevcRecord([33, 34]))
  const size = { width: 1920, height: 1080 }

  it('is the entry of the base codec with the record in a box after its configuration, when the compatibility ID is not 0', () => {
    const record = dvRecord({ profile: 8, compatibility: 1 })
    const entry = pictureEntry(
      picture({
        codecId: 'V_MPEGH/ISO/HEVC',
        codecPrivate: body(hevc),
        blockAdditions: [{ type: DVCC, extraData: record }],
      }),
      null,
    )
    expect(typeOf(entry)).toBe('hvc1')
    expect(names(entry)).toEqual(['hvc1.2.4.L153.B0'])
    expect(entry).toEqual(visualEntry('hvc1', size, hevc, box('dvcC', record)))
  })

  it('is a dvh1 entry for profile 5, which the compatibility ID does not change', () => {
    const record = dvRecord({ profile: 5, level: 6, compatibility: 1 })
    const entry = pictureEntry(
      picture({
        codecId: 'V_MPEGH/ISO/HEVC',
        codecPrivate: body(hevc),
        blockAdditions: [{ type: DVCC, extraData: record }],
      }),
      null,
    )
    expect(typeOf(entry)).toBe('dvh1')
    expect(names(entry)).toEqual(['dvh1.05.06'])
    expect(entry).toEqual(visualEntry('dvh1', size, hevc, box('dvcC', record)))
  })

  it('is a dvh1 entry for a compatibility ID of 0, and a dvhe entry when the base would be hev1', () => {
    const record = dvRecord({ profile: 8, level: 9, compatibility: 0 })
    const make = (config: Uint8Array) =>
      pictureEntry(
        picture({
          codecId: 'V_MPEGH/ISO/HEVC',
          codecPrivate: body(config),
          blockAdditions: [{ type: DVCC, extraData: record }],
        }),
        null,
      )
    const over = make(hevc)
    expect(typeOf(over)).toBe('dvh1')
    expect(names(over)).toEqual(['dvh1.08.09'])
    const without = make(hevcWithoutVps)
    expect(typeOf(without)).toBe('dvhe')
    expect(names(without)).toEqual(['dvhe.08.09'])
    expect(without).toEqual(visualEntry('dvhe', size, hevcWithoutVps, box('dvcC', record)))
  })

  it('is a dav1 entry over AV1 when the compatibility ID is 0', () => {
    const record = dvRecord({ profile: 10, level: 6, compatibility: 0 })
    const config = av1C({ level: 8 })
    const entry = pictureEntry(
      picture({
        codecId: 'V_AV1',
        codecPrivate: body(config),
        blockAdditions: [{ type: DVVC, extraData: record }],
      }),
      null,
    )
    expect(typeOf(entry)).toBe('dav1')
    expect(names(entry)).toEqual(['dav1.10.06'])
    expect(entry).toEqual(visualEntry('dav1', size, config, box('dvvC', record)))
  })

  it('is an av01 entry with the record after the av1C when AV1 has a compatible base', () => {
    const record = dvRecord({ profile: 10, compatibility: 4 })
    const config = av1C({ level: 8 })
    const entry = pictureEntry(
      picture({
        codecId: 'V_AV1',
        codecPrivate: body(config),
        blockAdditions: [{ type: DVVC, extraData: record }],
      }),
      null,
    )
    expect(typeOf(entry)).toBe('av01')
    expect(entry).toEqual(visualEntry('av01', size, config, box('dvvC', record)))
  })

  it('is a dva1 entry over AVC when the compatibility ID is 0, and an avc1 entry when it is not', () => {
    const config = avcC()
    const make = (record: Uint8Array) =>
      pictureEntry(
        picture({
          codecId: 'V_MPEG4/ISO/AVC',
          codecPrivate: body(config),
          blockAdditions: [{ type: DVWC, extraData: record }],
        }),
        null,
      )
    const bare = dvRecord({ profile: 9, level: 6, compatibility: 0 })
    const over = make(bare)
    expect(typeOf(over)).toBe('dva1')
    expect(names(over)).toEqual(['dva1.09.06'])
    expect(over).toEqual(visualEntry('dva1', size, config, box('dvwC', bare)))
    const compatible = dvRecord({ profile: 9, compatibility: 2 })
    const base = make(compatible)
    expect(typeOf(base)).toBe('avc1')
    expect(base).toEqual(visualEntry('avc1', size, config, box('dvwC', compatible)))
  })

  it('counts the first mapping of a Dolby Vision type, and no other', () => {
    const first = dvRecord({ profile: 8, compatibility: 1 })
    const second = dvRecord({ profile: 5, compatibility: 0 })
    const entry = pictureEntry(
      picture({
        codecId: 'V_MPEGH/ISO/HEVC',
        codecPrivate: body(hevc),
        blockAdditions: [
          { type: 121, extraData: Uint8Array.of(1, 2, 3, 4, 5, 6) }, // a mapping of some other type
          { type: DVCC, extraData: first },
          { type: DVVC, extraData: second },
        ],
      }),
      null,
    )
    expect(entry).toEqual(visualEntry('hvc1', size, hevc, box('dvcC', first)))
  })

  it('has no Dolby Vision box for mappings of no Dolby Vision type', () => {
    const entry = pictureEntry(
      picture({
        codecId: 'V_MPEGH/ISO/HEVC',
        codecPrivate: body(hevc),
        blockAdditions: [{ type: 121, extraData: dvRecord() }],
      }),
      null,
    )
    expect(entry).toEqual(visualEntry('hvc1', size, hevc))
  })

  it('is damaged when the record is shorter than the 5 bytes that give its profile and its compatibility', () => {
    for (const length of [0, 1, 4]) {
      const error = refused('damaged', () =>
        pictureEntry(
          picture({
            codecId: 'V_MPEGH/ISO/HEVC',
            codecPrivate: body(hevc),
            blockAdditions: [{ type: DVCC, extraData: new Uint8Array(length).fill(0x10) }],
          }),
          null,
        ),
      )
      expect(error.message, `${length} bytes`).toContain('Dolby Vision')
    }
    // 5 bytes will do.
    const five = dvRecord({ profile: 8, compatibility: 1 }).subarray(0, 5)
    expect(
      typeOf(
        pictureEntry(
          picture({
            codecId: 'V_MPEGH/ISO/HEVC',
            codecPrivate: body(hevc),
            blockAdditions: [{ type: DVCC, extraData: five }],
          }),
          null,
        ),
      ),
    ).toBe('hvc1')
  })
})

describe('what is refused', () => {
  it('is VP8, which plays only as WebM', () => {
    const error = refused('unsupported-codec', () =>
      pictureEntry(picture({ codecId: 'V_VP8' }), null),
    )
    expect(error.message).toContain('V_VP8')
    expect(error.message).toContain('VP8 plays only as WebM, and the reader writes MP4')
  })

  it.each([
    'V_MPEG4/ISO/ASP',
    'V_MPEG4/ISO/SP',
    'V_MPEG4/MS/V3',
    'V_MPEG1',
    'V_MPEG2',
    'V_THEORA',
    'V_PRORES',
    'V_MS/VFW/FOURCC',
    'V_FFV1',
    'V_UNCOMPRESSED',
    'V_MPEGI/ISO/VVC',
    'V_SOMETHING/NEW',
  ])('is %s, with the CodecID in the sentence', (codecId) => {
    const error = refused('unsupported-codec', () =>
      pictureEntry(picture({ codecId, codecPrivate: Uint8Array.of(1, 2, 3, 4) }), null),
    )
    expect(error.message).toContain(codecId)
  })

  it('is a picture track without a Video element, which is damaged', () => {
    const track = { ...picture({ codecId: 'V_AV1', codecPrivate: body(av1C()) }), video: null }
    refused('damaged', () => pictureEntry(track, null))
  })

  it('is a picture too big for the 16 bits that an entry has for each of its sizes', () => {
    for (const [pixelWidth, pixelHeight] of [
      [65536, 1080],
      [1920, 65536],
    ] as const) {
      const track = picture({
        codecId: 'V_AV1',
        codecPrivate: body(av1C()),
        pixelWidth,
        pixelHeight,
      })
      const error = refused('unsupported-codec', () => pictureEntry(track, null))
      expect(error.message).toContain('16 bits')
    }
    const widest = picture({
      codecId: 'V_AV1',
      codecPrivate: body(av1C()),
      pixelWidth: 65535,
      pixelHeight: 65535,
    })
    expect(Array.from(pictureEntry(widest, null).subarray(32, 36))).toEqual([
      0xff, 0xff, 0xff, 0xff,
    ])
  })
})

/** A matrix as the nine 32-bit numbers it is written in. */
function words(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const dv = new DataView(out.buffer)
  values.forEach((value, index) => {
    dv.setInt32(index * 4, value)
  })
  return out
}

describe('pictureMatrix', () => {
  const matrixOf = (rollDegrees: number | null) =>
    pictureMatrix(picture({ codecId: 'V_AV1', rollDegrees }))

  it('is the identity for a picture with no Projection', () => {
    const matrix = matrixOf(null)
    expect(matrix.length).toBe(36)
    expect(matrix).toEqual(words(IDENTITY_MATRIX))
  })

  it('is the matrix that MP4 has for the same rotation, so that ffprobe reads both alike', () => {
    // [a, b, u, c, d, v, x, y, w]: a, b, c and d in 16.16, w in 2.30.
    expect(matrixOf(90)).toEqual(words([0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000]))
    expect(matrixOf(-90)).toEqual(words([0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]))
    expect(matrixOf(180)).toEqual(words([-0x10000, 0, 0, 0, -0x10000, 0, 0, 0, 0x40000000]))
    expect(matrixOf(-180)).toEqual(matrixOf(180))
  })

  it('takes the roll modulo 360', () => {
    expect(matrixOf(270)).toEqual(matrixOf(-90))
    expect(matrixOf(-270)).toEqual(matrixOf(90))
    expect(matrixOf(450)).toEqual(matrixOf(90))
    expect(matrixOf(540)).toEqual(matrixOf(180))
    expect(matrixOf(-450)).toEqual(matrixOf(-90))
  })

  it('is the identity for a roll that is no quarter turn', () => {
    for (const roll of [0, 360, -360, 45, -45, 89.9, 90.5, 135, 1e300, Number.NaN]) {
      expect(matrixOf(roll), `${roll}`).toEqual(words(IDENTITY_MATRIX))
    }
  })
})

describe('pictureSize', () => {
  const sizeOf = (spec: Partial<PictureSpec>) =>
    pictureSize(picture({ codecId: 'V_AV1', pixelWidth: 1440, pixelHeight: 1080, ...spec }))

  it('is the pixel size of a picture that says no display size', () => {
    expect(sizeOf({})).toEqual({ width: 1440, height: 1080 })
  })

  it('is the display size when both are given in pixels', () => {
    expect(sizeOf({ displayWidth: 1920, displayHeight: 1080, displayUnit: 0 })).toEqual({
      width: 1920,
      height: 1080,
    })
  })

  it('is the pixel size when only one of the display sizes is given', () => {
    expect(sizeOf({ displayWidth: 1920 })).toEqual({ width: 1440, height: 1080 })
    expect(sizeOf({ displayHeight: 1080 })).toEqual({ width: 1440, height: 1080 })
  })

  it('is the pixel size when the display size is in another unit', () => {
    // Centimetres, inches, a display aspect ratio, and a unit the player does not know.
    for (const displayUnit of [1, 2, 3, 4]) {
      expect(sizeOf({ displayWidth: 16, displayHeight: 9, displayUnit }), `${displayUnit}`).toEqual(
        {
          width: 1440,
          height: 1080,
        },
      )
    }
  })

  it('is the pixel size when a display size is 0, or more than the 16 bits that tkhd has for it', () => {
    expect(sizeOf({ displayWidth: 0, displayHeight: 1080 })).toEqual({ width: 1440, height: 1080 })
    expect(sizeOf({ displayWidth: 1920, displayHeight: 0 })).toEqual({ width: 1440, height: 1080 })
    expect(sizeOf({ displayWidth: 65536, displayHeight: 1080 })).toEqual({
      width: 1440,
      height: 1080,
    })
  })
})

describe('a track as the reader reads it from a file', () => {
  it('gives its entry, its matrix and its size', () => {
    const hevc = box('hvcC', hevcRecord([32, 33, 34]))
    const record = dvRecord({ profile: 8, compatibility: 1 })
    const track = parsed({
      number: 1,
      type: 1,
      codecId: 'V_MPEGH/ISO/HEVC',
      codecPrivate: body(hevc),
      video: {
        pixelWidth: 3840,
        pixelHeight: 2160,
        displayWidth: 3840,
        displayHeight: 2160,
        rollDegrees: 90,
      },
      blockAdditions: [{ type: DVCC, extraData: record }],
    })
    expect(pictureEntry(track, null)).toEqual(
      visualEntry('hvc1', { width: 3840, height: 2160 }, hevc, box('dvcC', record)),
    )
    expect(pictureMatrix(track)).toEqual(words([0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000]))
    expect(pictureSize(track)).toEqual({ width: 3840, height: 2160 })
  })

  it('gives a VP9 its vpcC from the colour, the duration and the first keyframe', () => {
    const track = parsed({
      number: 1,
      type: 1,
      codecId: 'V_VP9',
      defaultDuration: 33_333_333,
      video: {
        pixelWidth: 1920,
        pixelHeight: 1080,
        colour: { primaries: 1, transfer: 1, matrix: 1, range: 2 },
      },
    })
    expect(needsKeyframe(track)).toBe(true)
    expect(pictureEntry(track, PROFILE_0)).toEqual(
      visualEntry(
        'vp09',
        { width: 1920, height: 1080 },
        vpcC({
          profile: 0,
          level: 40,
          bitDepth: 8,
          chromaSubsampling: 1,
          fullRange: true,
          colourPrimaries: 1,
          transferCharacteristics: 1,
          matrixCoefficients: 1,
        }),
      ),
    )
  })
})
