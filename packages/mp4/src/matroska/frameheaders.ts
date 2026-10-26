import { Mp4Error } from '../errors.ts'
import type { MatroskaTrack } from './tracks.ts'

// What a sound frame says of itself (DESIGN.md §10.4, D45). Matroska keeps a
// frame's duration in its block only when the writer gave one, and a laced block
// holds several frames that share one timestamp, so the reader times such frames
// by the samples each header says it holds (`frameSamples`, at the rate that
// `sampleRate` names). AC-3 and E-AC-3 are the two codecs whose MP4 entry has a
// configuration box (`dac3`, `dec3`) that Matroska doesn't store at all: it is
// made from the header of the track's first frame (`ac3Config`, `eac3Config`),
// as ffmpeg's movenc makes it, and `codecNames` reads it back by its type alone.
//
// `frameSamples` never throws: a header that is cut short, or that is none of the
// codec's, says nothing, which is null. The two configurations are asked for only
// of a frame that must be one, and refuse (`damaged`) a frame that isn't; their
// sentences read after "The sound track can't be played: " (see `choose.ts`), so
// each begins in lowercase and says what the frame is.

/** What these readers need of a track: its CodecID, its CodecPrivate (ALAC's cookie is the only one that is read) and its Audio element. */
type SoundTrack = Pick<MatroskaTrack, 'codecId' | 'codecPrivate' | 'audio'>

/** The rate of an Opus stream whatever its OpusHead says (RFC 7845 §5.1): its packets are counted in 48 kHz samples. */
const OPUS_RATE = 48000

/** What a sound's frequency is when the file has no Audio element, as RFC 9559 has it. */
const DEFAULT_SAMPLING_FREQUENCY = 8000

/** The samples in one frame of each size a config of Opus has (RFC 6716 §3.1): SILK-only, configs 0 to 11, has frames of 10, 20, 40 and 60 ms; hybrid, 12 to 15, of 10 and 20 ms; CELT-only, 16 to 31, of 2.5, 5, 10 and 20 ms; at 48 kHz. */
const OPUS_SILK_FRAMES: readonly number[] = [480, 960, 1920, 2880]
const OPUS_HYBRID_FRAMES: readonly number[] = [480, 960]
const OPUS_CELT_FRAMES: readonly number[] = [120, 240, 480, 960]

/** The most that an Opus packet holds, 120 ms (RFC 6716 §3.2.5), in samples at 48 kHz. */
const OPUS_MAX_SAMPLES = 5760

/** The samples in a frame of AAC (ISO/IEC 14496-3), and in one of AC-3: 6 blocks of 256. */
const AAC_SAMPLES = 1024
const AC3_SAMPLES = 1536

/** The sync word that starts every AC-3 and E-AC-3 syncframe (ETSI TS 102 366, clause 4 and Annex E). */
const SYNC_WORD = 0x0b77

/** The most that AC-3's frmsizecod is (ETSI TS 102 366, clause 4), and the split of the bitstream ID between the two codecs, which ffmpeg's parser makes as well: AC-3's is 10 or less, E-AC-3's is 11 to 16. */
const AC3_MAX_FRMSIZECOD = 37
const AC3_MAX_BSID = 10
const EAC3_MIN_BSID = 11
const EAC3_MAX_BSID = 16

/** The audio blocks of an E-AC-3 syncframe by numblkscod, and its sampling rate by fscod. A syncframe whose fscod is 3 has 6 blocks, and fscod2 names its rate. */
const EAC3_BLOCKS: readonly number[] = [1, 2, 3, 6]
const EAC3_RATES: readonly number[] = [48000, 44100, 32000]
const EAC3_REDUCED_RATES: readonly number[] = [24000, 22050, 16000]

/** The samples in an audio block of E-AC-3 (and in one of AC-3). */
const EAC3_BLOCK_SAMPLES = 256

/** The most dependent substreams a `dec3` entry counts, as it has 4 bits for them (ETSI TS 102 366, Annex F). */
const MAX_DEPENDENTS = 15

/** The bytes of a box header. */
const BOX_HEADER = 8

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** A field of bits: its value and the number of bits it takes. */
type Field = readonly [value: number, width: number]

