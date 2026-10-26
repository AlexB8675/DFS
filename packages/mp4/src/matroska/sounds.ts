import { mp3Esds, soundEntry, soundRateField } from '../codecs.ts'
import { Mp4Error } from '../errors.ts'
import { ac3Config, eac3Config } from './frameheaders.ts'
import type { MatroskaAudio, MatroskaTrack } from './tracks.ts'

// The sample entry that a Matroska sound track stands for (DESIGN.md §10.4,
// D45): an ISO version 0 sound entry, which `initEntry` carries as it is and
// `codecNames` names, so that a Matroska sound plays through the same init
// segments as an MP4 one. Matroska keeps a codec's configuration in its
// CodecPrivate, which is the AudioSpecificConfig for AAC, the OpusHead for Opus
// (little-endian, where `dOps` is big-endian), `fLaC` and the metadata blocks for
// FLAC and ALAC's magic cookie (the body of the MP4 `alac` box); AC-3 and E-AC-3
// keep none, and their boxes are read from the track's first frame (see
// `ac3Config`). A codec that no browser plays as MP4 is refused as
// `unsupported-codec` with its CodecID in the sentence, and a track that lacks
// what its entry is made of is `damaged`; each sentence reads after "The sound
// track can't be played: " (see `choose.ts`), so it begins in lowercase and says
// what the track is.

/** The 8 bytes of a box header, and of a full box, the version and flags after it. */
const BOX_HEADER = 8
const FULL_BOX_FIELDS = 4

/** The most channels that a sound entry's 16 bits can count. */
const MAX_CHANNELS = 0xffff

/** The tags of the descriptors of an `esds` (ISO/IEC 14496-1): the ES_Descriptor, the DecoderConfigDescriptor, the DecoderSpecificInfo and the SLConfigDescriptor. */
const ES_DESCRIPTOR = 0x03
const DECODER_CONFIG = 0x04
const DECODER_SPECIFIC_INFO = 0x05
const SL_CONFIG = 0x06

/** The `objectTypeIndication` of MPEG-4 audio, and the stream type byte of an audio stream (the type 5 in the top 6 bits, then the upstream bit, which is 0, and a reserved bit, which is 1). */
const MPEG4_AUDIO = 0x40
const AUDIO_STREAM = 0x15

/** The least that an OpusHead holds (RFC 7845 §5.1): its magic (8 bytes), the version, the channel count, the pre-skip (2), the input rate (4), the output gain (2) and the channel mapping family. A family other than 0 adds the stream count, the coupled count and a byte of mapping for each channel. */
const OPUS_HEAD = 19

/** The size of a FLAC STREAMINFO block (the FLAC format specification), and the length of the marker that begins a FLAC stream and the header of a metadata block: 4 bytes of `fLaC`, then a byte (the flag that the block is the last, and its type in the low 7 bits) and the length (24 bits). */
const STREAM_INFO = 34
const FLAC_MARKER = 4
const BLOCK_HEADER = 4

/** The `dfLa` block header of a STREAMINFO that is the last block: the flag, type 0, and its length of 34. */
const LAST_STREAM_INFO = [0x80, 0x00, 0x00, STREAM_INFO]

/** The size of ALAC's magic cookie (the ALACSpecificConfig of Apple's open-source codec): up to the sampling rate (u32) at byte 20, which is the last field. */
const ALAC_COOKIE = 24

/** The sampling frequencies that an AudioSpecificConfig names by their index (ISO/IEC 14496-3), from 0. */
const SAMPLING_FREQUENCIES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

function unsupported(message: string): Mp4Error {
  return new Mp4Error('unsupported-codec', message)
}

