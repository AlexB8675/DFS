import { describe, expect, it } from 'vitest'
import { codecNames, initEntry, soundRateField } from '../codecs.ts'
import { Mp4Error } from '../errors.ts'
import type { Mp4Refusal } from '../errors.ts'
import {
  alacConfig,
  audioEntry,
  audioSpecificConfig,
  bits,
  box,
  concat,
  descriptor,
  dfLa,
  dOps,
  fourcc,
  fullBox,
  i16,
  u16,
  u32,
} from '../testing/build.ts'
import type { Part } from '../testing/build.ts'
import { MP3_ESDS } from '../testing/entries.ts'
import { ac3Config, eac3Config } from './frameheaders.ts'
import { matroskaSoundEntry, needsFirstFrame } from './sounds.ts'
import type { MatroskaTrack } from './tracks.ts'

// The sample entry that each Matroska sound codec stands for (DESIGN.md §10.4,
// D45): an ISO version 0 sound entry that `initEntry` carries as it is and
// `codecNames` names, so that a Matroska sound plays through the same init
// segments as an MP4 one. Every input is built in code, byte by byte, and every
// expected box is written out as the standards lay it out (ISO/IEC 14496-1 and
// -3, RFC 7845 and the Opus-in-ISOBMFF binding, the FLAC-in-ISOBMFF binding,
// ETSI TS 102 366, Apple's ALAC magic cookie), not taken from the module.

/** What a sound entry holds before its child boxes: its box header, then 28 bytes. */
const CHILDREN = 8 + 28

/** Bytes as a view onto a longer array, which is how the reader gives them, so that a read that forgets where a view begins reads the wrong bytes. */
function view(bytes: Uint8Array | number[]): Uint8Array {
  const own = Uint8Array.from(bytes)
  return concat([9, 9, 9], own, [7, 7]).subarray(3, 3 + own.length)
}

interface SoundSpec {
  codecId: string
  codecPrivate?: Uint8Array | number[] | null
  samplingFrequency?: number
  outputSamplingFrequency?: number | null
  channels?: number
}