/** The fields as bytes, the first field's high bit first and the unused low bits of the last byte 0. */
function pack(fields: readonly Field[]): Uint8Array {
  const total = fields.reduce((sum, [, width]) => sum + width, 0)
  const out = new Uint8Array(Math.ceil(total / 8))
  let position = 0
  for (const [value, width] of fields) {
    for (let shift = width - 1; shift >= 0; shift -= 1) {
      if (Math.floor(value / 2 ** shift) % 2 === 1) {
        out[position >> 3] = (out[position >> 3] ?? 0) | (0x80 >> (position & 7))
      }
      position += 1
    }
  }
  return out
}

/** A box of this type around the bytes, which are copied. */
function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(BOX_HEADER + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(body, BOX_HEADER)
  return out
}

/** A reader of the bits of a frame, the high bit of each byte first. */
interface Bits {
  /** The next `count` bits as a number; each past the end of the bytes is a 0. */
  read(count: number): number
  /** Whether a read went past the end of the bytes: the frame is cut short. */
  cutShort(): boolean
  /** The bytes that the bits read so far take, a part of a byte as a whole one. */
  bytesRead(): number
}

function bitReader(bytes: Uint8Array): Bits {
  let position = 0
  return {
    read(count) {
      let value = 0
      for (let index = 0; index < count; index += 1) {
        const byte = bytes[position >> 3] ?? 0
        value = value * 2 + ((byte >> (7 - (position & 7))) & 1)
        position += 1
      }
      return value
    },
    cutShort: () => position > bytes.length * 8,
    bytesRead: () => Math.ceil(position / 8),
  }
}

/** Whether a frame starts with the sync word of AC-3 and E-AC-3. */
function hasSyncWord(frame: Uint8Array): boolean {
  return frame[0] === 0x0b && frame[1] === 0x77
}

/**
 * The samples in an Opus packet, from its TOC byte (RFC 6716 §3.1): the 5 bits
 * of its config give the size of each frame, and its code (the low 2 bits) the
 * number of frames: 1, or 2 for the codes 1 and 2, or for code 3 the low 6 bits
 * of the byte after the TOC. A packet with no frames, or one of more than
 * 120 ms, is none that RFC 6716 §3.2.5 allows.
 */
function opusSamples(frame: Uint8Array): number | null {
  const toc = frame[0]
  if (toc === undefined) return null
  const config = toc >> 3
  const code = toc & 3
  const size =
    config < 12
      ? OPUS_SILK_FRAMES[config % 4]
      : config < 16
        ? OPUS_HYBRID_FRAMES[config % 2]
        : OPUS_CELT_FRAMES[config % 4]
  let count = code === 0 ? 1 : 2
  if (code === 3) {
    const second = frame[1]
    if (second === undefined) return null
    count = second & 0x3f
  }
  if (size === undefined || count === 0) return null
  const samples = size * count
  return samples > OPUS_MAX_SAMPLES ? null : samples
}

/**
 * The samples in a frame of MPEG audio, from its 4-byte header (ISO/IEC
 * 11172-3 and 13818-3): an 11-bit sync, the version (2 bits: 3 is
 * MPEG-1, 2 is MPEG-2, 0 is MPEG-2.5 and 1 is reserved) and the layer (2 bits: 1
 * is layer 3, 2 is layer 2, 3 is layer 1 and 0 is reserved). Layer 1 has 384 and
 * layer 2 has 1152, in every version; layer 3 has 1152 in MPEG-1 and 576 in the
 * two that halve the sampling rate.
 */
function mpegSamples(frame: Uint8Array): number | null {
  if (frame.length < 4 || frame[0] !== 0xff) return null
  const second = frame[1] ?? 0
  if ((second & 0xe0) !== 0xe0) return null
  const version = (second >> 3) & 3
  if (version === 1) return null
  switch ((second >> 1) & 3) {
    case 3:
      return 384
    case 2:
      return 1152
    case 1:
      return version === 3 ? 1152 : 576
    default:
      return null
  }
}

/**
 * The audio blocks and the sampling rate of an E-AC-3 syncframe, from its fscod
 * and the 2 bits after it, which are numblkscod, or fscod2 when fscod is 3. Null
 * for the fscod2 that is reserved.
 */
