import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import { bits, concat, fourcc, u32 } from '../testing/build.ts'
import { ac3Config, eac3Config, frameSamples, sampleRate } from './frameheaders.ts'
import type { MatroskaTrack } from './tracks.ts'

// What a sound frame says of itself (DESIGN.md §10.4, D45): how many samples its
// header holds, so that the frames of a laced block can be timed, and the
// configuration boxes of AC-3 and E-AC-3 that Matroska doesn't store but MP4
// needs. Every header is built bit by bit from the field layouts of the
// standards (RFC 6716 §3.1, ISO/IEC 11172-3 and 13818-3, ETSI TS 102 366, the
// FLAC format specification), and every expected box is written out as the bits
// of its layout, so that the reader is checked against what the standards say
// and not against what it was written to read.

type SoundTrack = Pick<MatroskaTrack, 'codecId' | 'codecPrivate' | 'audio'>

function track(codecId: string, codecPrivate: Uint8Array | null = null): SoundTrack {
  return { codecId, codecPrivate, audio: null }
}

/** Bytes as a view onto a longer array, which is how the reader gives them, so that a read that forgets where a view begins reads the wrong bytes. */
function view(bytes: Uint8Array | number[]): Uint8Array {
  const own = Uint8Array.from(bytes)
  return concat([9, 9, 9], own, [7, 7]).subarray(3, 3 + own.length)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

/** Bytes written as the bits of their layout, in groups that may be spaced (`'00 01000 000'`). */
function fromBits(layout: string): Uint8Array {
  const digits = layout.replace(/\s+/g, '')
  if (!/^[01]*$/.test(digits) || digits.length % 8 !== 0) {
    throw new RangeError(`'${layout}' is not a whole number of bytes of bits.`)
  }
  const out = new Uint8Array(digits.length / 8)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = parseInt(digits.slice(index * 8, index * 8 + 8), 2)
  }
  return out
}

/** A number as `width` bits. */
function binary(value: number, width: number): string {
  return value.toString(2).padStart(width, '0')
}

/** The error that a call throws, which must be a refusal of the reader as damaged; its sentence. */
function damagedMessage(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe('damaged')
    return (error as Mp4Error).message
  }
  throw new Error('expected the call to throw')
}

describe('frameSamples: Opus', () => {
  /** An Opus packet: the TOC byte (config, stereo flag, code) and the bytes after it. */
  function opus(config: number, code: number, rest: number[] = [], stereo = 0): Uint8Array {
    return view([(config << 3) | (stereo << 2) | code, ...rest])
  }

  it('reads the TOC of RFC 6716 §3.1', () => {
    // config 31 is 20 ms, and a code of 0 is 1 frame: 960 samples at 48 kHz.
    expect(frameSamples(track('A_OPUS'), opus(31, 0))).toBe(960)
    // config 3 is 60 ms, and a code of 1 is 2 frames.
    expect(frameSamples(track('A_OPUS'), opus(3, 1))).toBe(5760)
    // config 16 is 2.5 ms, and a code of 3 has M frames in its second byte's low 6 bits.
    expect(frameSamples(track('A_OPUS'), opus(16, 3, [3]))).toBe(360)
  })

  it('gives the frame size of every config, as RFC 6716 §3.1 tabulates them', () => {
    // Milliseconds per config: SILK 10, 20, 40, 60; hybrid 10, 20; CELT 2.5, 5, 10, 20.
    const milliseconds = [
      ...[0, 1, 2].flatMap(() => [10, 20, 40, 60]),
      ...[0, 1].flatMap(() => [10, 20]),
      ...[0, 1, 2, 3].flatMap(() => [2.5, 5, 10, 20]),
    ]
    expect(milliseconds).toHaveLength(32)
    milliseconds.forEach((ms, config) => {
      expect(frameSamples(track('A_OPUS'), opus(config, 0)), `config ${config}`).toBe(ms * 48)
    })
  })

  it('counts the frames of the codes 1 and 2 as 2, and ignores the stereo flag', () => {
    expect(frameSamples(track('A_OPUS'), opus(19, 2, [], 1))).toBe(2 * 960)
    expect(frameSamples(track('A_OPUS'), opus(19, 1, [], 1))).toBe(2 * 960)
    expect(frameSamples(track('A_OPUS'), opus(19, 0, [], 1))).toBe(960)
  })

  it('takes the frame count of code 3 from the low 6 bits of the second byte, and not its flags', () => {
    // The 0x80 bit says the frames are of variable bit rate and the 0x40 bit that there is padding.
    expect(frameSamples(track('A_OPUS'), opus(19, 3, [0xc2]))).toBe(2 * 960)
    expect(frameSamples(track('A_OPUS'), opus(16, 3, [0x80 | 0x40 | 48]))).toBe(48 * 120)
  })

  it('says null for the packets that RFC 6716 §3.2.5 forbids', () => {
    // M may not be 0, and a packet is at most 120 ms: 5760 samples.
    expect(frameSamples(track('A_OPUS'), opus(31, 3, [0]))).toBeNull()
    expect(frameSamples(track('A_OPUS'), opus(3, 3, [2]))).toBe(5760)
    expect(frameSamples(track('A_OPUS'), opus(3, 3, [3]))).toBeNull()
    expect(frameSamples(track('A_OPUS'), opus(16, 3, [48]))).toBe(5760)
    expect(frameSamples(track('A_OPUS'), opus(16, 3, [49]))).toBeNull()
    expect(frameSamples(track('A_OPUS'), opus(31, 3, [0x3f]))).toBeNull()
  })

  it('says null for a header that is cut short', () => {
    expect(frameSamples(track('A_OPUS'), new Uint8Array(0))).toBeNull()
    expect(frameSamples(track('A_OPUS'), opus(31, 3))).toBeNull()
  })
})