/** A sound track as the reader gives it: 48 kHz stereo unless the spec says another. */
function sound(spec: SoundSpec): MatroskaTrack {
  return {
    number: 2,
    kind: 'audio',
    enabled: true,
    default: true,
    forced: false,
    language: 'eng',
    codecId: spec.codecId,
    codecPrivate: spec.codecPrivate ? view(spec.codecPrivate) : null,
    codecDelay: 0,
    seekPreRoll: 0,
    defaultDuration: null,
    video: null,
    audio: {
      samplingFrequency: spec.samplingFrequency ?? 48000,
      outputSamplingFrequency: spec.outputSamplingFrequency ?? null,
      channels: spec.channels ?? 2,
      bitDepth: null,
    },
    stripped: new Uint8Array(0),
    blockAdditions: [],
    refusal: null,
    problem: null,
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

/** Bytes written as hex digits, spaced or not. */
function fromHex(digits: string): Uint8Array {
  const clean = digits.replace(/\s+/g, '')
  return Uint8Array.from({ length: clean.length / 2 }, (_, index) =>
    parseInt(clean.slice(index * 2, index * 2 + 2), 16),
  )
}

/** The type of an entry, read from its bytes. */
function typeOf(entry: Uint8Array): string {
  return String.fromCharCode(...entry.subarray(4, 8))
}

/** The names that `codecNames` gives an entry, as the index will ask for them. */
function names(entry: Uint8Array): string[] {
  return codecNames({ type: typeOf(entry), bytes: entry, stsdVersion: 0 })
}

/** The entry made for a track, which `initEntry` must carry as it is: the very bytes, not a copy. */
function made(track: MatroskaTrack, firstFrame: Uint8Array | null = null): Uint8Array {
  const entry = matroskaSoundEntry(track, firstFrame)
  expect(initEntry({ type: typeOf(entry), bytes: entry, stsdVersion: 0 })).toBe(entry)
  return entry
}

/** The fields of a sound entry: its channels, the size of a sample and its rate in hertz (the 16.16 field read as a number). */
function fields(entry: Uint8Array): { channels: number; sampleSize: number; rate: number } {
  const data = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
  return {
    channels: data.getUint16(24),
    sampleSize: data.getUint16(26),
    rate: data.getUint32(32) / 0x10000,
  }
}

/** What the entry holds after its fields: the configuration box, and nothing else. */
function configOf(entry: Uint8Array): Uint8Array {
  return entry.subarray(CHILDREN)
}

/** What `run` throws, which must be an `Mp4Error` of this reason, and a sentence that reads after "The sound track can't be played: ". */
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

/** The `esds` box as ISO/IEC 14496-1 lays it out for these tests: ES_ID 0 and no flags, the DecoderConfigDescriptor (no buffer, no bit rates) with the DecoderSpecificInfo if there is one, and the SLConfigDescriptor of 2. */
function esdsBox(config: Part | null, objectType = 0x40): Uint8Array {
  return fullBox(
    'esds',
    0,
    0,
    descriptor(0x03, [
      ...u16(0), // the ES_ID
      0, // no flags
      ...descriptor(0x04, [
        objectType,
        0x15, // an audio stream, and not an upstream
        ...[0, 0, 0], // the size of the buffer
        ...u32(0), // the highest bit rate
        ...u32(0), // the average bit rate
        ...(config === null ? [] : descriptor(0x05, config)),
      ]),
      ...descriptor(0x06, [2]), // the SLConfigDescriptor
    ]),
  )
}

describe('soundRateField', () => {
  it('is the rate in 16.16 while its whole part fits the 16 bits that ISO has for it', () => {
    expect(soundRateField(44100)).toBe(0xac440000)
    expect(soundRateField(8000)).toBe(0x1f400000)
    expect(soundRateField(65535)).toBe(0xffff0000)
    expect(soundRateField(22050.5)).toBe(0x56228000)
  })

  it('halves a rate that is over 65535 as often as it takes, as FFmpeg writes it', () => {
    expect(soundRateField(65536)).toBe(0x80000000)
    expect(soundRateField(88200)).toBe(0xac440000)
    expect(soundRateField(96000)).toBe(0xbb800000)
    expect(soundRateField(192000)).toBe(0xbb800000)
    expect(soundRateField(384000)).toBe(0xbb800000)
  })

  it('is damaged for what is no rate, with a sentence that reads after a prefix', () => {
    for (const rate of [0, -44100, Number.NaN, Number.POSITIVE_INFINITY, 0.000001]) {
      refused('damaged', () => soundRateField(rate))
    }
  })
})

describe('the entry of an AAC sound', () => {
  it('is an mp4a entry with an esds around the AudioSpecificConfig of the CodecPrivate', () => {
    const entry = made(sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90] }))
    expect(typeOf(entry)).toBe('mp4a')
    expect(names(entry)).toEqual(['mp4a.40.2'])
    expect(fields(entry)).toEqual({ channels: 2, sampleSize: 16, rate: 48000 })
    expect(hex(configOf(entry))).toBe(
      [
        '00 00 00 27 65 73 64 73', // the box: 39 bytes, 'esds'
        '00 00 00 00', // version and flags
        '03 19 00 00 00', // the ES_Descriptor, of 25 bytes: ES_ID 0, no flags
        '04 11 40 15 00 00 00', // the DecoderConfigDescriptor, of 17: MPEG-4 audio, an audio stream, no buffer
        '00 00 00 00 00 00 00 00', // no bit rates
        '05 02 11 90', // the DecoderSpecificInfo
        '06 01 02', // the SLConfigDescriptor
      ].join(' '),
    )
    expect(entry).toEqual(
      audioEntry('mp4a', { channels: 2, sampleRate: 48000 }, esdsBox([0x11, 0x90])),
    )
  })

  it('is checked against the module: the esds laid out for MPEG-1 audio and no config is MP3_ESDS', () => {
    // The expected bytes of these tests are made by `esdsBox`; this shows that it is the box the module's own MP3 entry has.
    expect(esdsBox(null, 0x6b)).toEqual(MP3_ESDS)
  })

  it('takes the CodecPrivate as the config whatever the CodecID says, and keeps it as it is', () => {
    const he = made(
      sound({
        codecId: 'A_AAC/MPEG4/LC/SBR',
        codecPrivate: [0x11, 0x88, 0x56, 0xe5, 0x00],
        samplingFrequency: 24000,
        outputSamplingFrequency: 48000,
        channels: 1,
      }),
    )
    expect(names(he)).toEqual(['mp4a.40.2'])
    expect(configOf(he)).toEqual(esdsBox([0x11, 0x88, 0x56, 0xe5, 0x00]))
    // The entry says what the track does: the core rate, and the channels.
    expect(fields(he)).toEqual({ channels: 1, sampleSize: 16, rate: 24000 })
    const old = made(sound({ codecId: 'A_AAC/MPEG2/LC', codecPrivate: [0x12, 0x10] }))
    expect(configOf(old)).toEqual(esdsBox([0x12, 0x10]))
  })

  it('names the audio object type that the config begins with, escape included', () => {
    // 5 bits of 31 and then 6: audio object type 32 + 6 = 38.
    const escaped = bits([31, 5], [6, 6], [4, 4], [2, 4])
    expect(names(made(sound({ codecId: 'A_AAC', codecPrivate: escaped })))).toEqual(['mp4a.40.38'])
  })

  it('writes a size of 128 or more in the form that has 0x80 on every byte but the last', () => {
    const config = [0x11, 0x90, ...new Array<number>(128).fill(0)]
    const entry = made(sound({ codecId: 'A_AAC', codecPrivate: config }))
    expect(names(entry)).toEqual(['mp4a.40.2'])
    expect(configOf(entry)).toEqual(esdsBox(config))
    // The config is 130 bytes (0x81 0x02), the DecoderConfigDescriptor 146 (0x81 0x12) and the ES_Descriptor 155 (0x81 0x1B).
    const text = hex(configOf(entry))
    expect(text).toContain('03 81 1b 00 00 00 04 81 12 40 15')
    expect(text).toContain('05 81 02 11 90')
  })

  it('does not share its bytes with the CodecPrivate', () => {
    const track = sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90] })
    const entry = made(track)
    const before = new Uint8Array(entry)
    track.codecPrivate?.fill(0)
    expect(entry).toEqual(before)
  })

  it('is damaged for the bare A_AAC with no CodecPrivate, or an empty one', () => {
    for (const codecPrivate of [null, new Uint8Array(0)]) {
      const error = refused('damaged', () =>
        matroskaSoundEntry(sound({ codecId: 'A_AAC', codecPrivate }), null),
      )
      expect(error.message).toContain('AudioSpecificConfig')
    }
  })

  it('has the channels and the rate of the track, the rate as soundRateField makes it', () => {
    const wide = made(
      sound({
        codecId: 'A_AAC',
        codecPrivate: [0x11, 0x90],
        samplingFrequency: 96000,
        channels: 6,
      }),
    )
    expect(fields(wide)).toEqual({ channels: 6, sampleSize: 16, rate: 48000 })
    const most = made(sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90], channels: 65535 }))
    expect(fields(most).channels).toBe(65535)
  })

  it('is damaged for no channels, for more than 16 bits of them, and for a rate that is no rate', () => {
    for (const channels of [0, 65536]) {
      const error = refused('damaged', () =>
        matroskaSoundEntry(sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90], channels }), null),
      )
      expect(error.message).toContain(`${channels} channels`)
    }
    for (const samplingFrequency of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      refused('damaged', () =>
        matroskaSoundEntry(
          sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90], samplingFrequency }),
          null,
        ),
      )
    }
  })
})