function eac3Timing(fscod: number, code2: number): { blocks: number; rate: number } | null {
  if (fscod === 3) {
    const rate = EAC3_REDUCED_RATES[code2]
    return rate === undefined ? null : { blocks: 6, rate }
  }
  const rate = EAC3_RATES[fscod]
  const blocks = EAC3_BLOCKS[code2]
  return rate === undefined || blocks === undefined ? null : { blocks, rate }
}

/**
 * The samples in an E-AC-3 frame, from its first syncframe (ETSI TS 102 366
 * Annex E): after the sync word, strmtyp (2 bits), substreamid (3) and frmsiz
 * (11) it has fscod (2) and numblkscod (2), which gives 256 samples a block of
 * 1, 2, 3 or 6, or fscod2 in its place for the reduced rates, with 6 blocks.
 * An AC-3 syncframe has its bitstream ID (5 bits, 11 to 16 in E-AC-3) at the
 * place that an E-AC-3 syncframe has its own, after acmod and lfeon, so that
 * one whose ID is not E-AC-3's, which would be read as another header, is null.
 */
function eac3Samples(frame: Uint8Array): number | null {
  const bits = bitReader(frame)
  if (bits.read(16) !== SYNC_WORD) return null
  bits.read(16) // strmtyp, substreamid and frmsiz
  const fscod = bits.read(2)
  const code2 = bits.read(2)
  bits.read(4) // acmod and lfeon
  const bsid = bits.read(5)
  if (bits.cutShort() || bsid < EAC3_MIN_BSID || bsid > EAC3_MAX_BSID) return null
  const timing = eac3Timing(fscod, code2)
  return timing === null ? null : timing.blocks * EAC3_BLOCK_SAMPLES
}

/**
 * The samples in a FLAC frame, from the block size code of its header (the FLAC
 * format specification, "Frame header"): the 14-bit sync 0xFFF8 (or 0xFFF9, as
 * the blocking strategy is its last bit), the block size code (4 bits) and the
 * sample rate code (4), the channel assignment and sample size (a byte), then the
 * frame or sample number coded as UTF-8 (1 to 7 bytes), and then, for the codes 6
 * and 7 only, the block size less 1 in 8 or 16 bits. The code 0 is reserved, 1 is
 * 192, 2 to 5 are 576 × 2^(n−2) and 8 to 15 are 256 × 2^(n−8).
 */
function flacSamples(frame: Uint8Array): number | null {
  if (frame.length < 4 || frame[0] !== 0xff || ((frame[1] ?? 0) & 0xfe) !== 0xf8) return null
  const code = (frame[2] ?? 0) >> 4
  if (code === 0) return null
  if (code === 1) return 192
  if (code <= 5) return 576 << (code - 2)
  if (code >= 8) return 256 << (code - 8)
  // The number's first byte says how long it is by its leading 1 bits: none for 1 byte, and 2 to 7 for as many; 1 (a byte that continues one) and 8 lead no number.
  const lead = frame[4]
  if (lead === undefined) return null
  const ones = Math.clz32(~(lead << 24))
  if (ones === 1 || ones === 8) return null
  const length = Math.max(ones, 1)
  for (let index = 1; index < length; index += 1) {
    if (((frame[4 + index] ?? 0) & 0xc0) !== 0x80) return null // not a continuation, or cut short
  }
  const at = 4 + length
  const high = frame[at]
  if (high === undefined) return null
  if (code === 6) return high + 1
  const low = frame[at + 1]
  return low === undefined ? null : high * 256 + low + 1
}

/** The samples in an ALAC frame, which the cookie in CodecPrivate gives (ALACSpecificConfig, whose first field is the u32 frameLength); null without one, or with a frameLength of 0. */
function alacSamples(cookie: Uint8Array | null): number | null {
  if (cookie === null || cookie.length < 4) return null
  const frameLength = new DataView(cookie.buffer, cookie.byteOffset, cookie.byteLength).getUint32(0)
  return frameLength === 0 ? null : frameLength
}