describe('frameSamples: AAC', () => {
  it('is 1024 for every AAC CodecID', () => {
    for (const id of ['A_AAC', 'A_AAC/MPEG4/LC', 'A_AAC/MPEG2/LC/SBR']) {
      expect(frameSamples(track(id), view([0x21, 0x10, 0x05]))).toBe(1024)
    }
  })
})

describe('frameSamples: MPEG audio', () => {
  /** An MPEG audio header: the 11-bit sync, the version and layer, the protection bit (1 is no CRC) and 2 bytes more. */
  function mpeg(version: number, layer: number, sync = 0x7ff): Uint8Array {
    return view([sync >> 3, ((sync & 7) << 5) | (version << 3) | (layer << 1) | 1, 0x90, 0x00])
  }

  it('is 1152 for MPEG-1 layer 3 and 576 for MPEG-2 and 2.5', () => {
    expect(frameSamples(track('A_MPEG/L3'), view([0xff, 0xfb, 0x90, 0x00]))).toBe(1152)
    expect(frameSamples(track('A_MPEG/L3'), mpeg(3, 1))).toBe(1152)
    expect(frameSamples(track('A_MPEG/L3'), mpeg(2, 1))).toBe(576)
    expect(frameSamples(track('A_MPEG/L3'), mpeg(0, 1))).toBe(576)
  })

  it('is 1152 for layer 2 and 384 for layer 1, in every version', () => {
    for (const version of [3, 2, 0]) {
      expect(frameSamples(track('A_MPEG/L2'), mpeg(version, 2))).toBe(1152)
      expect(frameSamples(track('A_MPEG/L1'), mpeg(version, 3))).toBe(384)
    }
  })

  it('says null for the reserved version and layer, and for a header without its sync', () => {
    expect(frameSamples(track('A_MPEG/L3'), mpeg(1, 1))).toBeNull()
    expect(frameSamples(track('A_MPEG/L3'), mpeg(3, 0))).toBeNull()
    expect(frameSamples(track('A_MPEG/L3'), mpeg(3, 1, 0x7fe))).toBeNull()
    expect(frameSamples(track('A_MPEG/L3'), view([0xfe, 0xfb, 0x90, 0x00]))).toBeNull()
  })

  it('says null for a header that is cut short', () => {
    expect(frameSamples(track('A_MPEG/L3'), new Uint8Array(0))).toBeNull()
    expect(frameSamples(track('A_MPEG/L3'), view([0xff, 0xfb, 0x90]))).toBeNull()
  })
})

describe('frameSamples: AC-3', () => {
  it('is 1536 for a frame that starts with the sync word', () => {
    expect(frameSamples(track('A_AC3'), view([0x0b, 0x77, 0, 0, 0x1c]))).toBe(1536)
  })

  it('says null without the sync word, or when it is cut short', () => {
    expect(frameSamples(track('A_AC3'), view([0x0b, 0x76, 0, 0]))).toBeNull()
    expect(frameSamples(track('A_AC3'), view([0x77, 0x0b, 0, 0]))).toBeNull()
    expect(frameSamples(track('A_AC3'), view([0x0b]))).toBeNull()
    expect(frameSamples(track('A_AC3'), new Uint8Array(0))).toBeNull()
  })
})

/** What an E-AC-3 syncframe is built from (ETSI TS 102 366 Annex E); each field is as the standard names it. */
interface Eac3Spec {
  sync?: number
  strmtyp?: number
  substreamid?: number
  frmsiz?: number
  fscod?: number
  /** numblkscod, or fscod2 when fscod is 3. */
  code2?: number
  acmod?: number
  lfeon?: number
  bsid?: number
  /** Written, with the flag that says so, only when given: compr, and compr2 for acmod 0. */
  compr?: number
  compr2?: number
  /** A dependent substream's channel map; written, with its flag, only when given. */
  chanmap?: number
  /** The bytes that the syncframe is cut or padded to when that isn't (frmsiz + 1) × 2. */
  length?: number
}

function eac3Syncframe(spec: Eac3Spec = {}): Uint8Array {
  const strmtyp = spec.strmtyp ?? 0
  const frmsiz = spec.frmsiz ?? 767
  const acmod = spec.acmod ?? 2
  const fields: [number, number][] = [
    [spec.sync ?? 0x0b77, 16],
    [strmtyp, 2],
    [spec.substreamid ?? 0, 3],
    [frmsiz, 11],
    [spec.fscod ?? 0, 2],
    [spec.code2 ?? 3, 2],
    [acmod, 3],
    [spec.lfeon ?? 0, 1],
    [spec.bsid ?? 16, 5],
    [27, 5], // dialnorm
  ]
  if (spec.compr === undefined) {
    fields.push([0, 1]) // compre
  } else {
    fields.push([1, 1], [spec.compr, 8])
  }
  if (acmod === 0) {
    fields.push([27, 5]) // dialnorm2
    if (spec.compr2 === undefined) {
      fields.push([0, 1]) // compr2e
    } else {
      fields.push([1, 1], [spec.compr2, 8])
    }
  }
  if (strmtyp === 1) {
    if (spec.chanmap === undefined) {
      fields.push([0, 1]) // chanmape
    } else {
      fields.push([1, 1], [spec.chanmap, 16])
    }
  }
  const out = new Uint8Array(spec.length ?? (frmsiz + 1) * 2)
  out.set(bits(...fields).slice(0, out.length))
  return out
}