describe('the AudioSpecificConfig of an old AAC CodecID with no CodecPrivate', () => {
  /** The config an old CodecID gets, as the entry's esds holds it: the DecoderSpecificInfo, which for a config this short begins at byte 34 with its tag and a one-byte length. */
  function config(spec: SoundSpec): Uint8Array {
    const entry = made(sound(spec))
    expect(typeOf(entry)).toBe('mp4a')
    const esds = configOf(entry)
    expect(esds[32]).toBe(0x05)
    const found = esds.slice(34, 34 + (esds[33] ?? 0))
    expect(esds).toEqual(esdsBox(found))
    return found
  }

  it('is 13 10 56 E5 98 for LC with SBR at 24000 Hz, output 48000, in 2 channels', () => {
    const entry = made(
      sound({
        codecId: 'A_AAC/MPEG4/LC/SBR',
        samplingFrequency: 24000,
        outputSamplingFrequency: 48000,
        channels: 2,
      }),
    )
    expect(names(entry)).toEqual(['mp4a.40.2'])
    expect(configOf(entry)).toEqual(esdsBox([0x13, 0x10, 0x56, 0xe5, 0x98]))
    expect(fields(entry)).toEqual({ channels: 2, sampleSize: 16, rate: 24000 })
  })

  it('has the profile that the ID names: 1 for MAIN, 2 for LC, 3 for SSR, and 4 for any other', () => {
    const profiles: [string, number][] = [
      ['A_AAC/MPEG2/MAIN', 1],
      ['A_AAC/MPEG4/MAIN', 1],
      ['A_AAC/MPEG2/LC', 2],
      ['A_AAC/MPEG4/LC', 2],
      ['A_AAC/MPEG2/SSR', 3],
      ['A_AAC/MPEG4/SSR', 3],
      ['A_AAC/MPEG4/LTP', 4],
      ['A_AAC/MPEG4/WHATEVER', 4],
    ]
    for (const [codecId, profile] of profiles) {
      expect(config({ codecId }), codecId).toEqual(
        Uint8Array.from(audioSpecificConfig(profile, { frequencyIndex: 3, channels: 2 })),
      )
    }
    // An ID that names two is matched in the order MAIN, LC, SSR, as ffmpeg matches them.
    expect(config({ codecId: 'A_AAC/MPEG4/LC/MAIN' }).subarray(0, 1)).toEqual(Uint8Array.of(0x09))
    // An ID with SBR is matched for its profile as the ID without it is.
    expect(config({ codecId: 'A_AAC/MPEG2/LC/SBR' }).subarray(0, 2)).toEqual(
      Uint8Array.from(audioSpecificConfig(2, { frequencyIndex: 3, channels: 2 })),
    )
    expect(config({ codecId: 'A_AAC/MPEG4/SSR/SBR' }).subarray(0, 1)).toEqual(Uint8Array.of(0x19))
  })

  it('has the index of the sampling frequency in ISO/IEC 14496-3, split across the two bytes', () => {
    const rates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ]
    rates.forEach((samplingFrequency, index) => {
      expect(
        config({ codecId: 'A_AAC/MPEG4/LC', samplingFrequency, channels: 1 }),
        `${samplingFrequency}`,
      ).toEqual(Uint8Array.from(audioSpecificConfig(2, { frequencyIndex: index, channels: 1 })))
    })
    // The odd indexes put their low bit in the top of the second byte: 22050 is 7, 32000 is 5.
    expect(hex(config({ codecId: 'A_AAC/MPEG4/LC', samplingFrequency: 22050 }))).toBe('13 90')
    expect(hex(config({ codecId: 'A_AAC/MPEG4/LC', samplingFrequency: 32000 }))).toBe('12 90')
  })

  it('has the channels in the second byte, as the count', () => {
    expect(hex(config({ codecId: 'A_AAC/MPEG4/LC', channels: 1 }))).toBe('11 88')
    expect(hex(config({ codecId: 'A_AAC/MPEG4/LC', channels: 6 }))).toBe('11 b0')
  })

  it('adds the SBR extension with the index of the output frequency, or of the frequency when the track has no output', () => {
    expect(
      hex(
        config({
          codecId: 'A_AAC/MPEG4/LC/SBR',
          samplingFrequency: 22050,
          outputSamplingFrequency: 44100,
        }),
      ),
    ).toBe('13 90 56 e5 a0')
    expect(hex(config({ codecId: 'A_AAC/MPEG2/LC/SBR', samplingFrequency: 48000 }))).toBe(
      '11 90 56 e5 98',
    )
    // An output of 96000 is index 0, 7350 is index 12.
    expect(
      hex(config({ codecId: 'A_AAC/MPEG4/LC/SBR', outputSamplingFrequency: 96000 })).slice(6),
    ).toBe('56 e5 80')
    expect(
      hex(config({ codecId: 'A_AAC/MPEG4/LC/SBR', outputSamplingFrequency: 7350 })).slice(6),
    ).toBe('56 e5 e0')
  })

  it('is made when the CodecPrivate is empty, not only when it is left out', () => {
    const entry = made(sound({ codecId: 'A_AAC/MPEG4/LC', codecPrivate: new Uint8Array(0) }))
    expect(configOf(entry)).toEqual(esdsBox([0x11, 0x90]))
  })

  it('is damaged when the sampling frequency, or the output frequency of an SBR, is none that the table has', () => {
    const track = { codecId: 'A_AAC/MPEG4/LC/SBR', samplingFrequency: 24000 }
    const core = refused('damaged', () =>
      matroskaSoundEntry(sound({ ...track, samplingFrequency: 44101 }), null),
    )
    expect(core.message).toContain('44101')
    const output = refused('damaged', () =>
      matroskaSoundEntry(sound({ ...track, outputSamplingFrequency: 50000 }), null),
    )
    expect(output.message).toContain('50000')
    // Without SBR the output frequency is not asked.
    expect(() =>
      matroskaSoundEntry(
        sound({
          codecId: 'A_AAC/MPEG4/LC',
          samplingFrequency: 24000,
          outputSamplingFrequency: 50000,
        }),
        null,
      ),
    ).not.toThrow()
    refused('damaged', () =>
      matroskaSoundEntry(sound({ codecId: 'A_AAC/MPEG4/LC', samplingFrequency: 0 }), null),
    )
  })
})