/**
 * How many samples a sound frame holds, by its own header, counted at the rate
 * that `sampleRate` gives: so that the frames of a laced block, which share a
 * timestamp, can be timed one after another. Null when the header doesn't say
 * (a codec whose frames carry no count, or a header that isn't the codec's) or is
 * cut short; it never throws.
 *
 * - Opus: the TOC byte, as `opusSamples` reads it.
 * - AAC (any CodecID that starts `A_AAC`): 1024. For HE-AAC the track's rate is
 *   the core's, which 1024 samples are of.
 * - MPEG audio (`A_MPEG/L1`, `L2` and `L3`): the version and layer of its header.
 * - AC-3: 1536 after the sync word. E-AC-3: from its first syncframe.
 * - FLAC: the block size code of its header. ALAC: the cookie's frameLength.
 */
export function frameSamples(track: SoundTrack, frame: Uint8Array): number | null {
  if (track.codecId.startsWith('A_AAC')) return AAC_SAMPLES
  switch (track.codecId) {
    case 'A_OPUS':
      return opusSamples(frame)
    case 'A_MPEG/L1':
    case 'A_MPEG/L2':
    case 'A_MPEG/L3':
      return mpegSamples(frame)
    case 'A_AC3':
      return hasSyncWord(frame) ? AC3_SAMPLES : null
    case 'A_EAC3':
      return eac3Samples(frame)
    case 'A_FLAC':
      return flacSamples(frame)
    case 'A_ALAC':
      return alacSamples(track.codecPrivate)
    default:
      return null
  }
}

/**
 * What `frameSamples` counts in: 48000 for Opus, whatever its OpusHead says of the
 * rate it was recorded at, else the track's SamplingFrequency, or the 8000 that
 * Matroska gives a sound with no Audio element. For HE-AAC that is the core rate
 * and not the output rate, which is what the frames of 1024 samples are of.
 */
export function sampleRate(track: Pick<MatroskaTrack, 'codecId' | 'audio'>): number {
  if (track.codecId === 'A_OPUS') return OPUS_RATE
  return track.audio?.samplingFrequency ?? DEFAULT_SAMPLING_FREQUENCY
}

/**
 * The `dac3` box (ETSI TS 102 366, Annex F) of an AC-3 frame, from the first
 * syncframe's syncinfo and BSI (clause 4): the sync word (16 bits), crc1 (16), fscod
 * (2) and frmsizecod (6); then bsid (5), bsmod (3) and acmod (3), the mix levels
 * that acmod has (cmixlev when acmod is odd and not 1, surmixlev when its bit 4 is
 * set and dsurmod when it is 2; 2 bits each) and lfeon (1). The box holds 24
 * bits: fscod (2), bsid (5), bsmod (3), acmod (3), lfeon (1), bit_rate_code (5),
 * which is frmsizecod >> 1, and 5 reserved. A frame whose sync word is another, or
 * whose fscod is 3, whose frmsizecod is over 37 or whose bsid is over 10 (which
 * belongs to E-AC-3), or that is cut short before lfeon, is `damaged`.
 */
export function ac3Config(frame: Uint8Array): Uint8Array {
  const bits = bitReader(frame)
  const sync = bits.read(16)
  bits.read(16) // crc1
  const fscod = bits.read(2)
  const frmsizecod = bits.read(6)
  const bsid = bits.read(5)
  const bsmod = bits.read(3)
  const acmod = bits.read(3)
  if ((acmod & 1) !== 0 && acmod !== 1) bits.read(2) // cmixlev
  if ((acmod & 4) !== 0) bits.read(2) // surmixlev
  if (acmod === 2) bits.read(2) // dsurmod
  const lfeon = bits.read(1)

  if (sync !== SYNC_WORD) {
    throw damaged(
      `its first frame can't be read as AC-3: it doesn't start with the sync word 0x0B77.`,
    )
  }
  if (bits.cutShort()) {
    throw damaged(`its first frame can't be read as AC-3: it is cut short before its header ends.`)
  }
  if (fscod === 3) {
    throw damaged(
      `its first frame can't be read as AC-3: its sampling rate code is 3, which AC-3 reserves.`,
    )
  }
  if (frmsizecod > AC3_MAX_FRMSIZECOD) {
    throw damaged(
      `its first frame can't be read as AC-3: its frame size code is ${frmsizecod}, and AC-3 has none above ${AC3_MAX_FRMSIZECOD}.`,
    )
  }
  if (bsid > AC3_MAX_BSID) {
    throw damaged(
      `its first frame can't be read as AC-3: its bitstream ID is ${bsid}, and only E-AC-3 has one above ${AC3_MAX_BSID}.`,
    )
  }
  const body = pack([
    [fscod, 2],
    [bsid, 5],
    [bsmod, 3],
    [acmod, 3],
    [lfeon, 1],
    [frmsizecod >> 1, 5], // bit_rate_code
    [0, 5], // reserved
  ])
  return box('dac3', body)
}