describe('frameSamples: E-AC-3', () => {
  it('is 256 samples a block, by numblkscod', () => {
    for (const [code, blocks] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 6],
    ] as const) {
      const frame = view(eac3Syncframe({ fscod: 0, code2: code }))
      expect(frameSamples(track('A_EAC3'), frame), `numblkscod ${code}`).toBe(256 * blocks)
    }
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ code2: 3 })))).toBe(1536)
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ code2: 0 })))).toBe(256)
  })

  it('is 6 blocks when fscod is 3, whose next 2 bits are fscod2 and not numblkscod', () => {
    for (const fscod2 of [0, 1, 2]) {
      const frame = view(eac3Syncframe({ fscod: 3, code2: fscod2 }))
      expect(frameSamples(track('A_EAC3'), frame), `fscod2 ${fscod2}`).toBe(1536)
    }
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ fscod: 3, code2: 3 })))).toBeNull()
  })

  it('reads the first syncframe of a frame that holds more', () => {
    const frame = concat(
      eac3Syncframe({ frmsiz: 9, code2: 1 }),
      eac3Syncframe({ strmtyp: 1, frmsiz: 9, code2: 2 }),
    )
    expect(frameSamples(track('A_EAC3'), view(frame))).toBe(512)
  })

  it('says null without the sync word, for a frame that is AC-3 in shape, and when it is cut short', () => {
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ sync: 0x0b76 })))).toBeNull()
    // The bitstream ID of E-AC-3 is 11 to 16, and an AC-3 frame's 8 is in the same bits.
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ bsid: 8 })))).toBeNull()
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ bsid: 10 })))).toBeNull()
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ bsid: 11 })))).toBe(1536)
    expect(frameSamples(track('A_EAC3'), view(eac3Syncframe({ bsid: 17 })))).toBeNull()
    const frame = eac3Syncframe()
    expect(frameSamples(track('A_EAC3'), view(frame.subarray(0, 6)))).toBe(1536)
    expect(frameSamples(track('A_EAC3'), view(frame.subarray(0, 5)))).toBeNull()
    expect(frameSamples(track('A_EAC3'), new Uint8Array(0))).toBeNull()
  })
})

describe('frameSamples: FLAC', () => {
  /**
   * A FLAC frame header (the FLAC format specification, "Frame header"): the
   * 14-bit sync, a reserved 0 and the blocking strategy, the block size code
   * and the sample rate code, the channel assignment and sample size, the
   * UTF-8 coded number, then `after` (the block size that code 6 and 7 write
   * after it, and the CRC-8).
   */
  function flac(code: number, number: number[] = [0x00], after: number[] = [0x00], variable = 0) {
    return view([0xff, 0xf8 | variable, (code << 4) | 0x9, 0x18, ...number, ...after])
  }

  it('is the block size that the 4-bit code stands for', () => {
    const sizes: Record<number, number> = {
      1: 192,
      2: 576,
      3: 1152,
      4: 2304,
      5: 4608,
      8: 256,
      9: 512,
      10: 1024,
      11: 2048,
      12: 4096,
      13: 8192,
      14: 16384,
      15: 32768,
    }
    for (const [code, size] of Object.entries(sizes)) {
      expect(frameSamples(track('A_FLAC'), flac(Number(code))), `code ${code}`).toBe(size)
    }
    expect(frameSamples(track('A_FLAC'), flac(12))).toBe(4096)
    expect(frameSamples(track('A_FLAC'), flac(1))).toBe(192)
  })

  it('is the 8-bit value plus 1 for code 6, and the 16-bit value plus 1 for code 7, after the number', () => {
    // The number is 2 UTF-8 bytes here, so a reader that takes it for 1 reads 0x80.
    expect(frameSamples(track('A_FLAC'), flac(6, [0xc2, 0x80], [191, 0x00]))).toBe(192)
    expect(frameSamples(track('A_FLAC'), flac(6, [0x00], [0xff, 0x00]))).toBe(256)
    expect(frameSamples(track('A_FLAC'), flac(7, [0xc2, 0x80], [0x0f, 0xff, 0x00]))).toBe(4096)
    expect(frameSamples(track('A_FLAC'), flac(7, [0x00], [0xff, 0xff, 0x00]))).toBe(65536)
  })

  it('walks a UTF-8 number of every length, up to the 7 bytes of a sample number', () => {
    for (let length = 1; length <= 7; length += 1) {
      const lead = length === 1 ? 0x00 : (0xff00 >> length) & 0xff
      const number = [lead, ...new Array<number>(length - 1).fill(0x80)]
      expect(frameSamples(track('A_FLAC'), flac(6, number, [99, 0x00], 1)), `${length} bytes`).toBe(
        100,
      )
    }
  })

  it('takes a frame of variable block size, whose sync is 0xFFF9, as well', () => {
    expect(frameSamples(track('A_FLAC'), flac(12, [0x00], [0x00], 1))).toBe(4096)
  })

  it('says null for the reserved block size code, and for a header that is no FLAC frame', () => {
    expect(frameSamples(track('A_FLAC'), flac(0))).toBeNull()
    expect(frameSamples(track('A_FLAC'), view([0xff, 0xfa, 0xc9, 0x18, 0x00, 0x00]))).toBeNull() // the reserved bit is 1
    expect(frameSamples(track('A_FLAC'), view([0xff, 0xf0, 0xc9, 0x18, 0x00, 0x00]))).toBeNull()
    expect(frameSamples(track('A_FLAC'), view([0xfe, 0xf8, 0xc9, 0x18, 0x00, 0x00]))).toBeNull()
    // A continuation byte or 0xFF can't lead a number, and the bytes after a lead are 10xxxxxx.
    expect(frameSamples(track('A_FLAC'), flac(6, [0x80], [191, 0x00]))).toBeNull()
    expect(frameSamples(track('A_FLAC'), flac(6, [0xff], [191, 0x00]))).toBeNull()
    expect(frameSamples(track('A_FLAC'), flac(6, [0xc2, 0x40], [191, 0x00]))).toBeNull()
  })

  it('says null for a header that is cut short, whichever part it ends in', () => {
    expect(frameSamples(track('A_FLAC'), new Uint8Array(0))).toBeNull()
    expect(frameSamples(track('A_FLAC'), view([0xff]))).toBeNull()
    expect(frameSamples(track('A_FLAC'), view([0xff, 0xf8, 0xc9]))).toBeNull()
    // Code 6 and 7 need the number and what is after it.
    expect(frameSamples(track('A_FLAC'), flac(6, [0xc2, 0x80], []))).toBeNull()
    expect(frameSamples(track('A_FLAC'), flac(7, [0xc2, 0x80], [0x0f]))).toBeNull()
    expect(frameSamples(track('A_FLAC'), flac(6, [0xc2], []))).toBeNull()
    expect(frameSamples(track('A_FLAC'), flac(6, [], []))).toBeNull()
  })
})