/** An OpusHead (RFC 7845 §5.1), the CodecPrivate of an Opus track: little-endian, version 1. */
function opusHead({
  channels = 2,
  preSkip = 312,
  rate = 48000,
  gain = 0,
  family = 0,
  after = [] as number[],
} = {}): Uint8Array {
  const out = new Uint8Array(19 + after.length)
  out.set(Array.from('OpusHead', (letter) => letter.charCodeAt(0)))
  const data = new DataView(out.buffer)
  out[8] = 1
  out[9] = channels
  data.setUint16(10, preSkip, true)
  data.setUint32(12, rate, true)
  data.setInt16(16, gain, true)
  out[18] = family
  out.set(after, 19)
  return out
}

describe('the entry of an Opus sound', () => {
  it("is an Opus entry with the dOps that OBS's OpusHead gives", () => {
    const head = fromHex('4f707573486561640102380180bb0000000000')
    expect(opusHead()).toEqual(head)
    const entry = made(sound({ codecId: 'A_OPUS', codecPrivate: head }))
    expect(typeOf(entry)).toBe('Opus')
    expect(names(entry)).toEqual(['opus', 'Opus'])
    // Big-endian, as ffmpeg's remux to MP4 writes it: version 0, 2 channels, pre-skip 312, 48000, gain 0, family 0.
    expect(hex(configOf(entry))).toBe('00 00 00 13 64 4f 70 73 00 02 01 38 00 00 bb 80 00 00 00')
    expect(configOf(entry)).toEqual(dOps())
    expect(entry).toEqual(audioEntry('Opus', { channels: 2, sampleRate: 48000 }, dOps()))
  })

  it('has the OpusHead channel count and the rate of 48000, whatever the track says', () => {
    const head = opusHead({ channels: 1, rate: 44100 })
    const entry = made(
      sound({ codecId: 'A_OPUS', codecPrivate: head, samplingFrequency: 44100, channels: 2 }),
    )
    expect(fields(entry)).toEqual({ channels: 1, sampleSize: 16, rate: 48000 })
    // The input rate is the OpusHead's, in the dOps.
    expect(configOf(entry)).toEqual(box('dOps', [0, 1], u16(312), u32(44100), i16(0), [0]))
  })

  it('writes the pre-skip, the rate and the gain big-endian, the gain signed', () => {
    for (const gain of [0x0102, -1, -32768, 32767]) {
      const entry = made(
        sound({
          codecId: 'A_OPUS',
          codecPrivate: opusHead({ preSkip: 0x0138, rate: 0x01020304, gain }),
        }),
      )
      expect(configOf(entry), `${gain}`).toEqual(
        box('dOps', [0, 2], u16(0x0138), u32(0x01020304), i16(gain), [0]),
      )
    }
  })

  it('carries the stream count, the coupled count and the mapping of a family other than 0', () => {
    const mapping = [0, 4, 1, 2, 3, 5]
    const head = opusHead({ channels: 6, family: 1, after: [4, 2, ...mapping] })
    const entry = made(sound({ codecId: 'A_OPUS', codecPrivate: head, channels: 6 }))
    expect(typeOf(entry)).toBe('Opus')
    expect(names(entry)).toEqual(['opus', 'Opus'])
    expect(configOf(entry)).toEqual(
      box('dOps', [0, 6], u16(312), u32(48000), i16(0), [1, 4, 2], mapping),
    )
    expect(fields(entry).channels).toBe(6)
  })

  it('ignores what follows the OpusHead and its mapping', () => {
    const head = concat(opusHead(), [1, 2, 3])
    expect(configOf(made(sound({ codecId: 'A_OPUS', codecPrivate: head })))).toEqual(dOps())
  })

  it('does not share its bytes with the CodecPrivate', () => {
    const track = sound({ codecId: 'A_OPUS', codecPrivate: opusHead() })
    const entry = made(track)
    const before = new Uint8Array(entry)
    track.codecPrivate?.fill(0)
    expect(entry).toEqual(before)
  })

  it('is damaged for an OpusHead of under 19 bytes, one without the magic, and no CodecPrivate', () => {
    for (const length of [0, 1, 10, 18]) {
      refused('damaged', () =>
        matroskaSoundEntry(
          sound({ codecId: 'A_OPUS', codecPrivate: opusHead().subarray(0, length) }),
          null,
        ),
      )
    }
    const wrong = opusHead()
    wrong[7] = 0x65 // 'OpusHeae'
    const error = refused('damaged', () =>
      matroskaSoundEntry(sound({ codecId: 'A_OPUS', codecPrivate: wrong }), null),
    )
    expect(error.message).toContain('OpusHead')
    refused('damaged', () => matroskaSoundEntry(sound({ codecId: 'A_OPUS' }), null))
  })

  it('is damaged when the OpusHead is too short for the mapping of its family, to the byte', () => {
    const whole = opusHead({ channels: 6, family: 1, after: [4, 2, 0, 4, 1, 2, 3, 5] })
    expect(whole).toHaveLength(27)
    for (let length = 19; length < 27; length += 1) {
      refused('damaged', () =>
        matroskaSoundEntry(
          sound({ codecId: 'A_OPUS', codecPrivate: whole.subarray(0, length) }),
          null,
        ),
      )
    }
    expect(() =>
      matroskaSoundEntry(sound({ codecId: 'A_OPUS', codecPrivate: whole }), null),
    ).not.toThrow()
  })

  it('is damaged for an OpusHead with no channels', () => {
    refused('damaged', () =>
      matroskaSoundEntry(
        sound({ codecId: 'A_OPUS', codecPrivate: opusHead({ channels: 0 }) }),
        null,
      ),
    )
  })
})