/** What one E-AC-3 syncframe says (ETSI TS 102 366, Annex E) that a `dec3` entry is made from. */
interface Eac3Syncframe {
  /** 0 is an independent substream, 1 a dependent one and 2 an independent one that was AC-3 (3 is reserved). */
  streamType: number
  substreamId: number
  /** The syncframe's bytes: (frmsiz + 1) × 2. */
  size: number
  rate: number
  blocks: number
  fscod: number
  acmod: number
  lfeon: number
  bsid: number
  /** The 9 bits of `chan_loc` that a dependent substream's chanmap gives; 0 when it has none. */
  location: number
}

/**
 * The syncframe at `at` in an E-AC-3 frame (ETSI TS 102 366, Annex E): after the
 * sync word (16 bits), strmtyp (2), substreamid (3) and frmsiz (11), the BSI has
 * fscod (2) and numblkscod (2) or, when fscod is 3, fscod2 (2); acmod (3), lfeon
 * (1), bsid (5), dialnorm (5) and compre (1) with compr (8) after it when set; for
 * acmod 0 also dialnorm2 (5) and compr2e (1) with compr2 (8); and for a dependent
 * substream chanmape (1) with chanmap (16) after it when set. The chanmap names
 * the channel locations of a dependent substream with a bit each from the top:
 * Lc/Rc is the 6th of 16, then Lrs/Rrs, Cs, Ts, Lsd/Rsd, Lw/Rw, Lvh/Rvh, Cvh and
 * LFE2 (Annex E, the table of the chanmap bits), which are the bits of `chan_loc` in the same order, so that
 * chan_loc is `(chanmap >> 2) & 0x1FF`.
 */
function readEac3Syncframe(frame: Uint8Array, at: number): Eac3Syncframe {
  const where = `the syncframe at byte ${at}`
  const rest = frame.subarray(at)
  const bits = bitReader(rest)
  if (bits.read(16) !== SYNC_WORD) {
    throw damaged(
      `its first frame can't be read as E-AC-3: ${where} doesn't start with the sync word 0x0B77.`,
    )
  }
  const streamType = bits.read(2)
  const substreamId = bits.read(3)
  const size = (bits.read(11) + 1) * 2
  const fscod = bits.read(2)
  const code2 = bits.read(2)
  const acmod = bits.read(3)
  const lfeon = bits.read(1)
  const bsid = bits.read(5)
  bits.read(5) // dialnorm
  if (bits.read(1) === 1) bits.read(8) // compre, compr
  if (acmod === 0) {
    bits.read(5) // dialnorm2
    if (bits.read(1) === 1) bits.read(8) // compr2e, compr2
  }
  let location = 0
  if (streamType === 1 && bits.read(1) === 1) location = (bits.read(16) >> 2) & 0x1ff // chanmape, chanmap

  if (bits.cutShort()) {
    throw damaged(
      `its first frame can't be read as E-AC-3: ${where} is cut short, as the frame ends before its header does.`,
    )
  }
  if (streamType === 3) {
    throw damaged(
      `its first frame can't be read as E-AC-3: ${where} has the stream type 3, which E-AC-3 reserves.`,
    )
  }
  const timing = eac3Timing(fscod, code2)
  if (timing === null) {
    throw damaged(
      `its first frame can't be read as E-AC-3: ${where} has the sampling rate codes fscod 3 and fscod2 3, which E-AC-3 reserves.`,
    )
  }
  if (bsid < EAC3_MIN_BSID || bsid > EAC3_MAX_BSID) {
    throw damaged(
      `its first frame can't be read as E-AC-3: ${where} has the bitstream ID ${bsid}, and E-AC-3's are ${EAC3_MIN_BSID} to ${EAC3_MAX_BSID}.`,
    )
  }
  if (bits.bytesRead() > size) {
    throw damaged(
      `its first frame can't be read as E-AC-3: ${where} is ${size} bytes long, fewer than its header.`,
    )
  }
  if (size > rest.length) {
    throw damaged(
      `its first frame can't be read as E-AC-3: ${where} is cut short, as it is ${size} bytes long and the frame has ${rest.length} left.`,
    )
  }
  return { streamType, substreamId, size, ...timing, fscod, acmod, lfeon, bsid, location }
}