/** The parts one after the other, as new bytes. */
function concat(...parts: readonly ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A box of this type around the parts, which are copied. */
function box(type: string, ...parts: readonly ArrayLike<number>[]): Uint8Array {
  const body = concat(...parts)
  const out = new Uint8Array(BOX_HEADER + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(body, BOX_HEADER)
  return out
}

/** A box of this type that begins with its version and flags, both 0. */
function fullBox(type: string, ...parts: readonly ArrayLike<number>[]): Uint8Array {
  return box(type, new Uint8Array(FULL_BOX_FIELDS), ...parts)
}

/** A descriptor of an `esds` (ISO/IEC 14496-1): its tag, the length of its body in groups of 7 bits, the top bit of each but the last set (one byte below 128, and no more bytes than the length takes), then its body. */
function descriptor(tag: number, ...parts: readonly ArrayLike<number>[]): Uint8Array {
  const body = concat(...parts)
  const length: number[] = [body.length % 128]
  for (let rest = Math.floor(body.length / 128); rest > 0; rest = Math.floor(rest / 128)) {
    length.unshift((rest % 128) | 0x80)
  }
  return concat([tag], length, body)
}

/**
 * The `esds` of an `mp4a` entry around a config: version 0, then an
 * ES_Descriptor (ES_ID 0, no flags) that holds a DecoderConfigDescriptor of MPEG-4
 * audio for an audio stream, with no buffer size and no bit rates, whose
 * DecoderSpecificInfo is the config, and an SLConfigDescriptor of 2, which is what
 * MP4 files carry. It is laid out as the `esds` that `mp3Esds` makes is.
 */
function esds(config: Uint8Array): Uint8Array {
  const decoder = descriptor(
    DECODER_CONFIG,
    [MPEG4_AUDIO, AUDIO_STREAM],
    new Uint8Array(3 + 4 + 4), // the size of the buffer, the highest bit rate and the average
    descriptor(DECODER_SPECIFIC_INFO, config),
  )
  const stream = descriptor(
    ES_DESCRIPTOR,
    new Uint8Array(2 + 1), // the ES_ID and the flags
    decoder,
    descriptor(SL_CONFIG, [2]),
  )
  return fullBox('esds', stream)
}

/** The CodecPrivate of a track, which is read from; a track that has none (or an empty one) is damaged, with the sentence naming what the CodecPrivate holds. */
function required(track: MatroskaTrack, what: string): Uint8Array {
  if (track.codecPrivate === null || track.codecPrivate.length === 0) {
    throw damaged(
      `it has no CodecPrivate, which holds ${what} that the ${track.codecId} sound is played from.`,
    )
  }
  return track.codecPrivate
}

/** The index of a sampling frequency in the table of an AudioSpecificConfig; a frequency that isn't there is damaged, as the config can't be made. */
function frequencyIndex(hertz: number, which: string): number {
  const index = SAMPLING_FREQUENCIES.indexOf(hertz)
  if (index === -1) {
    throw damaged(
      `it has no CodecPrivate, and the AudioSpecificConfig that is made in its place can't name ${which} of ${hertz}, which ISO/IEC 14496-3 has no index for.`,
    )
  }
  return index
}

/**
 * The AudioSpecificConfig of an old AAC CodecID (`A_AAC/MPEG2/LC`,
 * `A_AAC/MPEG4/LC/SBR`) that has no CodecPrivate, made as ffmpeg's
 * `matroskadec.c` makes it: the profile is the audio object type, 1 for `MAIN`, 2
 * for `LC`, 3 for `SSR` in the ID and 4 for any other; then the index of the
 * SamplingFrequency, the channel count where the channel configuration goes, and
 * 3 bits of 0. An ID that holds `SBR` adds the extension: the sync word 0x2B7,
 * the audio object type 5 (SBR), a flag that SBR is present and the index of the
 * OutputSamplingFrequency (the SamplingFrequency when the track has none), which
 * is 5 bytes in all. A frequency with no index is damaged. The channel count is
 * written as it is, as ffmpeg writes it, so that it spills out of its 4 bits
 * above 15.
 */
function madeConfig(track: MatroskaTrack, audio: MatroskaAudio): Uint8Array {
  const id = track.codecId
  const profile = id.includes('MAIN') ? 1 : id.includes('LC') ? 2 : id.includes('SSR') ? 3 : 4
  const index = frequencyIndex(audio.samplingFrequency, 'a sampling frequency')
  const config = [
    (profile << 3) | ((index & 0x0e) >> 1),
    ((index & 1) << 7) | (audio.channels << 3),
  ]
  if (id.includes('SBR')) {
    const output = frequencyIndex(
      audio.outputSamplingFrequency ?? audio.samplingFrequency,
      'an output sampling frequency',
    )
    config.push(0x56, 0xe5, 0x80 | (output << 3))
  }
  return Uint8Array.from(config)
}

/** The `esds` of an AAC sound: around the AudioSpecificConfig that its CodecPrivate is, whatever the CodecID says, or around one made from what the track says of itself when it has none, for an old CodecID (see `madeConfig`). The bare `A_AAC` is played from its CodecPrivate alone, and is damaged without. */
function aacConfig(track: MatroskaTrack, audio: MatroskaAudio): Uint8Array {
  if (track.codecPrivate !== null && track.codecPrivate.length > 0) {
    return esds(track.codecPrivate)
  }
  if (track.codecId === 'A_AAC') {
    throw damaged(
      'it has no CodecPrivate, which holds the AudioSpecificConfig that the bare A_AAC is played from.',
    )
  }
  return esds(madeConfig(track, audio))
}

/**
 * The `dOps` box of an Opus sound, and the channel count its OpusHead gives: the
 * OpusHead (RFC 7845 §5.1) is the magic `OpusHead`, the version, the channel
 * count (a byte), the pre-skip (16 bits), the input sample rate (32), the output
 * gain (16, signed) and the channel mapping family, all little-endian; the
 * `dOps` box is the same fields in the opposite order of bytes, with version 0,
 * and for a family other than 0 the stream count, the coupled count and one byte
 * of mapping for each channel, which follow the family in the OpusHead too. What
 * is after them is not carried. An OpusHead that is shorter than 19 bytes or
 * than its mapping needs, or has no magic, is damaged.
 */
function opusConfig(track: MatroskaTrack): { config: Uint8Array; channels: number } {
  const head = required(track, 'the OpusHead')
  const named = `its OpusHead, the CodecPrivate of ${head.length} bytes,`
  if (head.length < OPUS_HEAD) {
    throw damaged(`${named} is shorter than the ${OPUS_HEAD} bytes that an OpusHead has.`)
  }
  const data = new DataView(head.buffer, head.byteOffset, head.byteLength)
  if (String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') {
    throw damaged(`${named} doesn't begin with the magic 'OpusHead'.`)
  }
  const channels = data.getUint8(9)
  const family = data.getUint8(18)
  const needed = OPUS_HEAD + (family === 0 ? 0 : 2 + channels)
  if (head.length < needed) {
    throw damaged(
      `${named} is shorter than the ${needed} bytes that the mapping of channel mapping family ${family} for ${channels} channels takes.`,
    )
  }
  const fields = new Uint8Array(11)
  const out = new DataView(fields.buffer)
  // The version, 0, comes first.
  out.setUint8(1, channels)
  out.setUint16(2, data.getUint16(10, true)) // the pre-skip
  out.setUint32(4, data.getUint32(12, true)) // the input sample rate
  out.setInt16(8, data.getInt16(16, true)) // the output gain
  out.setUint8(10, family)
  return { config: box('dOps', fields, head.subarray(OPUS_HEAD, needed)), channels }
}

/**
 * The `dfLa` box of a FLAC sound, and the channels and the sample rate its
 * STREAMINFO gives. The CodecPrivate is the marker `fLaC` and the metadata blocks
 * of the FLAC stream, STREAMINFO (type 0) first; the box holds STREAMINFO alone,
 * as the last block, as ffmpeg writes it. STREAMINFO's 34 bytes are the block
 * sizes (2 and 2), the frame sizes (3 and 3), then the sample rate (20 bits), the
 * channels less one (3), the bits per sample less one (5) and the samples in all
 * (36), and the MD5 of the sound (16). A CodecPrivate that is not so is damaged.
 */
function flacConfig(track: MatroskaTrack): { config: Uint8Array; channels: number; rate: number } {
  const stream = required(track, "the 'fLaC' marker and the STREAMINFO block")
  const data = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const start = FLAC_MARKER + BLOCK_HEADER
  // The block header is a byte (the flag and the type) and a length of 24 bits: the low 24 of its 32.
  const whole =
    stream.length >= start + STREAM_INFO &&
    String.fromCharCode(...stream.subarray(0, FLAC_MARKER)) === 'fLaC' &&
    (data.getUint8(FLAC_MARKER) & 0x7f) === 0 &&
    data.getUint32(FLAC_MARKER) % 0x1000000 === STREAM_INFO
  if (!whole) {
    throw damaged(
      `its CodecPrivate of ${stream.length} bytes doesn't begin with the marker 'fLaC' and a STREAMINFO block of ${STREAM_INFO} bytes.`,
    )
  }
  const info = stream.subarray(start, start + STREAM_INFO)
  const fields = new DataView(info.buffer, info.byteOffset, info.byteLength)
  return {
    config: fullBox('dfLa', LAST_STREAM_INFO, info),
    channels: ((fields.getUint8(12) >> 1) & 7) + 1,
    rate: fields.getUint8(10) * 0x1000 + fields.getUint8(11) * 0x10 + (fields.getUint8(12) >> 4),
  }
}

/** The `alac` box of an ALAC sound, and the channels and the sample rate its magic cookie gives: a full box of version 0 around the CodecPrivate, as it is, which holds the channels (a byte) at 9 and the sample rate (32 bits) at 20. A cookie of under 24 bytes is damaged. */
function alacConfig(track: MatroskaTrack): { config: Uint8Array; channels: number; rate: number } {
  const cookie = required(track, "ALAC's magic cookie")
  if (cookie.length < ALAC_COOKIE) {
    throw damaged(
      `its ALAC cookie, the CodecPrivate of ${cookie.length} bytes, is shorter than the ${ALAC_COOKIE} that give its channels and its sample rate.`,
    )
  }
  const data = new DataView(cookie.buffer, cookie.byteOffset, cookie.byteLength)
  return { config: fullBox('alac', cookie), channels: data.getUint8(9), rate: data.getUint32(20) }
}

/** The `dac3` or the `dec3` box of the first frame of an AC-3 or E-AC-3 track: the frame is what Matroska leaves it to, and a track without one read is damaged. */
function frameConfig(
  track: MatroskaTrack,
  firstFrame: Uint8Array | null,
  read: (frame: Uint8Array) => Uint8Array,
): Uint8Array {
  if (firstFrame === null) {
    throw damaged(
      `there is no frame of the track to read its configuration from, which a ${track.codecId} sound is played from.`,
    )
  }
  return read(firstFrame)
}

/** A sound entry of this type, for these channels and this rate in hertz (`soundRateField` gives its field), around the boxes. Channels of 0 or of more than the 16 bits that an entry has are damaged. */
function sound(
  type: string,
  channels: number,
  hertz: number,
  ...boxes: readonly Uint8Array[]
): Uint8Array {
  if (channels === 0 || channels > MAX_CHANNELS) {
    throw damaged(`it has ${channels} channels, where an entry holds from 1 to ${MAX_CHANNELS}.`)
  }
  return soundEntry(type, channels, soundRateField(hertz), boxes)
}

/** Whether a track's entry is made from the bytes of its first frame (AC-3 and E-AC-3): the index reads the frame and gives it to `matroskaSoundEntry`. */
export function needsFirstFrame(track: MatroskaTrack): boolean {
  return track.codecId === 'A_AC3' || track.codecId === 'A_EAC3'
}

/**
 * The `stsd` entry that a sound track stands for, which `codecNames` names and
 * `initEntry` carries as it is: the ISO version 0 entry of the type and the
 * configuration box in the table, with 16 bits to a sample.
 * - `A_AAC`, and any CodecID that begins so (`A_AAC/MPEG4/LC`), is `mp4a` with an `esds` (`aacConfig`).
 * - `A_OPUS` is `Opus` with a `dOps` from the OpusHead (`opusConfig`), 48000 Hz, and the OpusHead's channels.
 * - `A_FLAC` is `fLaC` with a `dfLa` from STREAMINFO (`flacConfig`), and its channels and rate.
 * - `A_AC3` is `ac-3` with the `dac3` of the first frame, and `A_EAC3` is `ec-3` with its `dec3` (`ac3Config`, `eac3Config`). `firstFrame` is that frame, which `needsFirstFrame` says is wanted or not; a track without one is damaged.
 * - `A_MPEG/L3` is `mp4a` with the `esds` of MPEG-1 audio that `initEntry` gives QuickTime's `.mp3` (`mp3Esds`).
 * - `A_ALAC` is `alac` with the cookie in an `alac` box (`alacConfig`), and its channels and rate.
 * - `A_MPEG/L2`, which an `esds` can't tell from MP3, and every other CodecID are `unsupported-codec`.
 * The channels and the rate are the track's, but for the codecs that name them in their own configuration, which are Opus, FLAC and ALAC; the rate is as `soundRateField` makes it, halved while it is over 65535. A track with no Audio element is damaged.
 */
export function matroskaSoundEntry(
  track: MatroskaTrack,
  firstFrame: Uint8Array | null,
): Uint8Array {
  const { audio } = track
  if (audio === null) {
    throw damaged(
      `the track entry of track ${track.number} has no Audio element, so it is no sound.`,
    )
  }
  const { channels, samplingFrequency } = audio
  if (track.codecId.startsWith('A_AAC')) {
    return sound('mp4a', channels, samplingFrequency, aacConfig(track, audio))
  }
  switch (track.codecId) {
    case 'A_OPUS': {
      const opus = opusConfig(track)
      return sound('Opus', opus.channels, 48000, opus.config)
    }
    case 'A_FLAC': {
      const flac = flacConfig(track)
      return sound('fLaC', flac.channels, flac.rate, flac.config)
    }
    case 'A_AC3':
      return sound('ac-3', channels, samplingFrequency, frameConfig(track, firstFrame, ac3Config))
    case 'A_EAC3':
      return sound('ec-3', channels, samplingFrequency, frameConfig(track, firstFrame, eac3Config))
    case 'A_MPEG/L3':
      return sound('mp4a', channels, samplingFrequency, mp3Esds())
    case 'A_ALAC': {
      const alac = alacConfig(track)
      return sound('alac', alac.channels, alac.rate, alac.config)
    }
    case 'A_MPEG/L2':
      throw unsupported(
        `its CodecID is A_MPEG/L2, which is MPEG audio layer 2, and an 'esds' can't tell that from MP3.`,
      )
    default:
      throw unsupported(
        `its CodecID, ${track.codecId}, is not a codec that any browser's Media Source takes in MP4.`,
      )
  }
}