describe('frameSamples: ALAC', () => {
  /** An ALAC cookie (the 24 bytes of ALACSpecificConfig): frameLength, then the rest of it. */
  function cookie(frameLength: number): Uint8Array {
    const out = new Uint8Array(24)
    new DataView(out.buffer).setUint32(0, frameLength)
    out[5] = 16 // bitDepth
    out[9] = 2 // numChannels
    return view(out)
  }

  it('is the frameLength at the start of the cookie', () => {
    expect(frameSamples(track('A_ALAC', cookie(4096)), view([1, 2, 3]))).toBe(4096)
    expect(frameSamples(track('A_ALAC', cookie(0x01020304)), view([1, 2, 3]))).toBe(0x01020304)
    expect(frameSamples(track('A_ALAC', view([0, 0, 16, 0])), view([1]))).toBe(4096)
  })

  it('says null without a cookie of 4 bytes, or with a frameLength of 0', () => {
    expect(frameSamples(track('A_ALAC'), view([1, 2, 3]))).toBeNull()
    expect(frameSamples(track('A_ALAC', view([0, 0, 16])), view([1, 2, 3]))).toBeNull()
    expect(frameSamples(track('A_ALAC', cookie(0)), view([1, 2, 3]))).toBeNull()
  })
})

describe('frameSamples: other codecs', () => {
  it('says null for a CodecID that has no header that says', () => {
    for (const id of ['A_VORBIS', 'A_TRUEHD', 'A_PCM/INT/LIT', 'A_DTS', 'V_VP9', '']) {
      expect(frameSamples(track(id), view([0x0b, 0x77, 0xff, 0xf8, 0x00])), id).toBeNull()
    }
  })

  it('never throws, for any CodecID on any prefix of any frame', () => {
    const frames = [
      eac3Syncframe({ frmsiz: 20 }),
      eac3Syncframe({ strmtyp: 1, frmsiz: 20, chanmap: 0x0400 }),
      Uint8Array.from([0xff, 0xf9, 0xc9, 0x18, 0xc2, 0x80, 0xbf, 0x00]),
      Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 0x00]),
      Uint8Array.from([0x0b, 0x77, 0x00, 0x00, 0x1c, 0x40]),
      Uint8Array.from([0xfb, 0x3f, 0x00]),
    ]
    const ids = ['A_OPUS', 'A_AAC', 'A_MPEG/L3', 'A_AC3', 'A_EAC3', 'A_FLAC', 'A_ALAC', 'A_X']
    for (const frame of frames) {
      for (let length = 0; length <= frame.length; length += 1) {
        for (const id of ids) {
          const samples = frameSamples(track(id), view(frame.subarray(0, length)))
          expect(samples === null || Number.isInteger(samples)).toBe(true)
        }
      }
    }
  })
})