/** One independent substream of a `dec3` box, with the dependent substreams that follow it. */
interface Eac3Entry {
  syncframe: Eac3Syncframe
  dependents: number
  location: number
}

/**
 * The `dec3` box (ETSI TS 102 366, Annex F) of an E-AC-3 frame, which is the
 * syncframes of one access unit one after another: an independent substream
 * (strmtyp 0, or 2 for one that began as AC-3) with the dependent substreams
 * (strmtyp 1) that follow it, and then the next independent substream. The box
 * holds data_rate (13 bits: the first syncframe's bit rate in kbit/s, its bytes
 * × 8 × its rate ÷ (blocks × 256) ÷ 1000, rounded down) and num_ind_sub less 1
 * (3 bits), and for each independent substream fscod (2), bsid (5), a reserved
 * bit, asvc (1), bsmod (3), acmod (3), lfeon (1), 3 reserved bits and num_dep_sub
 * (4), then chan_loc (9, the OR of the chan_loc of its dependent substreams) when
 * num_dep_sub is more than 0 or else 1 reserved bit. asvc and bsmod are 0, as
 * ffmpeg writes them for E-AC-3.
 *
 * A syncframe of a substream that has been seen before is the rest of the audio
 * blocks of the same access unit when the syncframes hold fewer than 6 each
 * (numblkscod under 3), and ends the walk: the substreams are those of the first
 * round. The walk is `damaged` for a syncframe that isn't whole or isn't E-AC-3,
 * for bytes after one that aren't a syncframe, for a frame that starts with a
 * dependent substream, and for more than 15 dependent substreams of one.
 *
 * The chan_loc is the one thing here that no file in the corpus checks, as none
 * has a dependent substream: it is made as the standard's tables read.
 */
export function eac3Config(frame: Uint8Array): Uint8Array {
  const entries: Eac3Entry[] = []
  const first = readEac3Syncframe(frame, 0)
  let syncframe = first
  let at = 0
  for (;;) {
    if (syncframe.streamType === 1) {
      const entry = entries[entries.length - 1]
      if (entry === undefined) {
        throw damaged(
          `its first frame can't be read as E-AC-3: the syncframe at byte ${at} is a dependent substream, with no independent substream before it for it to belong to.`,
        )
      }
      entry.dependents += 1
      entry.location |= syncframe.location
      if (entry.dependents > MAX_DEPENDENTS) {
        throw damaged(
          `its first frame can't be read as E-AC-3: it has more than ${MAX_DEPENDENTS} dependent substreams after one independent substream, which is more than a dec3 box counts.`,
        )
      }
    } else {
      const current = syncframe
      if (entries.some((entry) => entry.syncframe.substreamId === current.substreamId)) break
      entries.push({ syncframe: current, dependents: 0, location: 0 })
    }
    at += syncframe.size
    if (at >= frame.length) break
    syncframe = readEac3Syncframe(frame, at)
  }

  // At most 6144 kbit/s (4096 bytes of 1 block at 48000 Hz), so that it has the 13 bits.
  const dataRate = Math.floor(
    (first.size * 8 * first.rate) / (first.blocks * EAC3_BLOCK_SAMPLES * 1000),
  )
  const fields: Field[] = [
    [dataRate, 13],
    [entries.length - 1, 3],
  ]
  for (const { syncframe: head, dependents, location } of entries) {
    fields.push(
      [head.fscod, 2],
      [head.bsid, 5],
      [0, 1], // reserved
      [0, 1], // asvc
      [0, 3], // bsmod
      [head.acmod, 3],
      [head.lfeon, 1],
      [0, 3], // reserved
      [dependents, 4],
      dependents > 0 ? [location, 9] : [0, 1],
    )
  }
  return box('dec3', pack(fields))
}