/** FLAC's STREAMINFO block (34 bytes), as the `dfLa` builder lays it out after its block header. */
function streamInfo(spec: { channels?: number; sampleRate?: number } = {}): Uint8Array {
  return dfLa(spec).subarray(16)
}

/** A VORBIS_COMMENT block, flagged last (0x84), with an empty vendor string and no comments. */
const VORBIS_COMMENT = [0x84, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]

describe('the entry of a FLAC sound', () => {
  it('is an fLaC entry with a dfLa that holds STREAMINFO alone, flagged last', () => {
    const info = streamInfo({ channels: 2, sampleRate: 44100 })
    expect(info).toHaveLength(34)
    // STREAMINFO is flagged "not last" here, and a VORBIS_COMMENT follows it.
    const privateData = concat(fourcc('fLaC'), [0x00, 0, 0, 34], info, VORBIS_COMMENT)
    const entry = made(
      sound({ codecId: 'A_FLAC', codecPrivate: privateData, samplingFrequency: 44100 }),
    )
    expect(typeOf(entry)).toBe('fLaC')
    expect(names(entry)).toEqual(['flac', 'fLaC'])
    expect(configOf(entry)).toEqual(dfLa({ channels: 2, sampleRate: 44100 }))
    expect(hex(configOf(entry).subarray(0, 16))).toBe(
      '00 00 00 32 64 66 4c 61 00 00 00 00 80 00 00 22',
    )
    expect(entry).toEqual(audioEntry('fLaC', { channels: 2, sampleRate: 44100 }, dfLa()))
  })

  it('is the same when STREAMINFO is the only block, and flagged last already', () => {
    const info = streamInfo({ channels: 2, sampleRate: 44100 })
    const alone = made(
      sound({ codecId: 'A_FLAC', codecPrivate: concat(fourcc('fLaC'), [0x80, 0, 0, 34], info) }),
    )
    expect(configOf(alone)).toEqual(dfLa())
  })

  it("has STREAMINFO's channels and rate, and 96 kHz gives a rate field of 48000", () => {
    const info = streamInfo({ channels: 6, sampleRate: 96000 })
    const entry = made(
      sound({
        codecId: 'A_FLAC',
        codecPrivate: concat(fourcc('fLaC'), [0x80, 0, 0, 34], info),
        samplingFrequency: 44100,
        channels: 2,
      }),
    )
    expect(fields(entry)).toEqual({ channels: 6, sampleSize: 16, rate: 48000 })
    expect(configOf(entry)).toEqual(dfLa({ channels: 6, sampleRate: 96000 }))
  })

  it('reads the 20 bits of the rate and the 3 of the channels where STREAMINFO puts them', () => {
    // The rate field is the rate while it is under 65536, else halved until it is.
    const cases: [sampleRate: number, channels: number, field: number][] = [
      [8000, 1, 8000],
      [44100, 2, 44100],
      [88200, 4, 44100],
      [192000, 8, 48000],
      [1048575, 8, 65535.9375], // the most that the 20 bits hold, halved four times
    ]
    for (const [sampleRate, channels, field] of cases) {
      const info = streamInfo({ channels, sampleRate })
      const entry = made(
        sound({ codecId: 'A_FLAC', codecPrivate: concat(fourcc('fLaC'), [0x80, 0, 0, 34], info) }),
      )
      expect(fields(entry), `${sampleRate}`).toEqual({ channels, sampleSize: 16, rate: field })
    }
  })

  it('does not share its bytes with the CodecPrivate', () => {
    const track = sound({
      codecId: 'A_FLAC',
      codecPrivate: concat(fourcc('fLaC'), [0x80, 0, 0, 34], streamInfo()),
    })
    const entry = made(track)
    const before = new Uint8Array(entry)
    track.codecPrivate?.fill(0)
    expect(entry).toEqual(before)
  })

  it('is damaged without a CodecPrivate that begins fLaC and a STREAMINFO block of 34 bytes', () => {
    const info = streamInfo()
    const bad: [string, Uint8Array | null][] = [
      ['none', null],
      ['empty', new Uint8Array(0)],
      ['the wrong marker', concat(fourcc('OggS'), [0x80, 0, 0, 34], info)],
      ['a first block that is a SEEKTABLE', concat(fourcc('fLaC'), [0x83, 0, 0, 34], info)],
      [
        'a first block that is a PADDING, flagged not last',
        concat(fourcc('fLaC'), [0x01, 0, 0, 34], info),
      ],
      ['a STREAMINFO of 33 bytes', concat(fourcc('fLaC'), [0x80, 0, 0, 33], info.subarray(0, 33))],
      ['a STREAMINFO of 35 bytes', concat(fourcc('fLaC'), [0x80, 0, 0, 35], info, [0])],
      [
        'a STREAMINFO that is cut short',
        concat(fourcc('fLaC'), [0x80, 0, 0, 34], info.subarray(0, 30)),
      ],
    ]
    for (const [what, codecPrivate] of bad) {
      const error = refused('damaged', () =>
        matroskaSoundEntry(sound({ codecId: 'A_FLAC', codecPrivate }), null),
      )
      expect(error.message, what).toContain('fLaC')
    }
  })

  it('is damaged when STREAMINFO gives a rate of 0', () => {
    const info = streamInfo({ channels: 2, sampleRate: 0 })
    refused('damaged', () =>
      matroskaSoundEntry(
        sound({ codecId: 'A_FLAC', codecPrivate: concat(fourcc('fLaC'), [0x80, 0, 0, 34], info) }),
        null,
      ),
    )
  })
})

