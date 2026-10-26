import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import type { Mp4Refusal } from '../errors.ts'
import { concat } from '../testing/build.ts'
import {
  element,
  elementSized,
  float,
  sizeBytes,
  string,
  trackEntry,
  tracksElement,
  uint,
  unknownSize,
} from '../testing/ebml.ts'
import type { TrackSpec } from '../testing/ebml.ts'
import { readHeader } from './ebml.ts'
import { ID } from './ids.ts'
import { chooseMatroskaTracks, readTracks } from './tracks.ts'
import type { MatroskaTrack } from './tracks.ts'

// What a file's Tracks element says about each track, and which of them play
// (DESIGN.md §10.4, D45). Every case is built in code, byte by byte, from the
// builder in `testing/ebml.ts`.

/** Bytes before the Tracks element, so that its offsets in the bytes are never 0-based. */
const PREFIX = 7

/** What `readTracks` gives for a Tracks element that holds the entries it is given, read from bytes that have more before it. */
function readResult(entries: Uint8Array[]): {
  tracks: MatroskaTrack[]
  damage: Mp4Error | null
} {
  const bytes = concat(new Uint8Array(PREFIX).fill(0xaa), tracksElement(entries))
  const tracks = readHeader(bytes, PREFIX, bytes.length)
  if (tracks === null) throw new Error('the Tracks header is not whole')
  return readTracks(bytes, tracks)
}

/** The tracks of a Tracks element that walks to its end, which must have no damage. */
function readEntries(entries: Uint8Array[]): MatroskaTrack[] {
  const { tracks, damage } = readResult(entries)
  expect(damage).toBeNull()
  return tracks
}

function read(specs: TrackSpec[]): MatroskaTrack[] {
  return readEntries(specs.map((spec) => trackEntry(spec)))
}

/** The one track of a Tracks element that holds one entry. */
function only(spec: TrackSpec): MatroskaTrack {
  const [track, ...more] = read([spec])
  if (track === undefined || more.length > 0) throw new Error('expected one track')
  return track
}

/** A picture track of a size, with the rest of what a track says left out. */
function picture(number: number, spec: TrackSpec = {}): TrackSpec {
  return {
    number,
    type: 1,
    codecId: 'V_AV1',
    video: { pixelWidth: 1920, pixelHeight: 1080 },
    ...spec,
  }
}

/** A sound track, in Opus at 48 kHz in stereo, with the rest left out. */
function sound(number: number, spec: TrackSpec = {}): TrackSpec {
  return {
    number,
    type: 2,
    codecId: 'A_OPUS',
    audio: { samplingFrequency: 48000, channels: 2 },
    ...spec,
  }
}

/** The numbers of the tracks, which show in a failure as the order they came in. */
function numbers(tracks: readonly MatroskaTrack[]): number[] {
  return tracks.map((track) => track.number)
}

/** What `run` throws, which must be an `Mp4Error` of the reason given. */
function refused(run: () => unknown, reason: Mp4Refusal): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe(reason)
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error')
}

/** The refusal of a track, which must have one. */
function refusalOf(track: MatroskaTrack): Mp4Error {
  expect(track.problem).toBeNull()
  if (track.refusal === null) throw new Error('expected a refusal')
  expect(track.refusal).toBeInstanceOf(Mp4Error)
  return track.refusal
}

/** An element that claims more bytes than its parent holds. */
function overrun(id: number): Uint8Array {
  return elementSized(id, sizeBytes(100), [1, 2, 3])
}