describe('sampleRate', () => {
  const audio = {
    samplingFrequency: 24000,
    outputSamplingFrequency: 48000,
    channels: 2,
    bitDepth: null,
  }

  it('is 48000 for Opus, whatever the track says', () => {
    expect(sampleRate({ codecId: 'A_OPUS', audio: null })).toBe(48000)
    expect(sampleRate({ codecId: 'A_OPUS', audio: { ...audio, samplingFrequency: 16000 } })).toBe(
      48000,
    )
  })

  it('is the SamplingFrequency otherwise, which for HE-AAC is the core rate', () => {
    expect(sampleRate({ codecId: 'A_AAC/MPEG4/LC/SBR', audio })).toBe(24000)
    expect(sampleRate({ codecId: 'A_FLAC', audio: { ...audio, samplingFrequency: 44100 } })).toBe(
      44100,
    )
  })

  it('is the 8000 that Matroska gives a sound with no Audio element', () => {
    expect(sampleRate({ codecId: 'A_AAC', audio: null })).toBe(8000)
  })
})

/** The syncinfo and BSI of an AC-3 frame (ETSI TS 102 366, clause 4), each field as the standard names it, and the bits after them 0. */
interface Ac3Spec {
  sync?: number
  fscod?: number
  frmsizecod?: number
  bsid?: number
  bsmod?: number
  acmod?: number
  lfeon?: number
}

/** The bits that acmod 0 to 7 skip before lfeon: cmixlev for acmod 3, 5 and 7, surmixlev for 4 to 7 and dsurmod for 2; 2 bits each. */
const SKIPPED = [0, 0, 2, 2, 2, 4, 2, 4]

function ac3Frame(spec: Ac3Spec = {}): Uint8Array {
  const acmod = spec.acmod ?? 7
  return view(
    bits(
      [spec.sync ?? 0x0b77, 16],
      [0, 16], // crc1
      [spec.fscod ?? 0, 2],
      [spec.frmsizecod ?? 0x1c, 6],
      [spec.bsid ?? 8, 5],
      [spec.bsmod ?? 0, 3],
      [acmod, 3],
      [0, SKIPPED[acmod] ?? 0], // the mix levels
      [spec.lfeon ?? 1, 1],
      [0, 32],
    ),
  )
}

/** The `dac3` box that has this body, written as its bits. */
function dac3Box(layout: string): Uint8Array {
  const body = fromBits(layout)
  return concat(u32(8 + body.length), fourcc('dac3'), body)
}

describe('ac3Config', () => {
  it('gives the dac3 box of fscod 0, frmsizecod 0x1C, bsid 8, bsmod 0, acmod 7 and lfeon 1', () => {
    expect(hex(ac3Config(ac3Frame()))).toBe('00 00 00 0b 64 61 63 33 10 3d c0')
  })

  it('reads lfeon after the dsurmod that acmod 2 has', () => {
    // fscod 1, bsid 6, bsmod 0, acmod 2, lfeon 1, bit_rate_code 10 (frmsizecod 20), reserved.
    const stereo = ac3Frame({ fscod: 1, frmsizecod: 20, bsid: 6, acmod: 2, lfeon: 1 })
    expect(hex(ac3Config(stereo))).toBe(hex(dac3Box('01 00110 000 010 1 01010 00000')))
  })

  it('reads lfeon after the mix levels of every acmod, which the frame has 0 in, and 0 after lfeon', () => {
    // A wrong skip reads a bit of 0, and so reads lfeon as 0, or acmod's neighbour.
    for (let acmod = 0; acmod < 8; acmod += 1) {
      for (const lfeon of [0, 1]) {
        const box = ac3Config(ac3Frame({ acmod, lfeon }))
        const expected = dac3Box(`00 01000 000 ${binary(acmod, 3)} ${lfeon} 01110 00000`)
        expect(hex(box), `acmod ${acmod}, lfeon ${lfeon}`).toBe(hex(expected))
      }
    }
  })

  it('writes the bit rate code as frmsizecod >> 1, and fscod, bsid and bsmod as they are', () => {
    const frame = ac3Frame({ fscod: 2, frmsizecod: 37, bsid: 10, bsmod: 5, acmod: 1 })
    expect(hex(ac3Config(frame))).toBe(hex(dac3Box('10 01010 101 001 1 10010 00000')))
  })

  it('gives the box whole and new, from a frame that is a view onto more bytes', () => {
    const box = ac3Config(ac3Frame())
    expect(box).toHaveLength(11)
    expect(box.byteOffset).toBe(0)
    expect(box.buffer.byteLength).toBe(11)
  })

  it('is damaged for a frame that is not an AC-3 frame', () => {
    expect(damagedMessage(() => ac3Config(ac3Frame({ sync: 0x0b76 })))).toContain('0x0B77')
    expect(damagedMessage(() => ac3Config(new Uint8Array(0)))).toContain('0x0B77')
    expect(damagedMessage(() => ac3Config(ac3Frame({ fscod: 3 })))).toContain('sampling rate code')
    expect(damagedMessage(() => ac3Config(ac3Frame({ frmsizecod: 38 })))).toContain(
      'size code is 38',
    )
    expect(damagedMessage(() => ac3Config(ac3Frame({ frmsizecod: 63 })))).toContain(
      'size code is 63',
    )
    // A bitstream ID of 11 and over is E-AC-3's.
    expect(damagedMessage(() => ac3Config(ac3Frame({ bsid: 11 })))).toContain('only E-AC-3')
    expect(damagedMessage(() => ac3Config(ac3Frame({ bsid: 16 })))).toContain('only E-AC-3')
    // The most that AC-3 has of each are fine.
    expect(ac3Config(ac3Frame({ bsid: 10, frmsizecod: 37, fscod: 2 }))).toHaveLength(11)
  })

  it('is damaged for a frame that is cut short, wherever it ends', () => {
    const frame = ac3Frame({ acmod: 7 })
    // The header is 16 + 16 + 2 + 6 + 5 + 3 + 3 + 4 + 1 = 56 bits: 7 bytes.
    for (let length = 2; length < 7; length += 1) {
      expect(
        damagedMessage(() => ac3Config(frame.subarray(0, length))),
        `${length} bytes`,
      ).toContain('cut short')
    }
    expect(ac3Config(frame.subarray(0, 7))).toHaveLength(11)
  })
})