/** The first syncframe of AC-3 (ETSI TS 102 366, clause 4): 48 kHz, frmsizecod 0x1C, bsid 8, bsmod 0, acmod 7, with the LFE. */
function ac3Frame(): Uint8Array {
  return view(
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

/** The first syncframe of E-AC-3 (Annex E): an independent substream of 1536 bytes, 48 kHz, 6 blocks, acmod 2, bsid 16. */
function eac3Frame(): Uint8Array {
  const out = new Uint8Array(1536)
  out.set(
    bits(
      [0x0b77, 16],
      [0, 2], // strmtyp
      [0, 3], // substreamid
      [767, 11], // frmsiz
      [0, 2], // fscod
      [3, 2], // numblkscod
      [2, 3], // acmod
      [0, 1], // lfeon
      [16, 5], // bsid
      [27, 5], // dialnorm
      [0, 1], // compre
    ),
  )
  return view(out)
}

describe('the entry of an AC-3 and an E-AC-3 sound', () => {
  it("is an ac-3 entry with the dac3 of the track's first frame", () => {
    const entry = made(sound({ codecId: 'A_AC3', channels: 6 }), ac3Frame())
    expect(typeOf(entry)).toBe('ac-3')
    expect(names(entry)).toEqual(['ac-3'])
    expect(hex(configOf(entry))).toBe('00 00 00 0b 64 61 63 33 10 3d c0')
    expect(configOf(entry)).toEqual(ac3Config(ac3Frame()))
    expect(fields(entry)).toEqual({ channels: 6, sampleSize: 16, rate: 48000 })
  })

  it("is an ec-3 entry with the dec3 of the track's first frame", () => {
    const entry = made(sound({ codecId: 'A_EAC3', samplingFrequency: 44100 }), eac3Frame())
    expect(typeOf(entry)).toBe('ec-3')
    expect(names(entry)).toEqual(['ec-3'])
    expect(hex(configOf(entry))).toBe('00 00 00 0d 64 65 63 33 0c 00 20 04 00')
    expect(configOf(entry)).toEqual(eac3Config(eac3Frame()))
    expect(fields(entry)).toEqual({ channels: 2, sampleSize: 16, rate: 44100 })
  })

  it('does not share its bytes with the frame', () => {
    const frame = ac3Frame()
    const entry = made(sound({ codecId: 'A_AC3' }), frame)
    const before = new Uint8Array(entry)
    frame.fill(0)
    expect(entry).toEqual(before)
  })

  it('is damaged without a frame, which the sentence names', () => {
    for (const codecId of ['A_AC3', 'A_EAC3']) {
      const error = refused('damaged', () => matroskaSoundEntry(sound({ codecId }), null))
      expect(error.message, codecId).toContain(
        'no frame of the track to read its configuration from',
      )
    }
  })

  it('is damaged by the frame, in the sentence of the frame', () => {
    refused('damaged', () => matroskaSoundEntry(sound({ codecId: 'A_AC3' }), eac3Frame()))
    refused('damaged', () => matroskaSoundEntry(sound({ codecId: 'A_EAC3' }), new Uint8Array(0)))
  })

  it('is asked for the first frame by A_AC3 and A_EAC3 and by no other CodecID', () => {
    expect(needsFirstFrame(sound({ codecId: 'A_AC3' }))).toBe(true)
    expect(needsFirstFrame(sound({ codecId: 'A_EAC3' }))).toBe(true)
    for (const codecId of [
      'A_AAC',
      'A_AAC/MPEG4/LC',
      'A_OPUS',
      'A_FLAC',
      'A_ALAC',
      'A_MPEG/L3',
      'A_MPEG/L2',
      'A_DTS',
      'A_AC3/BSID9',
    ]) {
      expect(needsFirstFrame(sound({ codecId })), codecId).toBe(false)
    }
  })

  it('is not changed by a first frame that a codec has no use for', () => {
    const plain = made(sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90] }))
    expect(made(sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90] }), ac3Frame())).toEqual(plain)
  })
})