const NO_COLOUR = {
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

describe('reading the tracks of a Tracks element (§10.4)', () => {
  it('gives a track what it leaves out the value that RFC 9559 gives it', () => {
    const track = only(picture(1))
    expect(track).toMatchObject({
      number: 1,
      kind: 'video',
      enabled: true,
      default: true,
      forced: false,
      language: 'eng',
      codecId: 'V_AV1',
      codecPrivate: null,
      codecDelay: 0,
      seekPreRoll: 0,
      defaultDuration: null,
      audio: null,
      refusal: null,
      problem: null,
    })
    expect(track.stripped).toEqual(new Uint8Array(0))
    expect(track.blockAdditions).toEqual([])
    expect(track.video).toEqual({
      pixelWidth: 1920,
      pixelHeight: 1080,
      displayWidth: null,
      displayHeight: null,
      displayUnit: 0,
      colour: NO_COLOUR,
      rollDegrees: null,
    })
  })

  it('gives a sound that has no Audio element a sampling frequency of 8000 Hz and one channel', () => {
    const track = only({ number: 2, type: 2, codecId: 'A_OPUS' })
    expect(track.problem).toBeNull()
    expect(track.video).toBeNull()
    expect(track.audio).toEqual({
      samplingFrequency: 8000,
      outputSamplingFrequency: null,
      channels: 1,
      bitDepth: null,
    })
  })

  it('reads what a track says of itself, and a picture and a sound each what their element says', () => {
    const config = new Uint8Array([1, 2, 3, 4])
    const track = only({
      number: 3,
      type: 1,
      enabled: false,
      default: false,
      forced: true,
      language: 'jpn',
      codecId: 'V_MPEG4/ISO/AVC',
      codecPrivate: config,
      codecDelay: 6_500_000,
      seekPreRoll: 80_000_000,
      defaultDuration: 16_666_667,
      video: {
        pixelWidth: 1280,
        pixelHeight: 720,
        displayWidth: 16,
        displayHeight: 9,
        displayUnit: 3,
      },
    })
    expect(track).toMatchObject({
      number: 3,
      kind: 'video',
      enabled: false,
      default: false,
      forced: true,
      language: 'jpn',
      codecId: 'V_MPEG4/ISO/AVC',
      codecDelay: 6_500_000,
      seekPreRoll: 80_000_000,
      defaultDuration: 16_666_667,
      problem: null,
      refusal: null,
    })
    expect(track.video).toMatchObject({
      pixelWidth: 1280,
      pixelHeight: 720,
      displayWidth: 16,
      displayHeight: 9,
      displayUnit: 3,
    })
    // A view onto the bytes of the Tracks element, which were read at an offset: not a copy of them.
    expect(track.codecPrivate).toEqual(config)
    expect(track.codecPrivate?.byteOffset).toBeGreaterThan(PREFIX)

    const audio = only(
      sound(4, {
        audio: {
          samplingFrequency: 44100,
          outputSamplingFrequency: 48000,
          channels: 6,
          bitDepth: 24,
        },
      }),
    )
    expect(audio.kind).toBe('audio')
    expect(audio.audio).toEqual({
      samplingFrequency: 44100,
      outputSamplingFrequency: 48000,
      channels: 6,
      bitDepth: 24,
    })
  })

  it('takes a DefaultDuration of 0 for none, as it has a least of 1', () => {
    expect(only(picture(1, { defaultDuration: 0 })).defaultDuration).toBeNull()
    expect(only(picture(1, { defaultDuration: 1 })).defaultDuration).toBe(1)
  })

  it('takes a TrackType that is neither a picture nor a sound for another kind, and gives it neither element', () => {
    const subtitles = only({
      number: 5,
      type: 17,
      codecId: 'S_TEXT/UTF8',
      video: { pixelWidth: 1, pixelHeight: 1 },
      audio: { channels: 2 },
    })
    expect(subtitles).toMatchObject({ kind: 'other', video: null, audio: null, problem: null })
    // A sound's Video element, and a picture's Audio element, are not read.
    expect(only({ ...sound(2), video: { pixelWidth: 1, pixelHeight: 1 } }).video).toBeNull()
    expect(only({ ...picture(1), audio: { channels: 2 } }).audio).toBeNull()
  })

  it('reads the nine fields of a Colour element', () => {
    const track = only(
      picture(1, {
        video: {
          pixelWidth: 3840,
          pixelHeight: 2160,
          colour: {
            matrix: 1,
            primaries: 2,
            transfer: 3,
            range: 4,
            bitsPerChannel: 5,
            chromaSubsamplingHorz: 6,
            chromaSubsamplingVert: 7,
            chromaSitingHorz: 8,
            chromaSitingVert: 9,
          },
        },
      }),
    )
    expect(track.video?.colour).toEqual({
      matrix: 1,
      primaries: 2,
      transfer: 3,
      range: 4,
      bitsPerChannel: 5,
      chromaSubsamplingHorz: 6,
      chromaSubsamplingVert: 7,
      chromaSitingHorz: 8,
      chromaSitingVert: 9,
    })
  })

  it('leaves null what a Colour element does not say', () => {
    const empty = only(picture(1, { video: { pixelWidth: 2, pixelHeight: 2, colour: {} } }))
    expect(empty.video?.colour).toEqual(NO_COLOUR)
    const range = only(
      picture(1, { video: { pixelWidth: 2, pixelHeight: 2, colour: { range: 2 } } }),
    )
    expect(range.video?.colour).toEqual({ ...NO_COLOUR, range: 2 })
  })

  it('reads the roll of a Projection, as degrees', () => {
    const track = only(
      picture(1, { video: { pixelWidth: 1080, pixelHeight: 1920, rollDegrees: -90 } }),
    )
    expect(track.video?.rollDegrees).toBe(-90)
    expect(
      only(picture(1, { video: { pixelWidth: 2, pixelHeight: 2, rollDegrees: 90.5 } })).video
        ?.rollDegrees,
    ).toBe(90.5)
  })

  it('reads each BlockAdditionMapping, with its type and its extra data, in order', () => {
    // A dvcC: Dolby Vision's configuration record, 24 bytes.
    const dvcc = Uint8Array.from({ length: 24 }, (_, index) => index + 1)
    const track = only(
      picture(1, {
        blockAdditions: [
          { type: 0x64766343, extraData: dvcc },
          { extraData: new Uint8Array([9]) },
          { type: 0x64766343 },
        ],
      }),
    )
    expect(track.problem).toBeNull()
    expect(track.blockAdditions).toEqual([
      { type: 0x64766343, extraData: dvcc },
      { type: 0, extraData: new Uint8Array([9]) },
      { type: 0x64766343, extraData: new Uint8Array(0) },
    ])
  })

  it('skips the CRC-32 and the Void that stand in a track, and whatever in the Tracks is no TrackEntry', () => {
    const entry = trackEntry({
      ...picture(1),
      extra: [element(ID.Void, [0, 0, 0]), element(ID.CRC32, [1, 2, 3, 4]), uint(0x73c5, 99)],
    })
    const tracks = readEntries([
      element(ID.CRC32, [1, 2, 3, 4]),
      element(ID.Void, [0, 0]),
      uint(0x73c5, 7),
      entry,
      element(ID.Void),
    ])
    expect(numbers(tracks)).toEqual([1])
    expect(tracks[0]?.problem).toBeNull()
  })

  it('takes the first of an element that a track holds twice', () => {
    const track = only({
      ...picture(1, { default: true, enabled: false, language: 'fra' }),
      extra: [
        uint(ID.FlagDefault, 0),
        uint(ID.FlagEnabled, 1),
        string(ID.Language, 'deu'),
        uint(ID.TrackNumber, 9),
        uint(ID.TrackType, 2),
      ],
    })
    expect(track).toMatchObject({
      number: 1,
      kind: 'video',
      default: true,
      enabled: false,
      language: 'fra',
      problem: null,
    })
  })

  it('keeps two tracks of the same number as they are read', () => {
    const tracks = read([picture(1), sound(2), sound(2, { language: 'fra' })])
    expect(numbers(tracks)).toEqual([1, 2, 2])
    expect(tracks.map((track) => track.language)).toEqual(['eng', 'eng', 'fra'])
    expect(tracks.every((track) => track.problem === null && track.refusal === null)).toBe(true)
  })

  it('reads no tracks from a Tracks element with no entry', () => {
    expect(readEntries([])).toEqual([])
  })

  describe('the damage that stays with a track', () => {
    it('keeps a problem on a track whose child cannot be read, and reads the others whole', () => {
      const tracks = readEntries([
        trackEntry(picture(1)),
        // An integer of 9 bytes, where 8 are the most.
        trackEntry({ ...sound(2), extra: [element(ID.FlagDefault, new Uint8Array(9))] }),
        trackEntry(sound(3)),
      ])
      expect(numbers(tracks)).toEqual([1, 2, 3])
      expect(tracks[1]?.problem).toMatch(/9 bytes wide/)
      expect(tracks[1]?.refusal).toBeNull()
      for (const whole of [tracks[0], tracks[2]]) {
        expect(whole).toMatchObject({ problem: null, refusal: null })
      }
    })

    it('keeps a problem on a track that has a child that runs past it, and still knows what it is', () => {
      const tracks = readEntries([
        trackEntry(picture(1, { extra: [overrun(ID.CodecPrivate)] })),
        trackEntry(sound(2)),
      ])
      expect(numbers(tracks)).toEqual([1, 2])
      expect(tracks[0]).toMatchObject({ kind: 'video', enabled: true, number: 1 })
      expect(tracks[0]?.problem).toMatch(/claims/)
      expect(tracks[1]?.problem).toBeNull()
    })

    it('keeps the kind and the flag of a track whose TrackType is followed by a child that cannot be read', () => {
      const track = only({
        type: 1,
        enabled: false,
        extra: [element(ID.TrackNumber, new Uint8Array(9))],
      })
      expect(track).toMatchObject({ kind: 'video', enabled: false })
      expect(track.problem).not.toBeNull()
    })

    it('takes a track whose TrackType cannot be read for another kind', () => {
      const track = only({
        number: 1,
        codecId: 'V_AV1',
        extra: [element(ID.TrackType, new Uint8Array(9))],
      })
      expect(track.kind).toBe('other')
      expect(track.problem).toMatch(/9 bytes wide/)
    })

    it('keeps a problem on a picture whose Video element cannot be read, and on a sound whose Audio cannot', () => {
      const badVideo = only({
        number: 1,
        type: 1,
        codecId: 'V_AV1',
        extra: [element(ID.Video, uint(ID.PixelWidth, 1), overrun(ID.PixelHeight))],
      })
      expect(badVideo).toMatchObject({ kind: 'video', video: null })
      expect(badVideo.problem).not.toBeNull()

      // A sampling frequency that is NaN is no number.
      const badAudio = only({
        number: 2,
        type: 2,
        codecId: 'A_OPUS',
        extra: [element(ID.Audio, float(ID.SamplingFrequency, Number.NaN))],
      })
      expect(badAudio).toMatchObject({ kind: 'audio', audio: null })
      expect(badAudio.problem).toMatch(/not a number/)
    })

    it('keeps a problem on a picture whose Colour or Projection cannot be read', () => {
      for (const extra of [
        element(ID.Video, uint(ID.PixelWidth, 1), uint(ID.PixelHeight, 1), overrun(ID.Colour)),
        element(
          ID.Video,
          uint(ID.PixelWidth, 1),
          uint(ID.PixelHeight, 1),
          element(ID.Projection, element(ID.ProjectionPoseRoll, [1, 2, 3])),
        ),
      ]) {
        const track = only({ number: 1, type: 1, codecId: 'V_AV1', extra: [extra] })
        expect(track.problem).not.toBeNull()
        expect(track.kind).toBe('video')
      }
    })

    it.each<[string, TrackSpec, RegExp]>([
      ['no TrackNumber', { ...picture(1), number: undefined }, /TrackNumber/],
      ['a TrackNumber of 0', picture(0), /TrackNumber/],
      ['no TrackType', { ...picture(1), type: undefined }, /TrackType/],
      ['no CodecID', { ...sound(2), codecId: undefined }, /CodecID/],
      ['no CodecID, though it is no picture or sound', { number: 3, type: 17 }, /CodecID/],
      ['a picture with no Video element', { ...picture(1), video: undefined }, /Video/],
      ['a picture with no PixelWidth', picture(1, { video: { pixelHeight: 1080 } }), /PixelWidth/],
      ['a picture with no PixelHeight', picture(1, { video: { pixelWidth: 1920 } }), /PixelHeight/],
    ])('keeps a problem on a track with %s', (_name, spec, says) => {
      const track = only(spec)
      expect(track.problem).toMatch(says)
      expect(track.refusal).toBeNull()
    })

    it('keeps a problem and no refusal on a track that has both, as a track that cannot be read is not one to refuse', () => {
      const track = only({
        number: 1,
        type: 1,
        timestampScale: 2,
        encodings: [{ compression: {} }],
        video: { pixelWidth: 1, pixelHeight: 1 },
      })
      expect(track.problem).toMatch(/CodecID/)
      expect(track.refusal).toBeNull()
    })

    it('refuses the Tracks element whose walk fails, and nothing else', () => {
      const entry = trackEntry(picture(1))
      /** Reads `bytes` from a Tracks element at their start, as `readTracks` is given it. */
      const readWhole = (bytes: Uint8Array): MatroskaTrack[] => {
        const tracks = readHeader(bytes, 0, bytes.length)
        if (tracks === null) throw new Error('the Tracks header is not whole')
        return readTracks(bytes, tracks).tracks
      }

      // A Tracks element that claims more than the bytes hold.
      const whole = tracksElement([entry])
      refused(() => readWhole(whole.subarray(0, whole.length - 3)), 'damaged')

      // A Tracks element of unknown size, which only a Segment or a Cluster may have.
      const open = elementSized(ID.Tracks, unknownSize(), entry)
      refused(() => readWhole(open), 'damaged')

      // And the same entry, whole, is read.
      expect(numbers(readWhole(whole))).toEqual([1])
    })
  })

  describe('the damage that stops the walk of the Tracks element', () => {
    /** An entry that the Tracks element cannot walk past, in each way that it can't. */
    const UNWALKABLE: [string, Uint8Array, RegExp][] = [
      ['an entry that claims more than the Tracks element holds', overrun(ID.TrackEntry), /claims/],
      [
        'an entry of unknown size',
        elementSized(ID.TrackEntry, unknownSize(), trackEntry(picture(9))),
        /unknown size/,
      ],
      ['an entry whose header the Tracks element cuts short', new Uint8Array([0xae]), /cut short/],
    ]

    // Whatever stands after an entry that can't be walked past can't be told from its data, so each of these ends its Tracks element.
    it.each(UNWALKABLE)(
      'keeps the tracks before %s, with the damage, and the picture and the sounds play',
      (_name, damaged, says) => {
        const { tracks, damage } = readResult([
          trackEntry(picture(1)),
          trackEntry(sound(2)),
          damaged,
        ])
        expect(numbers(tracks)).toEqual([1, 2])
        expect(tracks.every((track) => track.problem === null && track.refusal === null)).toBe(true)
        expect(damage).toBeInstanceOf(Mp4Error)
        expect(damage?.reason).toBe('damaged')
        expect(damage?.message).toMatch(says)

        // A picture was read before the damage, so the damage costs nothing.
        const chosen = chooseMatroskaTracks(tracks, damage)
        expect(chosen.video).toBe(tracks[0])
        expect(chosen.sounds).toEqual([tracks[1]])
      },
    )

    it('keeps a broken entry that is still whole in the Tracks element on the track, and the walk goes on', () => {
      const { tracks, damage } = readResult([
        trackEntry(picture(1)),
        trackEntry({ ...sound(2), extra: [overrun(ID.CodecPrivate)] }),
        trackEntry(sound(3)),
      ])
      expect(numbers(tracks)).toEqual([1, 2, 3])
      expect(tracks[1]?.problem).not.toBeNull()
      expect(damage).toBeNull()
    })

    it.each(UNWALKABLE)(
      'refuses for the damage, and not as having no picture, when %s stops the walk before any picture',
      (_name, damaged) => {
        const { tracks, damage } = readResult([trackEntry(sound(1)), damaged])
        expect(numbers(tracks)).toEqual([1])
        expect(damage).toBeInstanceOf(Mp4Error)
        const refusal = refused(() => chooseMatroskaTracks(tracks, damage), 'damaged')
        expect(refusal).toBe(damage)
      },
    )

    it('refuses for the damage when it is the first thing in the Tracks element', () => {
      const { tracks, damage } = readResult([overrun(ID.TrackEntry)])
      expect(tracks).toEqual([])
      expect(damage).toBeInstanceOf(Mp4Error)
      expect(refused(() => chooseMatroskaTracks(tracks, damage), 'damaged')).toBe(damage)
    })

    it('refuses for the damage when the picture read before it is disabled, as it is no picture that plays', () => {
      const { tracks, damage } = readResult([
        trackEntry(picture(1, { enabled: false })),
        trackEntry(sound(2)),
        overrun(ID.TrackEntry),
      ])
      expect(numbers(tracks)).toEqual([1, 2])
      expect(refused(() => chooseMatroskaTracks(tracks, damage), 'damaged')).toBe(damage)
    })

    it('has no damage when the Tracks element walks to its end', () => {
      expect(readResult([trackEntry(picture(1)), trackEntry(sound(2))]).damage).toBeNull()
      expect(readResult([]).damage).toBeNull()
      // The CRC-32 and the Void that stand between the entries are not damage.
      const { damage } = readResult([
        element(ID.CRC32, [1, 2, 3, 4]),
        trackEntry(picture(1)),
        element(ID.Void, [0, 0]),
      ])
      expect(damage).toBeNull()
    })

    it('still refuses as having no picture when there is no damage to give', () => {
      const { tracks, damage } = readResult([trackEntry(sound(1))])
      expect(damage).toBeNull()
      refused(() => chooseMatroskaTracks(tracks, damage), 'no-picture')
      refused(() => chooseMatroskaTracks(tracks), 'no-picture')
    })
  })

  describe('what a track is wrapped in', () => {
    it('takes header stripping, which puts back what each frame lacked, for a track that plays', () => {
      const track = only(
        picture(1, {
          encodings: [
            {
              scope: 1,
              type: 0,
              compression: { algo: 3, settings: new Uint8Array([0x0b, 0x77]) },
            },
          ],
        }),
      )
      expect(track.problem).toBeNull()
      expect(track.refusal).toBeNull()
      expect(track.stripped).toEqual(new Uint8Array([0x0b, 0x77]))
    })

    it('takes header stripping with the defaults of its scope and type, and with nothing to put back', () => {
      const track = only(sound(2, { encodings: [{ compression: { algo: 3 } }] }))
      expect(track.refusal).toBeNull()
      expect(track.stripped).toEqual(new Uint8Array(0))
    })

    it('takes no encoding for none, and ContentEncodings with no ContentEncoding for none too', () => {
      for (const encodings of [undefined, []]) {
        const track = only(picture(1, { encodings }))
        expect(track).toMatchObject({ problem: null, refusal: null })
        expect(track.stripped).toEqual(new Uint8Array(0))
      }
    })

    it.each<[string, number | undefined, string]>([
      ['by default, when it names no algorithm', undefined, 'zlib'],
      ['by algorithm 0', 0, 'zlib'],
      ['by algorithm 1', 1, 'bzlib'],
      ['by algorithm 2', 2, 'lzo1x'],
    ])('refuses a track compressed %s', (_name, algo, name) => {
      const track = only(
        sound(2, { encodings: [{ compression: algo === undefined ? {} : { algo } }] }),
      )
      const refusal = refusalOf(track)
      expect(refusal.reason).toBe('unsupported-codec')
      expect(refusal.message).toContain(name)
      expect(refusal.message).toContain(`ContentCompAlgo ${algo ?? 0}`)
      expect(track.stripped).toEqual(new Uint8Array(0))
    })

    it('refuses a track compressed by an algorithm that no one has named', () => {
      const refusal = refusalOf(only(sound(2, { encodings: [{ compression: { algo: 9 } }] })))
      expect(refusal.reason).toBe('unsupported-codec')
      expect(refusal.message).toContain('ContentCompAlgo 9')
    })

    it('refuses an encrypted track, whether its type or its ContentEncryption says so', () => {
      for (const encoding of [
        { type: 1, encryption: true },
        { type: 1 },
        { type: 0, encryption: true },
      ]) {
        const refusal = refusalOf(only(picture(1, { encodings: [encoding] })))
        expect(refusal.reason).toBe('unsupported-codec')
        expect(refusal.message).toContain('encrypted')
      }
    })

    it('refuses an encoding of a type that is neither compression nor encryption', () => {
      const refusal = refusalOf(only(picture(1, { encodings: [{ type: 2 }] })))
      expect(refusal.reason).toBe('unsupported-codec')
      expect(refusal.message).toContain('ContentEncodingType 2')
    })

    it('refuses a compression that has no ContentCompression to say what it is', () => {
      const refusal = refusalOf(only(picture(1, { encodings: [{ type: 0 }] })))
      expect(refusal.reason).toBe('unsupported-codec')
      expect(refusal.message).toContain('ContentCompression')
    })

    it('refuses an encoding of a scope that is not the frames', () => {
      for (const scope of [2, 3, 4]) {
        const refusal = refusalOf(
          only(picture(1, { encodings: [{ scope, compression: { algo: 3 } }] })),
        )
        expect(refusal.reason).toBe('unsupported-codec')
        expect(refusal.message).toContain(`ContentEncodingScope ${scope}`)
      }
    })

    it('refuses a track with more than one encoding, even when each is header stripping', () => {
      const strip = { compression: { algo: 3, settings: new Uint8Array([1]) } }
      const refusal = refusalOf(only(picture(1, { encodings: [strip, strip] })))
      expect(refusal.reason).toBe('unsupported-codec')
      expect(refusal.message).toContain('2 content encodings')
    })

    it('says a refusal in a sentence that reads after "The picture track can\'t be played: " and on its own', () => {
      for (const encodings of [
        [{ compression: {} }],
        [{ type: 1, encryption: true }],
        [{ scope: 2, compression: { algo: 3 } }],
        [{ compression: { algo: 3 } }, { compression: { algo: 3 } }],
        [{ type: 5 }],
        [{ type: 0 }],
      ]) {
        const { message } = refusalOf(only(picture(1, { encodings })))
        expect(message).toMatch(/^[a-z].*\.$/)
      }
      expect(refusalOf(only(picture(1, { timestampScale: 2 }))).message).toMatch(/^[a-z].*\.$/)
    })
  })

  describe("the scale of a track's timestamps", () => {
    it('takes a TrackTimestampScale of 1, written or left out', () => {
      for (const timestampScale of [undefined, 1]) {
        expect(only(picture(1, { timestampScale }))).toMatchObject({ refusal: null, problem: null })
      }
    })

    it('refuses any other, as damaged', () => {
      for (const timestampScale of [2, 0.5, 1.000001, 0]) {
        const refusal = refusalOf(only(picture(1, { timestampScale })))
        expect(refusal.reason).toBe('damaged')
        expect(refusal.message).toContain('TrackTimestampScale')
        expect(refusal.message).toContain(String(timestampScale))
      }
    })

    it('keeps a problem on a track whose TrackTimestampScale is no number', () => {
      const track = only({
        ...picture(1),
        extra: [float(ID.TrackTimestampScale, Number.POSITIVE_INFINITY)],
      })
      expect(track.problem).not.toBeNull()
      expect(track.refusal).toBeNull()
    })
  })
})

describe('choosing the picture and the sounds (§10.4, D45)', () => {
  it('plays the sounds in the order of the file when none is flagged default, as OBS writes six', () => {
    const tracks = read([
      picture(1),
      ...[2, 3, 4, 5, 6, 7].map((number) => sound(number, { default: false })),
    ])
    const chosen = chooseMatroskaTracks(tracks)
    expect(chosen.video.number).toBe(1)
    expect(numbers(chosen.sounds)).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('plays the sound flagged default first, and the others after it in the order of the file', () => {
    const tracks = read([
      sound(1, { default: false }),
      sound(2, { default: true }),
      sound(3, { default: false }),
      picture(4),
    ])
    expect(numbers(chooseMatroskaTracks(tracks).sounds)).toEqual([2, 1, 3])
  })

  it('plays the first of several flagged default first, and the other flagged ones where the file has them', () => {
    const tracks = read([
      picture(1),
      sound(2, { default: false }),
      sound(3),
      sound(4, { default: false }),
      sound(5, { default: true }),
    ])
    expect(numbers(chooseMatroskaTracks(tracks).sounds)).toEqual([3, 2, 4, 5])
  })

  it('takes a sound with no FlagDefault for one flagged default', () => {
    const tracks = read([picture(1), sound(2, { default: false }), sound(3)])
    expect(numbers(chooseMatroskaTracks(tracks).sounds)).toEqual([3, 2])
  })

  it('leaves out the tracks that are disabled, and a disabled sound flagged default plays first no more', () => {
    const tracks = read([
      picture(1),
      sound(2, { default: false }),
      sound(3, { default: true, enabled: false }),
      sound(4, { default: false }),
    ])
    expect(numbers(chooseMatroskaTracks(tracks).sounds)).toEqual([2, 4])
  })

  it('plays the first enabled picture when the first is disabled', () => {
    const tracks = read([picture(1, { enabled: false }), picture(2), picture(3), sound(4)])
    expect(chooseMatroskaTracks(tracks).video.number).toBe(2)
  })

  it('plays no sound when the file has none, or none is enabled', () => {
    expect(chooseMatroskaTracks(read([picture(1)])).sounds).toEqual([])
    expect(chooseMatroskaTracks(read([picture(1), sound(2, { enabled: false })])).sounds).toEqual(
      [],
    )
  })

  it('does not take a track of another kind for a picture or a sound', () => {
    const chosen = chooseMatroskaTracks(
      read([{ number: 1, type: 17, codecId: 'S_TEXT/UTF8' }, picture(2), sound(3)]),
    )
    expect(chosen.video.number).toBe(2)
    expect(numbers(chosen.sounds)).toEqual([3])
  })

  it.each<[string, TrackSpec[]]>([
    ['no tracks', []],
    ['only sounds', [sound(1), sound(2)]],
    ['only a track of another kind', [{ number: 1, type: 17, codecId: 'S_TEXT/UTF8' }]],
    ['only a picture that is disabled', [picture(1, { enabled: false }), sound(2)]],
  ])('refuses a file with %s as having no picture', (_name, specs) => {
    const refusal = refused(() => chooseMatroskaTracks(read(specs)), 'no-picture')
    expect(refusal.message).toBe('The file has no picture track, so there is nothing to play.')
  })

  it('plays the first enabled picture whatever is wrong with it, and no other picture in its place', () => {
    const problem = chooseMatroskaTracks(
      read([picture(1, { codecId: undefined }), picture(2), sound(3)]),
    )
    expect(problem.video.number).toBe(1)
    expect(problem.video.problem).not.toBeNull()

    const refusal = chooseMatroskaTracks(
      read([picture(1, { timestampScale: 2 }), picture(2), sound(3)]),
    )
    expect(refusal.video.number).toBe(1)
    expect(refusal.video.refusal?.reason).toBe('damaged')

    // A picture whose entry could not be walked past its TrackType is still the picture.
    const broken = chooseMatroskaTracks(
      read([picture(1, { extra: [overrun(ID.CodecPrivate)] }), picture(2)]),
    )
    expect(broken.video.number).toBe(1)
    expect(broken.video.problem).not.toBeNull()
  })

  it('keeps a sound that has a problem or a refusal where the file has it, for the index to decide on', () => {
    const tracks = read([
      picture(1),
      sound(2, { codecId: undefined, default: false }),
      sound(3, { encodings: [{ compression: {} }], default: false }),
      sound(4, { default: false }),
    ])
    const { sounds } = chooseMatroskaTracks(tracks)
    expect(numbers(sounds)).toEqual([2, 3, 4])
    expect(sounds[0]?.problem).not.toBeNull()
    expect(sounds[1]?.refusal).not.toBeNull()
  })

  it('does not change the tracks it is given, and gives the same track objects back', () => {
    const tracks = read([picture(1), sound(2, { default: false }), sound(3)])
    const before = [...tracks]
    const chosen = chooseMatroskaTracks(tracks)
    expect(tracks).toEqual(before)
    expect(chosen.video).toBe(tracks[0])
    expect(chosen.sounds[0]).toBe(tracks[2])
    expect(chosen.sounds[1]).toBe(tracks[1])
  })
})