/** The 16 bits that a `dec3` box starts with: the data rate and the number of independent substreams less 1. */
function dec3Head(kilobitsPerSecond: number, independent: number): string {
  return `${binary(kilobitsPerSecond, 13)} ${binary(independent - 1, 3)}`
}

/** One independent substream of a `dec3` box as its bits (ETSI TS 102 366 Annex F), with bsmod and asvc 0, as ffmpeg writes E-AC-3. */
function dec3Entry(
  fscod: number,
  acmod: number,
  lfeon: number,
  dependents = 0,
  location = 0,
  bsid = 16,
): string {
  return [
    binary(fscod, 2),
    binary(bsid, 5),
    '0', // reserved
    '0', // asvc
    '000', // bsmod
    binary(acmod, 3),
    String(lfeon),
    '000', // reserved
    binary(dependents, 4),
    dependents > 0 ? binary(location, 9) : '0',
  ].join(' ')
}

/** The `dec3` box that has this body, written as its bits. */
function dec3Box(...layout: string[]): Uint8Array {
  const body = fromBits(layout.join(' '))
  return concat(u32(8 + body.length), fourcc('dec3'), body)
}

describe('eac3Config', () => {
  it('gives the dec3 box of strmtyp 0, 1536 bytes, fscod 0, numblkscod 3, acmod 2, lfeon 0 and bsid 16', () => {
    const frame = view(
      eac3Syncframe({ frmsiz: 767, fscod: 0, code2: 3, acmod: 2, lfeon: 0, bsid: 16 }),
    )
    expect(frame).toHaveLength(1536)
    expect(hex(eac3Config(frame))).toBe('00 00 00 0d 64 65 63 33 0c 00 20 04 00')
  })

  it('writes the data rate of the first syncframe, rounded down', () => {
    // 200 bytes of 6 blocks at 44100 Hz: 200 × 8 × 44100 ÷ 1536 ÷ 1000 = 45.9375 kbit/s.
    const six = eac3Config(view(eac3Syncframe({ frmsiz: 99, fscod: 1 })))
    expect(hex(six)).toBe(hex(dec3Box(dec3Head(45, 1), dec3Entry(1, 2, 0))))
    // The same frame of 1 block: 200 × 8 × 44100 ÷ 256 ÷ 1000 = 275.625.
    const one = eac3Config(view(eac3Syncframe({ frmsiz: 99, fscod: 1, code2: 0 })))
    expect(hex(one)).toBe(hex(dec3Box(dec3Head(275, 1), dec3Entry(1, 2, 0))))
    // fscod 3 with fscod2 0 is 24000 Hz, and has 6 blocks: 768 bytes is 96 kbit/s. Its fscod is written as it is.
    const reduced = eac3Config(view(eac3Syncframe({ frmsiz: 383, fscod: 3, code2: 0 })))
    expect(hex(reduced)).toBe(hex(dec3Box(dec3Head(96, 1), dec3Entry(3, 2, 0))))
  })

  it('writes the rate of 22050 and of 16000 Hz of fscod2 1 and 2', () => {
    // 600 bytes of 6 blocks: 600 × 8 × 22050 ÷ 1536 ÷ 1000 = 68.9 and 600 × 8 × 16000 ÷ 1536 ÷ 1000 = 50.
    const second = eac3Config(view(eac3Syncframe({ frmsiz: 299, fscod: 3, code2: 1 })))
    expect(hex(second)).toBe(hex(dec3Box(dec3Head(68, 1), dec3Entry(3, 2, 0))))
    const third = eac3Config(view(eac3Syncframe({ frmsiz: 299, fscod: 3, code2: 2 })))
    expect(hex(third)).toBe(hex(dec3Box(dec3Head(50, 1), dec3Entry(3, 2, 0))))
  })

  it('writes fscod, bsid, acmod and lfeon of the substream', () => {
    const frame = view(eac3Syncframe({ fscod: 2, acmod: 7, lfeon: 1, bsid: 12 }))
    expect(hex(eac3Config(frame))).toBe(
      // 1536 bytes of 6 blocks at 32000 Hz is 256 kbit/s.
      hex(dec3Box(dec3Head(256, 1), dec3Entry(2, 7, 1, 0, 0, 12))),
    )
  })

  it('counts each independent substream and writes an entry for it', () => {
    const frame = view(
      concat(
        eac3Syncframe({ substreamid: 0, frmsiz: 99, acmod: 7, lfeon: 1 }),
        eac3Syncframe({ strmtyp: 2, substreamid: 1, frmsiz: 49, fscod: 1, acmod: 1 }),
      ),
    )
    // 200 bytes of 6 blocks at 48000 Hz is 50 kbit/s; num_ind_sub is 1.
    expect(hex(eac3Config(frame))).toBe(
      hex(dec3Box(dec3Head(50, 2), dec3Entry(0, 7, 1), dec3Entry(1, 1, 0))),
    )
    expect(hex(eac3Config(frame))).toBe('00 00 00 10 64 65 63 33 01 91 20 0f 00 60 02 00')
  })

  it('adds the dependent substreams that follow an independent one, and their chan_loc', () => {
    // The chanmap of a dependent substream names Lc/Rc by its 6th bit from the top (ETSI TS 102 366, Annex E).
    const frame = view(
      concat(
        eac3Syncframe({ frmsiz: 767, acmod: 7, lfeon: 1 }),
        eac3Syncframe({ strmtyp: 1, substreamid: 0, frmsiz: 99, acmod: 2, chanmap: 0x0400 }),
      ),
    )
    // The data rate is the first syncframe's: 384. chan_loc has Lc/Rc as its first bit.
    expect(hex(eac3Config(frame))).toBe(
      hex(dec3Box(dec3Head(384, 1), dec3Entry(0, 7, 1, 1, 0b100000000))),
    )
    expect(hex(eac3Config(frame))).toBe('00 00 00 0e 64 65 63 33 0c 00 20 0f 03 00')
  })

  it('ORs the chan_loc of every dependent substream, and reads a chanmap past the fields of acmod 0', () => {
    const frame = view(
      concat(
        eac3Syncframe({ frmsiz: 767 }),
        // Lrs/Rrs, the 7th bit from the top: 0x0200 → chan_loc 0x080.
        eac3Syncframe({ strmtyp: 1, frmsiz: 49, chanmap: 0x0200 }),
        // acmod 0 has dialnorm2 and compr2e, and compr and compr2 are given: Cs and Ts, 0x0100 and 0x0080 → 0x040 and 0x020.
        eac3Syncframe({
          strmtyp: 1,
          substreamid: 1,
          frmsiz: 49,
          acmod: 0,
          compr: 0xaa,
          compr2: 0x55,
          chanmap: 0x0180,
        }),
      ),
    )
    expect(hex(eac3Config(frame))).toBe(
      hex(dec3Box(dec3Head(384, 1), dec3Entry(0, 2, 0, 2, 0b011100000))),
    )
    expect(hex(eac3Config(frame))).toBe('00 00 00 0e 64 65 63 33 0c 00 20 04 04 e0')
  })

  it('gives a dependent substream with no chanmap no channel locations', () => {
    const frame = view(
      concat(eac3Syncframe({ frmsiz: 767 }), eac3Syncframe({ strmtyp: 1, frmsiz: 49 })),
    )
    expect(hex(eac3Config(frame))).toBe(hex(dec3Box(dec3Head(384, 1), dec3Entry(0, 2, 0, 1, 0))))
  })

  it('gives each independent substream the dependent substreams that follow it', () => {
    const frame = view(
      concat(
        eac3Syncframe({ frmsiz: 767, acmod: 7 }),
        eac3Syncframe({ strmtyp: 1, frmsiz: 49, chanmap: 0x0400 }),
        eac3Syncframe({ substreamid: 1, frmsiz: 49, acmod: 1 }),
      ),
    )
    expect(hex(eac3Config(frame))).toBe(
      hex(dec3Box(dec3Head(384, 2), dec3Entry(0, 7, 0, 1, 0b100000000), dec3Entry(0, 1, 0))),
    )
  })

  it('takes the next syncframes of a substream it has seen for the rest of its blocks, and not for substreams', () => {
    // numblkscod 1 is 2 blocks, so an access unit of 6 is 3 syncframes of the substream and 3 of its dependent one.
    const unit = [
      eac3Syncframe({ frmsiz: 99, code2: 1, acmod: 7, lfeon: 1 }),
      eac3Syncframe({ strmtyp: 1, frmsiz: 49, code2: 1, chanmap: 0x0400 }),
    ]
    // 200 bytes of 2 blocks at 48000 Hz: 200 × 8 × 48000 ÷ 512 ÷ 1000 = 150 kbit/s.
    const expected = hex(dec3Box(dec3Head(150, 1), dec3Entry(0, 7, 1, 1, 0b100000000)))
    expect(hex(eac3Config(view(concat(...unit))))).toBe(expected)
    expect(hex(eac3Config(view(concat(...unit, ...unit, ...unit))))).toBe(expected)
  })

  it('stops at the second syncframe of a substream even when what follows it is no syncframe', () => {
    const frame = view(
      concat(eac3Syncframe({ frmsiz: 49 }), eac3Syncframe({ frmsiz: 49 }), [1, 2, 3]),
    )
    expect(eac3Config(frame)).toHaveLength(13)
  })

  it('is damaged for a frame that is not E-AC-3', () => {
    expect(damagedMessage(() => eac3Config(view(eac3Syncframe({ sync: 0x0b76 }))))).toContain(
      '0x0B77',
    )
    expect(damagedMessage(() => eac3Config(new Uint8Array(0)))).toContain('0x0B77')
    expect(damagedMessage(() => eac3Config(view(eac3Syncframe({ strmtyp: 3 }))))).toContain(
      'stream type 3',
    )
    expect(damagedMessage(() => eac3Config(view(eac3Syncframe({ fscod: 3, code2: 3 }))))).toContain(
      'fscod2 3',
    )
    // The bitstream ID of E-AC-3 is 11 to 16.
    expect(damagedMessage(() => eac3Config(view(eac3Syncframe({ bsid: 8 }))))).toContain(
      'bitstream ID 8',
    )
    expect(damagedMessage(() => eac3Config(view(eac3Syncframe({ bsid: 10 }))))).toContain(
      'bitstream ID 10',
    )
    expect(damagedMessage(() => eac3Config(view(eac3Syncframe({ bsid: 17 }))))).toContain(
      'bitstream ID 17',
    )
    expect(eac3Config(view(eac3Syncframe({ bsid: 11 })))).toHaveLength(13)
  })

  it('is damaged for a frame whose first substream is a dependent one', () => {
    const frame = view(eac3Syncframe({ strmtyp: 1, chanmap: 0x0400 }))
    expect(damagedMessage(() => eac3Config(frame))).toContain('dependent substream')
  })

  it('is damaged for more dependent substreams than the 4 bits of num_dep_sub count', () => {
    const dependent = eac3Syncframe({ strmtyp: 1, frmsiz: 3 })
    const independent = eac3Syncframe({ frmsiz: 3 })
    const fifteen = view(concat(independent, ...new Array<Uint8Array>(15).fill(dependent)))
    expect(eac3Config(fifteen)).toHaveLength(8 + 2 + 4)
    const sixteen = view(concat(independent, ...new Array<Uint8Array>(16).fill(dependent)))
    expect(damagedMessage(() => eac3Config(sixteen))).toContain('15')
  })

  it('is damaged for a syncframe that runs past the frame, and for bytes after one that are no syncframe', () => {
    const whole = eac3Syncframe({ frmsiz: 99 })
    expect(damagedMessage(() => eac3Config(view(whole.subarray(0, 199))))).toContain('cut short')
    const next = eac3Syncframe({ strmtyp: 1, frmsiz: 9 })
    expect(damagedMessage(() => eac3Config(view(concat(whole, next.subarray(0, 19)))))).toContain(
      'byte 200',
    )
    expect(
      damagedMessage(() => eac3Config(view(concat(whole, eac3Syncframe({ sync: 0x1234 }))))),
    ).toContain('byte 200')
    expect(damagedMessage(() => eac3Config(view(concat(whole, [0x0b]))))).toContain('byte 200')
  })

  it('says that a header is cut short when the frame ends in it', () => {
    // The header of this syncframe is 51 bits: 7 bytes. A frame of 1 byte has no sync word to speak of.
    const syncframe = eac3Syncframe({ frmsiz: 99 })
    for (let length = 2; length < 7; length += 1) {
      expect(
        damagedMessage(() => eac3Config(view(syncframe.subarray(0, length)))),
        `${length} bytes`,
      ).toContain('ends before its header does')
    }
    expect(damagedMessage(() => eac3Config(view(syncframe.subarray(0, 1))))).toContain('0x0B77')
  })

  it('is damaged for a syncframe that is shorter than its own header', () => {
    // 6 bytes by frmsiz, and the header is 51 bits.
    const frame = view(eac3Syncframe({ frmsiz: 2, length: 20 }))
    expect(damagedMessage(() => eac3Config(frame))).toContain('header')
  })

  it('is damaged and nothing else for a frame cut at any byte', () => {
    const frame = concat(
      eac3Syncframe({ frmsiz: 24, acmod: 7 }),
      eac3Syncframe({ strmtyp: 1, frmsiz: 24, acmod: 0, compr: 1, compr2: 2, chanmap: 0x0600 }),
      eac3Syncframe({ strmtyp: 2, substreamid: 2, frmsiz: 24, fscod: 3, code2: 1 }),
    )
    expect(frame).toHaveLength(150)
    expect(eac3Config(view(frame))).toHaveLength(8 + 2 + 4 + 3)
    for (let length = 0; length < frame.length; length += 1) {
      // A cut at the end of a syncframe leaves a frame that is whole.
      if (length === 50 || length === 100) continue
      damagedMessage(() => eac3Config(view(frame.subarray(0, length))))
    }
  })
})

describe('what the readers do with bytes of any kind', () => {
  it('give a number or null, a box or damaged, and never another error', () => {
    // A generator of bytes that is fixed, so that a failure is the same on every run.
    let state = 12345
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0
      return state >>> 24
    }
    const ids = ['A_OPUS', 'A_AAC', 'A_MPEG/L3', 'A_AC3', 'A_EAC3', 'A_FLAC', 'A_ALAC']
    for (let round = 0; round < 3000; round += 1) {
      const frame = Uint8Array.from({ length: next() % 40 }, next)
      // Half the rounds start as a header of the kind, so that the walks go further than the sync word.
      if (round % 2 === 0 && frame.length > 8) frame.set([0x0b, 0x77], 0)
      for (const id of ids) {
        const samples = frameSamples(track(id, frame), view(frame))
        expect(samples === null || Number.isInteger(samples)).toBe(true)
      }
      for (const read of [ac3Config, eac3Config]) {
        try {
          expect(read(view(frame)).length).toBeGreaterThan(8)
        } catch (error) {
          expect(error).toBeInstanceOf(Mp4Error)
          expect((error as Mp4Error).reason).toBe('damaged')
        }
      }
    }
  })
})