describe('the entry of an MP3 sound', () => {
  it('is an mp4a entry with the esds of MPEG-1 audio that QuickTime’s .mp3 is given', () => {
    const entry = made(sound({ codecId: 'A_MPEG/L3', samplingFrequency: 44100 }))
    expect(typeOf(entry)).toBe('mp4a')
    expect(names(entry)).toEqual(['mp4a.6B', 'mp3', 'mp4a.40.34'])
    expect(configOf(entry)).toEqual(MP3_ESDS)
    expect(entry).toEqual(audioEntry('mp4a', { channels: 2, sampleRate: 44100 }, MP3_ESDS))
  })

  it('has the channels and the rate of the track, and ignores a CodecPrivate', () => {
    const entry = made(
      sound({
        codecId: 'A_MPEG/L3',
        codecPrivate: [1, 2, 3],
        samplingFrequency: 22050,
        channels: 1,
      }),
    )
    expect(fields(entry)).toEqual({ channels: 1, sampleSize: 16, rate: 22050 })
    expect(configOf(entry)).toEqual(MP3_ESDS)
  })

  it('does not share its bytes with another entry', () => {
    const first = made(sound({ codecId: 'A_MPEG/L3' }))
    first.fill(0)
    expect(configOf(made(sound({ codecId: 'A_MPEG/L3' })))).toEqual(MP3_ESDS)
  })
})

/** ALAC's magic cookie, the 24 bytes that Matroska keeps as the CodecPrivate: what `alacConfig` holds after its full box header. */
function cookie(spec: { channels?: number; sampleRate?: number } = {}): Uint8Array {
  const out = new Uint8Array(alacConfig().subarray(12))
  const data = new DataView(out.buffer)
  if (spec.channels !== undefined) out[9] = spec.channels
  if (spec.sampleRate !== undefined) data.setUint32(20, spec.sampleRate)
  return out
}

describe('the entry of an ALAC sound', () => {
  it('is an alac entry with the cookie in a full box of version 0', () => {
    const entry = made(
      sound({ codecId: 'A_ALAC', codecPrivate: cookie(), samplingFrequency: 44100 }),
    )
    expect(cookie()).toHaveLength(24)
    expect(typeOf(entry)).toBe('alac')
    expect(names(entry)).toEqual(['alac'])
    expect(configOf(entry)).toEqual(alacConfig())
    expect(hex(configOf(entry).subarray(0, 16))).toBe(
      '00 00 00 24 61 6c 61 63 00 00 00 00 00 00 10 00',
    )
    expect(entry).toEqual(audioEntry('alac', { channels: 2, sampleRate: 44100 }, alacConfig()))
  })

  it("has the cookie's channels (byte 9) and rate (the u32 at 20), whatever the track says", () => {
    const entry = made(
      sound({
        codecId: 'A_ALAC',
        codecPrivate: cookie({ channels: 6, sampleRate: 96000 }),
        samplingFrequency: 44100,
        channels: 2,
      }),
    )
    expect(fields(entry)).toEqual({ channels: 6, sampleSize: 16, rate: 48000 })
  })

  it('keeps a cookie that is longer than 24 bytes, whole', () => {
    const longer = concat(cookie(), [1, 2, 3, 4])
    const entry = made(sound({ codecId: 'A_ALAC', codecPrivate: longer }))
    expect(configOf(entry)).toEqual(fullBox('alac', 0, 0, longer))
  })

  it('does not share its bytes with the CodecPrivate', () => {
    const track = sound({ codecId: 'A_ALAC', codecPrivate: cookie() })
    const entry = made(track)
    const before = new Uint8Array(entry)
    track.codecPrivate?.fill(0)
    expect(entry).toEqual(before)
  })

  it('is damaged without a cookie of 24 bytes, or with no channels or no rate in it', () => {
    for (const codecPrivate of [null, new Uint8Array(0), cookie().subarray(0, 23)]) {
      const error = refused('damaged', () =>
        matroskaSoundEntry(sound({ codecId: 'A_ALAC', codecPrivate }), null),
      )
      expect(error.message).toContain('ALAC')
    }
    refused('damaged', () =>
      matroskaSoundEntry(sound({ codecId: 'A_ALAC', codecPrivate: cookie({ channels: 0 }) }), null),
    )
    refused('damaged', () =>
      matroskaSoundEntry(
        sound({ codecId: 'A_ALAC', codecPrivate: cookie({ sampleRate: 0 }) }),
        null,
      ),
    )
  })
})

describe('the codecs that are refused', () => {
  it('is refused for MPEG audio layer 2, which an esds can not tell from MP3', () => {
    const error = refused('unsupported-codec', () =>
      matroskaSoundEntry(sound({ codecId: 'A_MPEG/L2' }), null),
    )
    expect(error.message).toContain('A_MPEG/L2')
    expect(error.message).toContain('layer 2')
    expect(error.message).toContain('MP3')
  })

  it.each([
    'A_MPEG/L1',
    'A_VORBIS',
    'A_PCM/INT/LIT',
    'A_PCM/INT/BIG',
    'A_PCM/FLOAT/IEEE',
    'A_DTS',
    'A_DTS/EXPRESS',
    'A_DTS/LOSSLESS',
    'A_TRUEHD',
    'A_MLP',
    'A_MS/ACM',
    'A_WAVPACK4',
    'A_TTA1',
    'A_REAL/28_8',
    'A_QUICKTIME/QDM2',
    'A_SOMETHING/ELSE',
    'S_TEXT/UTF8',
    '',
  ])('is refused for %s, with the CodecID in the sentence', (codecId) => {
    // A CodecPrivate and a frame change nothing: the codec is refused before either is read.
    const error = refused('unsupported-codec', () =>
      matroskaSoundEntry(sound({ codecId, codecPrivate: [1, 2, 3, 4] }), ac3Frame()),
    )
    expect(error.message).toContain(codecId)
  })

  it('is refused for a CodecID that only looks like a supported one', () => {
    for (const codecId of [
      'A_AC3/BSID9',
      'A_EAC3/X',
      'A_OPUS/2',
      'A_FLAC/OGG',
      'a_aac',
      'A_MPEG/L3/X',
    ]) {
      const error = refused('unsupported-codec', () =>
        matroskaSoundEntry(sound({ codecId, codecPrivate: [1, 2, 3, 4] }), ac3Frame()),
      )
      expect(error.message, codecId).toContain(codecId)
    }
  })

  it('is damaged for a track that has no Audio element', () => {
    const track: MatroskaTrack = {
      ...sound({ codecId: 'A_AAC', codecPrivate: [0x11, 0x90] }),
      audio: null,
    }
    const error = refused('damaged', () => matroskaSoundEntry(track, null))
    expect(error.message).toContain('Audio')
  })
})

describe('a CodecPrivate that is cut short', () => {
  /** Every prefix of a CodecPrivate is a track that is made or is `damaged`, and never anything else is thrown. */
  function everyPrefix(codecId: string, whole: Uint8Array): number {
    let count = 0
    for (let length = 0; length <= whole.length; length += 1) {
      const track = sound({ codecId, codecPrivate: whole.subarray(0, length) })
      try {
        const entry = matroskaSoundEntry(track, null)
        expect(entry.length).toBeGreaterThan(CHILDREN)
        count += 1
      } catch (error) {
        expect(error).toBeInstanceOf(Mp4Error)
        expect((error as Mp4Error).reason).toBe('damaged')
        expect((error as Mp4Error).message).toMatch(/^[a-z]/)
      }
    }
    return count
  }

  it('is made or damaged at every length, for each codec that reads it', () => {
    // The shortest that holds everything is the first that is made; shorter ones are damaged.
    expect(
      everyPrefix('A_OPUS', opusHead({ channels: 6, family: 1, after: [4, 2, 0, 4, 1, 2, 3, 5] })),
    ).toBe(1)
    expect(
      everyPrefix('A_FLAC', concat(fourcc('fLaC'), [0x00, 0, 0, 34], streamInfo(), VORBIS_COMMENT)),
    ).toBe(1 + VORBIS_COMMENT.length)
    expect(everyPrefix('A_ALAC', cookie())).toBe(1)
    // An AudioSpecificConfig is carried as it is, whatever its length: only the empty one is none, and A_AAC is damaged for it.
    expect(everyPrefix('A_AAC', Uint8Array.of(0x11, 0x90))).toBe(2)
  })
})
