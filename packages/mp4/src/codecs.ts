import { child, childBoxes, firstBox, Reader } from './boxes.ts'
import type { Box } from './boxes.ts'
import { Mp4Error } from './errors.ts'
import type { SampleEntry } from './movie.ts'

// The names of each picture and sound codec as Media Source asks about it, and
// the sample entry an init segment carries (DESIGN.md §10.4, D45). The first
// name is RFC 6381's, which `MediaSource.isTypeSupported` and `addSourceBuffer`
// take: `avc1.64001f`, `hvc1.2.4.L153.B0`, `av01.0.05M.08`,
// `vp09.00.20.08.01.02.02.02.00`, `dvh1.08.06`, `mp4a.40.2`, `opus`, `flac`,
// `iamf.000.000.Opus`.
// Some codecs have others that a browser may know them by (`Opus` for `opus`,
// `mp3` and `mp4a.40.34` for MPEG audio layer 3), after it, so that the player
// can ask the browser about each in turn. They are read from the codec's own
// configuration box, never guessed from the entry's type. What no browser's
// Media Source takes in MP4 is refused as `Mp4Error('unsupported-codec')`, with
// the type in the sentence; a configuration that is missing, cut short or lies
// about its own sizes is `damaged`.
//
// QuickTime writes its sound entries in a form that Chrome's and Firefox's
// Media Source don't take (a version 1 or 2 entry, with the codec's
// configuration box inside a `wave` box, and for MP3 no configuration at all),
// and ISO's own AudioSampleEntryV1 is no more welcome to them, so `initEntry`
// writes every sound codec's entry as the ISO version 0 entry that they stand
// for.

/** What a picture entry holds before its child boxes: the 8 bytes every entry has, then the 70 of a VisualSampleEntry (ISO/IEC 14496-12). */
const VISUAL_FIELDS = 78

/** What a sound entry holds before its child boxes in ISO's version 0, which is also QuickTime's: the 8 bytes every entry has, then 20. */
const AUDIO_FIELDS = 28

/** `objectTypeIndication` of MPEG-4 audio, the only one that has an `mp4a.40.N` string. */
const MPEG4_AUDIO = 0x40

/** `objectTypeIndication` of MPEG-2 AAC, in its main, low complexity and scalable sampling rate profiles. */
const MPEG2_AAC_MAIN = 0x66
const MPEG2_AAC_LC = 0x67
const MPEG2_AAC_SSR = 0x68

/** `objectTypeIndication` of MPEG-2 audio (ISO/IEC 13818-3) and of MPEG-1 audio (11172-3), whose layer 3 is MP3. */
const MPEG2_AUDIO = 0x69
const MPEG1_AUDIO = 0x6b

/** `objectTypeIndication` of AC-3 and of E-AC-3, as MP4RA registers them. */
const AC3 = 0xa5
const EAC3 = 0xa6

/** Whether an `esds` object type is MPEG-2 AAC's, in any of its profiles. */
function isMpeg2Aac(objectType: number): boolean {
  return (
    objectType === MPEG2_AAC_MAIN || objectType === MPEG2_AAC_LC || objectType === MPEG2_AAC_SSR
  )
}

/** The names of a codec: never none, the RFC 6381 one first. */
type Names = [string, ...string[]]

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

function unsupported(message: string): Mp4Error {
  return new Mp4Error('unsupported-codec', message)
}

/** A byte as one or two hex digits, with no zero in front of a small one unless `width` asks for it. */
function hex(value: number, width = 1, upper = false): string {
  const digits = value.toString(16).padStart(width, '0')
  return upper ? digits.toUpperCase() : digits
}

/** A number in decimal with two digits at least, as the fields of `vp09.00.20.08` and `dvh1.08.06` are written: a zero in front of a single digit, and a number of three digits as it is. */
function decimal(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The bits of a configuration record from the top down, which is how its
 * fields are packed: `hvcC`, `av1C` and the AudioSpecificConfig have fields of
 * 1, 2, 3, 5 and 6 bits. A read past the end is a damaged record.
 */
class BitReader {
  readonly #bytes: Uint8Array
  readonly #what: string
  #position = 0

  constructor(bytes: Uint8Array, what: string) {
    this.#bytes = bytes
    this.#what = what
  }

  /** The next `count` bits (up to 32) as an unsigned number. */
  read(count: number): number {
    if (this.#position + count > this.#bytes.length * 8) {
      throw damaged(
        `The ${this.#what} holds ${this.#bytes.length} bytes, which are too few for what it says.`,
      )
    }
    let value = 0
    for (let index = 0; index < count; index += 1) {
      const byte = this.#bytes[this.#position >> 3] ?? 0
      value = value * 2 + ((byte >> (7 - (this.#position & 7))) & 1)
      this.#position += 1
    }
    return value
  }
}

/** The whole entry box, which `readMovie` cut out so that it is the first box of its bytes. */
function entryBox(entry: SampleEntry): Box {
  const whole = firstBox(entry.bytes, 0, entry.bytes.length)
  if (!whole) throw damaged(`The '${entry.type}' sample description holds no box.`)
  return whole
}

/** What is in the entry after `skip` bytes of its own fields, as a box that `child` can look in. */
function afterFields(entry: SampleEntry, whole: Box, skip: number): Box {
  if (whole.end - whole.body < skip) {
    throw damaged(
      `The '${entry.type}' sample description holds ${whole.end - whole.body} bytes, and its own fields take ${skip}.`,
    )
  }
  return { type: whole.type, start: whole.start, body: whole.body + skip, end: whole.end }
}

/**
 * The bytes inside a codec's configuration box in a picture entry, which the
 * codec's names are read from, and the type of the box that was found: the
 * first of `types` that the entry has (Dolby Vision's configuration is one of
 * three, by profile).
 */
function pictureConfig(
  entry: SampleEntry,
  ...types: [string, ...string[]]
): { type: string; bytes: Uint8Array } {
  const inside = afterFields(entry, entryBox(entry), VISUAL_FIELDS)
  for (const type of types) {
    const config = child(entry.bytes, inside, type)
    if (config) return { type, bytes: entry.bytes.subarray(config.body, config.end) }
  }
  const quoted = types.map((type) => `'${type}'`)
  const last = quoted.pop()
  const named = quoted.length > 0 ? `${quoted.join(', ')} or ${last}` : last
  throw damaged(`The '${entry.type}' sample description has no ${named} box.`)
}

/** `avc1.PPCCLL`: the profile, its compatibility flags and the level, which are bytes 1 to 3 of `avcC`, each as two lowercase hex digits. */
function avcString(entry: SampleEntry): string {
  const bits = new BitReader(pictureConfig(entry, 'avcC').bytes, "'avcC' box")
  bits.read(8) // configurationVersion
  const digits = [bits.read(8), bits.read(8), bits.read(8)].map((byte) => hex(byte, 2))
  return `${entry.type}.${digits.join('')}`
}

/** The 32 bits of `value` in the opposite order, as an unsigned number. */
function reversed(value: number): number {
  let out = 0
  for (let index = 0; index < 32; index += 1) {
    out = out * 2 + (Math.floor(value / 2 ** index) % 2)
  }
  return out
}

/**
 * `hvc1.A2.4.H153.90.0.0.0.0.1`, as ISO/IEC 14496-15 Annex E writes it: the
 * profile space (nothing, or A, B or C) and the profile; the 32 compatibility
 * flags with their bits in the opposite order, in hex; the tier (L or H) and
 * the level; then the 6 bytes of constraint flags in hex, each as short as it
 * goes and the zero ones at the end left out.
 */
function hevcString(entry: SampleEntry): string {
  const bits = new BitReader(pictureConfig(entry, 'hvcC').bytes, "'hvcC' box")
  bits.read(8) // configurationVersion
  const space = bits.read(2)
  const tier = bits.read(1)
  const profile = bits.read(5)
  const compatibility = bits.read(32)
  const constraints = Array.from({ length: 6 }, () => bits.read(8))
  const level = bits.read(8)
  while (constraints.at(-1) === 0) constraints.pop()
  const parts = [
    `${['', 'A', 'B', 'C'][space] ?? ''}${profile}`,
    hex(reversed(compatibility), 1, true),
    `${tier ? 'H' : 'L'}${level}`,
    ...constraints.map((byte) => hex(byte, 1, true)),
  ]
  return `${entry.type}.${parts.join('.')}`
}

/** `av01.0.05M.08`: the profile, then the level and tier (`M` for main, `H` for high) and the bit depth, the last two with two digits. */
function av1String(entry: SampleEntry): string {
  const bits = new BitReader(pictureConfig(entry, 'av1C').bytes, "'av1C' box")
  bits.read(8) // the marker and the version
  const profile = bits.read(3)
  const level = bits.read(5)
  const tier = bits.read(1)
  const high = bits.read(1)
  const twelve = bits.read(1)
  const depth = twelve ? 12 : high ? 10 : 8
  return `av01.${profile}.${decimal(level)}${tier ? 'H' : 'M'}.${decimal(depth)}`
}

/**
 * `vp09.00.20.08.01.02.02.02.00` and then `vp09.00.20.08` (`vp08` is the same),
 * from the `vpcC` of the VP codec binding: the profile, the level, the bit
 * depth, the chroma subsampling, the three colour codes (primaries, transfer
 * characteristics, matrix) and the full-range flag, each in decimal with two
 * digits at least (a colour code goes up to 255 and is written in three). The
 * short form is the first three of them, which is all that version 0 of the box
 * (the older one, whose other fields are not the same) gives: the profile, the
 * level, and the bit depth in the high nibble of the byte after them.
 */
function vpNames(entry: SampleEntry): Names {
  const bits = new BitReader(pictureConfig(entry, 'vpcC').bytes, "'vpcC' box")
  const version = bits.read(8)
  bits.read(24) // flags
  if (version > 1) throw damaged(`The 'vpcC' box is version ${version}, and only 0 and 1 are read.`)
  const profile = bits.read(8)
  const level = bits.read(8)
  const depth = bits.read(4)
  const short = `${entry.type}.${[profile, level, depth].map(decimal).join('.')}`
  if (version === 0) return [short]
  const chroma = bits.read(3)
  const fullRange = bits.read(1)
  const colour = [bits.read(8), bits.read(8), bits.read(8)] // the primaries, the transfer characteristics and the matrix
  return [`${short}.${[chroma, ...colour, fullRange].map(decimal).join('.')}`, short]
}

/**
 * `dvh1.08.06`, from the configuration box that Dolby Vision's entries hold
 * (`dvcC`, `dvvC` or `dvwC`, by profile), which begins with a version of two
 * bytes, then the profile (7 bits) and the level (6), both in decimal with two
 * digits at least. The flags of the layers behind them are not in the name.
 */
function dolbyVisionNames(entry: SampleEntry): Names {
  const { type, bytes } = pictureConfig(entry, 'dvcC', 'dvvC', 'dvwC')
  const bits = new BitReader(bytes, `'${type}' box`)
  bits.read(16) // the major and the minor version
  const profile = bits.read(7)
  const level = bits.read(6)
  return [`${entry.type}.${decimal(profile)}.${decimal(level)}`]
}

/** A descriptor of an `esds`: its tag and where its body is. */
interface Descriptor {
  tag: number
  from: number
  to: number
}

/**
 * The first descriptor of a tag in [from, to), which is a tag and a length of
 * one to four bytes (7 bits each, the top bit saying that another follows)
 * before its body. It stops at the one it wants, so what follows is not read;
 * one before it, or one whose length runs past the range, is damaged.
 */
function findDescriptor(
  bytes: Uint8Array,
  from: number,
  to: number,
  tag: number,
): Descriptor | null {
  const reader = new Reader(bytes, from, to)
  while (reader.remaining > 0) {
    const at = reader.position
    const found = reader.u8()
    let length = 0
    for (let group = 1; ; group += 1) {
      const next = reader.u8()
      length = length * 128 + (next & 0x7f)
      if ((next & 0x80) === 0) break
      if (group === 4) {
        throw damaged(`The descriptor at offset ${at} has a length of more than 4 bytes.`)
      }
    }
    const body = reader.position
    reader.skip(length)
    if (found === tag) return { tag, from: body, to: body + length }
  }
  return null
}

/** What `esds` says of the stream: the type of its object and where that byte is, and the AudioSpecificConfig when it has one. */
interface StreamConfig {
  objectType: number
  /** The index of the objectTypeIndication byte in the bytes the `esds` was read from. */
  objectTypeAt: number
  config: Descriptor | null
}

/**
 * What a DecoderConfigDescriptor says (ISO/IEC 14496-1): the type of its
 * object, then the stream's type, its buffer and its bit rates, which are not
 * read, then the descriptors it holds, the DecoderSpecificInfo among them.
 */
function decoderConfig(bytes: Uint8Array, decoder: Descriptor): StreamConfig {
  const fields = new Reader(bytes, decoder.from, decoder.to)
  const objectTypeAt = fields.position
  const objectType = fields.u8()
  fields.skip(12) // the stream's type, the size of its buffer, its highest and its average bit rate
  return {
    objectType,
    objectTypeAt,
    config: findDescriptor(bytes, fields.position, decoder.to, 0x05),
  }
}

/**
 * The DecoderConfigDescriptor of an `esds` (ISO/IEC 14496-1): inside the
 * ES_Descriptor, after its ID and flags and the fields that the flags say are
 * there (the stream it depends on, a URL, the stream that clocks it).
 */
function readStream(bytes: Uint8Array, esds: Box): StreamConfig {
  const outer = new Reader(bytes, esds.body, esds.end)
  outer.skip(4) // version and flags
  const stream = findDescriptor(bytes, outer.position, esds.end, 0x03)
  if (!stream) throw damaged(`The 'esds' box at offset ${esds.start} has no ES_Descriptor.`)
  const header = new Reader(bytes, stream.from, stream.to)
  header.skip(2) // ES_ID
  const flags = header.u8()
  if (flags & 0x80) header.skip(2) // the stream it depends on
  if (flags & 0x40) header.skip(header.u8()) // a URL, after its length
  if (flags & 0x20) header.skip(2) // the stream that clocks it
  const decoder = findDescriptor(bytes, header.position, stream.to, 0x04)
  if (!decoder)
    throw damaged(`The 'esds' box at offset ${esds.start} has no DecoderConfigDescriptor.`)
  return decoderConfig(bytes, decoder)
}

/** The audio object type that begins an AudioSpecificConfig: 5 bits, where 31 says that it is 32 plus the next 6. */
function audioObjectType(bytes: Uint8Array, config: Descriptor): number {
  const bits = new BitReader(bytes.subarray(config.from, config.to), 'AudioSpecificConfig')
  const type = bits.read(5)
  return type === 31 ? 32 + bits.read(6) : type
}

/** What the fields of a sound entry say, and where its configuration box is. */
interface AudioEntry {
  /** The entry's version: 0, which ISO's and QuickTime's both are, or 1 or 2 (QuickTime's, or ISO's AudioSampleEntryV1, by the version of the `stsd`). */
  version: number
  channels: number
  /** In hertz. */
  sampleRate: number
  /** Where the entry's boxes start, as a box that `child` can look in. */
  inside: Box
}

/**
 * The fields of a sound entry, laid out as FFmpeg reads them. Version 0 is
 * ISO's and QuickTime's, with 28 bytes before the boxes. In an `stsd` of
 * version 0, version 1 is QuickTime's, which adds 16 bytes (samples per
 * packet, bytes per packet, per frame and per sample), and version 2 is
 * QuickTime's too, which adds 36 and keeps the rate as a float and the channels
 * in the bytes it adds. In an `stsd` of version 1, version 1 is ISO's
 * AudioSampleEntryV1, which adds nothing but may hold an `srat` box with the
 * rate in hertz (the 16.16 field is the rate when there is none), and version
 * 2 is not read. An `stsd` of any other version is read as one of version 0,
 * as it was before ISO's version 1 was.
 */
function readAudioEntry(entry: SampleEntry): AudioEntry {
  const whole = entryBox(entry)
  const reader = new Reader(entry.bytes, whole.body, whole.end)
  const sound = `The '${entry.type}' sample description`
  if (reader.remaining < AUDIO_FIELDS) {
    throw damaged(
      `${sound} holds ${reader.remaining} bytes, and its own fields take ${AUDIO_FIELDS}.`,
    )
  }
  reader.skip(8) // reserved, and the data reference index
  const version = reader.u16()
  const iso = entry.stsdVersion === 1
  if (version > (iso ? 1 : 2)) {
    const read = iso ? "0 and 1 are read in an 'stsd' of version 1" : '0, 1 and 2 are read'
    throw damaged(`${sound} is version ${version}, and only ${read}.`)
  }
  reader.skip(6) // revision and vendor
  let channels = reader.u16()
  reader.skip(6) // the size of a sample, the compression ID and the size of a packet
  let sampleRate = reader.u32() / 0x10000
  // QuickTime's version 1 adds 16 bytes: samples per packet, bytes per packet, per frame and per sample.
  if (version === 1 && !iso) reader.skip(16)
  // Its version 2 adds 36.
  if (version === 2) {
    // The fields above say 3 channels and a rate of 1; the ones that count are these.
    reader.skip(4) // the size of the entry so far
    const rate = reader.bytes(8)
    sampleRate = new DataView(rate.buffer, rate.byteOffset, 8).getFloat64(0)
    channels = reader.u32()
    reader.skip(20) // 0x7F000000, the bits per channel, flags and the sizes of a packet
  }
  const inside = { ...whole, body: reader.position }
  if (version === 1 && iso) {
    // The rate in hertz is in an `srat` box, which has room for more than the 16.16 field does: a full box, so its version and flags, then the rate.
    const rate = child(entry.bytes, inside, 'srat')
    if (rate) {
      const fields = new Reader(entry.bytes, rate.body, rate.end)
      fields.skip(4) // version and flags
      sampleRate = fields.u32()
    }
  }
  return { version, channels, sampleRate, inside }
}

/**
 * A box that a sound codec is set up from, found where the entry's own layout
 * puts its boxes (`readAudioEntry`): the entry's own, or the one inside the
 * `wave` box that QuickTime keeps it in. Every sound codec's configuration is
 * looked for here, so that a layout that is read differently is read so for all.
 */
function findAudioBox(
  entry: SampleEntry,
  inside: Box,
  type: string,
): { box: Box; direct: boolean } {
  const direct = child(entry.bytes, inside, type)
  if (direct) return { box: direct, direct: true }
  const wrapper = child(entry.bytes, inside, 'wave')
  const wrapped = wrapper ? child(entry.bytes, wrapper, type) : null
  if (!wrapped) throw damaged(`The '${entry.type}' sample description has no '${type}' box.`)
  return { box: wrapped, direct: false }
}

/** The names of a sound whose decoder is made from the box `type` of its entry; without that box there is nothing to play. */
function configured(entry: SampleEntry, type: string, names: Names): Names {
  findAudioBox(entry, readAudioEntry(entry).inside, type)
  return names
}

/** Where the objectTypeIndication byte of an `esds` is, in the bytes that hold it, when it says MPEG-2 AAC; null for any other object type. */
function mpeg2AacTypeAt(bytes: Uint8Array, esds: Box): number | null {
  const { objectType, objectTypeAt } = readStream(bytes, esds)
  return isMpeg2Aac(objectType) ? objectTypeAt : null
}

/** The audio object type of the DecoderSpecificInfo of an `esds`, which is `damaged` when there is none or it is cut short. */
function specificInfoType(entry: SampleEntry, esds: Box, config: Descriptor | null): number {
  if (!config) throw damaged(`The 'esds' box at offset ${esds.start} has no DecoderSpecificInfo.`)
  return audioObjectType(entry.bytes, config)
}

/**
 * The names of an `mp4a` entry, from the object type of its `esds` (ISO/IEC
 * 14496-1, and the registry of MP4RA): `mp4a.40.N` for MPEG-4 audio, N being
 * its audio object type; MPEG-2 AAC (`mp4a.66`, `.67` and `.68`), which has a
 * DecoderSpecificInfo too, is named `mp4a.40.N` as well, N being the audio
 * object type of that, and by no other name: the stream is AAC all the same,
 * and `initEntry` writes the `esds` with MPEG-4 audio's object type, which is
 * all that Chrome's Media Source takes in MP4, so that a name with the object
 * type of MPEG-2 would describe an `esds` that the init segment doesn't carry;
 * `mp4a.6B` (MPEG-1 audio) and `mp4a.69` (MPEG-2 audio), which browsers also
 * know as `mp3` and as `mp4a.40.34`. Those two alternates presume layer 3, MP3,
 * which these object types don't state: their `esds` has no DecoderSpecificInfo,
 * so a stream of layer 2 is offered as `mp3` too. The object types of AC-3 and
 * E-AC-3 (`mp4a.A5`, `mp4a.A6`) are `ac-3` and `ec-3` as well. Any other is
 * named as it is, in two uppercase hex digits, for the browser to answer: that
 * includes Vorbis (0xDD), which is carried in an `mp4a`, and which no browser
 * takes.
 */
function mp4aNames(entry: SampleEntry): Names {
  const { inside } = readAudioEntry(entry)
  const { box: esds } = findAudioBox(entry, inside, 'esds')
  const { objectType, config } = readStream(entry.bytes, esds)
  const name = `mp4a.${hex(objectType, 2, true)}`
  switch (objectType) {
    case MPEG4_AUDIO:
      return [`mp4a.40.${specificInfoType(entry, esds, config)}`]
    case MPEG2_AAC_MAIN:
    case MPEG2_AAC_LC:
    case MPEG2_AAC_SSR:
      // Named as MPEG-4 audio and no more: the init entry says so (see `initEntry`).
      return [`mp4a.40.${specificInfoType(entry, esds, config)}`]
    case MPEG2_AUDIO:
    case MPEG1_AUDIO:
      return [name, 'mp3', 'mp4a.40.34']
    case AC3:
      return [name, 'ac-3']
    case EAC3:
      return [name, 'ec-3']
    default:
      return [name]
  }
}

/** The most bytes that a leb128 number has (IAMF v1.0 §3.2). */
const LEB128_BYTES = 8

/** `obu_type` of the Codec Config and of the IA Sequence Header (IAMF v1.0 §3.2). */
const OBU_CODEC_CONFIG = 0
const OBU_SEQUENCE_HEADER = 31

/**
 * A leb128 number (IAMF v1.0 §3.2): 7 bits in each byte, the low group first,
 * the top bit of a byte saying that another follows. One that is cut short, has
 * more than 8 bytes or is beyond `Number.MAX_SAFE_INTEGER` is damaged.
 */
function leb128(reader: Reader): number {
  const at = reader.position
  let value = 0
  for (let index = 0; index < LEB128_BYTES; index += 1) {
    const byte = reader.u8()
    value += (byte & 0x7f) * 128 ** index
    if ((byte & 0x80) === 0) {
      // A sum that a number can't hold exactly rounds to more than the largest it can, so this catches it too.
      if (value > Number.MAX_SAFE_INTEGER) {
        throw damaged(
          `The leb128 number at offset ${at} is outside the range a number can hold exactly.`,
        )
      }
      return value
    }
  }
  throw damaged(`The leb128 number at offset ${at} is longer than ${LEB128_BYTES} bytes.`)
}

/** The profiles in an IA Sequence Header, as `PPP.AAA`: its code, `iamf`, then the primary and the additional profile, each in decimal with three digits. */
function sequenceProfiles(config: Box, obu: Reader): string {
  const code = obu.fourcc()
  if (code !== 'iamf') {
    throw damaged(
      `The Sequence Header of the 'iacb' box at offset ${config.start} has the code '${code}', and IAMF's is 'iamf'.`,
    )
  }
  const primary = String(obu.u8()).padStart(3, '0')
  const additional = String(obu.u8()).padStart(3, '0')
  return `${primary}.${additional}`
}

/**
 * The codec of a Codec Config OBU, as IAMF's codec string writes it. The OBU
 * holds the config's ID (leb128), the codec (4 bytes), the samples in a frame
 * (leb128) and the roll distance (16 bits), then the decoder config. `Opus`,
 * `fLaC` and `ipcm` are named by the codec alone; `mp4a` is `mp4a.40.N`, N
 * being the audio object type in the AudioSpecificConfig of its
 * DecoderConfigDescriptor, which is laid out as an `esds` has it and is looked
 * for inside this OBU only (IAMF fixes its object type at 0x40, which is not
 * asked). Any other codec is one that IAMF doesn't have, and no browser takes.
 */
function codecConfigName(entry: SampleEntry, config: Box, obu: Reader, end: number): string {
  leb128(obu) // codec_config_id
  const codec = obu.fourcc()
  leb128(obu) // num_samples_per_frame
  obu.i16() // audio_roll_distance
  switch (codec) {
    case 'Opus':
    case 'fLaC':
    case 'ipcm':
      return codec
    case 'mp4a': {
      const decoder = findDescriptor(entry.bytes, obu.position, end, 0x04)
      const named = `The Codec Config of the 'iacb' box at offset ${config.start}`
      if (!decoder) throw damaged(`${named} has no DecoderConfigDescriptor.`)
      const { config: specific } = decoderConfig(entry.bytes, decoder)
      if (!specific) throw damaged(`${named} has no DecoderSpecificInfo.`)
      return `mp4a.40.${audioObjectType(entry.bytes, specific)}`
    }
    default:
      throw unsupported(
        `The IAMF codec '${codec}' of the '${entry.type}' sample description is not a codec that any browser's Media Source takes in MP4.`,
      )
  }
}

/**
 * `iamf.000.000.Opus`, from the `iacb` box of an `iamf` entry (IAMF v1.0 §3.2
 * and §6.2.4): its configurationVersion, which is 1, the size of its OBUs
 * (leb128), then the OBUs. An OBU is a byte (its type in the top 5 bits, then
 * the flags of a redundant copy, of trimming and of an extension), its size
 * (leb128), which counts all that follows, two numbers if it is trimmed, a size
 * and that many bytes if it has an extension, and then its payload. The primary
 * and additional profiles are in the first Sequence Header (type 31) and the
 * codec in the first Codec Config (type 0). The OBUs are read until both are
 * found, in whatever order (IAMF puts the Sequence Header first, but nothing is
 * lost by not asking); one of any other type is passed by its size, and what
 * comes after the two is not read. A version other than 1, a size that runs
 * past what holds it and the lack of either OBU are damaged.
 */
function iamfNames(entry: SampleEntry): Names {
  const { inside } = readAudioEntry(entry)
  const { box: config } = findAudioBox(entry, inside, 'iacb')
  const named = `The 'iacb' box at offset ${config.start}`
  const outer = new Reader(entry.bytes, config.body, config.end)
  const version = outer.u8()
  if (version !== 1) throw damaged(`${named} is version ${version}, and only 1 is read.`)
  const size = leb128(outer)
  if (size > outer.remaining) {
    throw damaged(
      `${named} says that its OBUs take ${size} bytes, and ${outer.remaining} are in it.`,
    )
  }
  const list = new Reader(entry.bytes, outer.position, outer.position + size)
  let profiles: string | null = null
  let codec: string | null = null
  while (list.remaining > 0 && (profiles === null || codec === null)) {
    const header = list.u8()
    const type = header >> 3
    const length = leb128(list)
    if (length > list.remaining) {
      throw damaged(
        `An OBU of the 'iacb' box at offset ${config.start} claims ${length} bytes, but ${list.remaining} are left in its OBUs.`,
      )
    }
    const from = list.position
    list.skip(length)
    const wanted =
      (type === OBU_SEQUENCE_HEADER && profiles === null) ||
      (type === OBU_CODEC_CONFIG && codec === null)
    if (!wanted) continue
    // What the flags add is inside the OBU's size, and the payload comes after it; nothing here reads past the OBU.
    const obu = new Reader(entry.bytes, from, from + length)
    if (header & 2) {
      leb128(obu) // the samples to trim at the end
      leb128(obu) // and at the start
    }
    if (header & 1) obu.skip(leb128(obu)) // the extension header, after its size
    if (type === OBU_SEQUENCE_HEADER) profiles = sequenceProfiles(config, obu)
    else codec = codecConfigName(entry, config, obu, from + length)
  }
  if (profiles === null) throw damaged(`${named} holds no Sequence Header.`)
  if (codec === null) throw damaged(`${named} holds no Codec Config.`)
  return [`iamf.${profiles}.${codec}`]
}

/**
 * The names that Media Source is asked about for an entry, read from its
 * configuration, the RFC 6381 one first, and never none. A codec that browsers
 * know by others has them after it, in the order to try: `opus` and `Opus`,
 * `flac` and `fLaC`, and for MPEG-1 and MPEG-2 audio `mp4a.6B`, `mp3` and
 * `mp4a.40.34` (the last two presume layer 3: see `mp4aNames`). These are named,
 * for the player to ask the browser about: `avc1` to `avc4`, `hvc1` and `hev1`,
 * `av01`, VP9 and VP8 (`vp09`, `vp08`), Dolby Vision (`dvh1`, `dvhe`, `dav1`,
 * `dvav`, `dva1`), every `mp4a` by the object type of its `esds`, QuickTime's
 * `.mp3`, `Opus`, `fLaC`, `ac-3`, `ec-3`, `alac` and IAMF (`iamf`, named
 * `iamf.000.000.Opus` by the profiles and the codec in the OBUs of its `iacb`).
 * One whose configuration box is missing, cut short or lies about its sizes is
 * `damaged`. Every other type is refused as `unsupported-codec`, because no
 * browser's Media Source takes it in MP4:
 * - PCM: `ipcm` `fpcm` `sowt` `twos` `lpcm` `in24` `in32` `fl32` `fl64` `raw ` `NONE`;
 * - MPEG-4 Visual (`mp4v`), VVC (`vvc1` `vvi1`), Motion JPEG (`jpeg` `mjpa` `mjpb`) and ProRes (`apco` `apcs` `apcn` `apch` `ap4h` `ap4x`);
 * - DTS (`dtsc` `dtse` `dtsh` `dtsl` `dtsx`), AC-4 (`ac-4`), MPEG-H (`mha1` `mha2` `mhm1` `mhm2`), `ulaw` and `alaw`;
 * - the protected entries `encv` and `enca`.
 */
export function codecNames(entry: SampleEntry): Names {
  switch (entry.type) {
    case 'avc1':
    case 'avc2':
    case 'avc3':
    case 'avc4':
      return [avcString(entry)]
    case 'hvc1':
    case 'hev1':
      return [hevcString(entry)]
    case 'av01':
      return [av1String(entry)]
    case 'vp09':
    case 'vp08':
      return vpNames(entry)
    case 'dvh1':
    case 'dvhe':
    case 'dav1':
    case 'dvav':
    case 'dva1':
      return dolbyVisionNames(entry)
    case 'mp4a':
      return mp4aNames(entry)
    case '.mp3':
      // QuickTime's MP3 holds no configuration: the codec is the type, and the entry has to be whole.
      readAudioEntry(entry)
      return ['mp4a.6B', 'mp3', 'mp4a.40.34']
    case 'Opus':
      return configured(entry, 'dOps', ['opus', 'Opus'])
    case 'fLaC':
      return configured(entry, 'dfLa', ['flac', 'fLaC'])
    case 'ac-3':
      return configured(entry, 'dac3', ['ac-3'])
    case 'ec-3':
      return configured(entry, 'dec3', ['ec-3'])
    case 'alac':
      return configured(entry, 'alac', ['alac'])
    case 'iamf':
      return iamfNames(entry)
    default:
      throw unsupported(
        `The sample description '${entry.type}' is not a codec that any browser's Media Source takes in MP4.`,
      )
  }
}

/** The RFC 6381 string that Media Source is asked about for an entry: the first of its `codecNames`, which refuses what they do. */
export function codecString(entry: SampleEntry): string {
  return codecNames(entry)[0]
}

/** An ISO version 0 sound entry of this type for this many channels and this sample rate (16.16), followed by the boxes given. */
export function soundEntry(
  type: string,
  channels: number,
  rate: number,
  boxes: readonly Uint8Array[],
): Uint8Array {
  const out = new Uint8Array(8 + AUDIO_FIELDS + boxes.reduce((sum, part) => sum + part.length, 0))
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index) // the 6 reserved bytes after the type are 0
  view.setUint16(14, 1) // the data reference index: the one `dref` of an init segment
  // The version, the revision and the vendor are 0.
  view.setUint16(24, channels)
  view.setUint16(26, 16) // the size of a sample
  // The compression ID and the size of a packet are 0.
  view.setUint32(32, rate)
  let at = 8 + AUDIO_FIELDS
  for (const part of boxes) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * The box that a sound codec's decoder is made from, which its entry holds
 * directly or, in QuickTime's, inside the `wave` box: `esds` for `mp4a` and
 * for QuickTime's `.mp3` (whose entry has none, so that `mp3Esds` makes it),
 * and the codec's own for the rest. Null for a type that is not a sound.
 */
function audioConfigType(type: string): string | null {
  switch (type) {
    case 'mp4a':
    case '.mp3':
      return 'esds'
    case 'ac-3':
      return 'dac3'
    case 'ec-3':
      return 'dec3'
    case 'alac':
      return 'alac'
    case 'fLaC':
      return 'dfLa'
    case 'Opus':
      return 'dOps'
    case 'iamf':
      return 'iacb'
    default:
      return null
  }
}

/**
 * The `esds` that an `mp4a` entry of MPEG audio layer 3 is given in place of
 * QuickTime's `.mp3`, which has no configuration box. It is 35 bytes
 * that say what the type does: an ES_Descriptor (stream 0, no flags) that holds
 * a DecoderConfigDescriptor of object type 0x6B (MPEG-1 audio) for an audio
 * stream, with no buffer size, no bit rates and no DecoderSpecificInfo, then
 * an SLConfigDescriptor of 2, which is what MP4 files carry.
 */
export function mp3Esds(): Uint8Array {
  return Uint8Array.of(
    ...[0x00, 0x00, 0x00, 0x23], // the size of the box
    ...[0x65, 0x73, 0x64, 0x73], // 'esds'
    ...[0x00, 0x00, 0x00, 0x00], // version and flags
    ...[0x03, 0x15], // the ES_Descriptor, of 21 bytes
    ...[0x00, 0x00, 0x00], // its ID, and no flags
    ...[0x04, 0x0d], // the DecoderConfigDescriptor, of 13 bytes
    ...[0x6b, 0x15], // MPEG-1 audio, an audio stream
    ...[0x00, 0x00, 0x00], // the size of the buffer
    ...[0x00, 0x00, 0x00, 0x00], // the highest bit rate
    ...[0x00, 0x00, 0x00, 0x00], // the average bit rate
    ...[0x06, 0x01, 0x02], // the SLConfigDescriptor
  )
}

/** Whether a rate in hertz is one that a rate field can hold: a number, not below the least that 16.16 has (a rate that rounds to 0 is none). */
function isRate(hertz: number): boolean {
  return Number.isFinite(hertz) && Math.round(hertz * 0x10000) > 0
}

/**
 * The rate field of an ISO sound entry for a rate in hertz, in 16.16: the rate
 * as it is when its whole part fits the 16 bits that ISO has for it, and
 * otherwise halved as often as it takes, as FFmpeg writes it (96000 as 48000,
 * 88200 as 44100, 192000 as 48000). A rate that is no number, or is below what
 * 16.16 can hold, which an entry that plays doesn't say, is `damaged`; the
 * sentence reads on its own and after a prefix, as a Matroska track's do.
 */
export function soundRateField(hertz: number): number {
  if (!isRate(hertz)) {
    throw damaged(`a sample rate of ${hertz} is not one that a sound entry can hold.`)
  }
  let rate = Math.round(hertz * 0x10000)
  let half = hertz
  while (rate > 0xffffffff) {
    half /= 2
    rate = Math.round(half * 0x10000)
  }
  return rate
}

/** The rate field of an entry read from an MP4 (`soundRateField`), for which a rate that is none is `damaged` with the entry's type in the sentence. */
function isoRate(entry: SampleEntry, hertz: number): number {
  if (!isRate(hertz)) {
    throw damaged(`The '${entry.type}' sample description gives a sample rate of ${hertz}.`)
  }
  return soundRateField(hertz)
}

/**
 * The entry that goes in an init segment (`stsd`) for a track's description.
 * It is the entry's own bytes, as the view `readMovie` gave, for a picture and
 * for an ISO version 0 sound entry (in an `stsd` of version 0) whose
 * configuration box is directly inside it. MPEG-2 AAC is the exception: Chrome's
 * Media Source takes the name `mp4a.67` and then refuses an `esds` that says
 * MPEG-2 AAC, so the entry is carried with that one byte, the objectTypeIndication,
 * set to MPEG-4 audio's 0x40 (the stream is the same AAC, as its
 * AudioSpecificConfig shows, and is named `mp4a.40.N` and no other); the bytes given
 * are never changed, the entry written is a copy. Any other sound entry, which Chrome's
 * and Firefox's Media Source don't take (QuickTime's version 1 or 2, ISO's
 * version 1, one with its configuration inside a `wave` box, or QuickTime's
 * `.mp3`), is written as an ISO version 0 one: the same type (`.mp3` becomes
 * `mp4a`), data reference index 1, the channels, 16 bits to a sample, and the
 * rate in 16.16 as `isoRate` makes it; then the codec's configuration box (for
 * `.mp3`, a made `esds`) and, in their order, the entry's other boxes (a
 * `chan`, a `btrt`), but not the `wave`, the `srat` or a second configuration
 * box. It is `damaged` when a box of the entry can't be read, or when the
 * channels or the rate are 0 (or the rate isn't a number). An entry that
 * `codecNames` refuses is refused here for the same reason, so that what is
 * carried is always what was asked about.
 */
export function initEntry(entry: SampleEntry): Uint8Array {
  codecNames(entry)
  const configType = audioConfigType(entry.type)
  if (configType === null) return entry.bytes
  const audio = readAudioEntry(entry)
  // QuickTime's MP3 has no configuration box to find; the one it is given is made.
  const found = entry.type === '.mp3' ? null : findAudioBox(entry, audio.inside, configType)
  // Where the object type of an `esds` that says MPEG-2 AAC is, to be written as MPEG-4 audio's.
  const mpeg2At = found && entry.type === 'mp4a' ? mpeg2AacTypeAt(entry.bytes, found.box) : null
  if (audio.version === 0 && entry.stsdVersion === 0 && found?.direct) {
    if (mpeg2At === null) return entry.bytes
    // A copy made with `new Uint8Array`: the `slice` of a Node Buffer is a view of its bytes, and the byte written would change the caller's.
    const copy = new Uint8Array(entry.bytes)
    copy[mpeg2At] = MPEG4_AUDIO
    return copy
  }

  const rate = isoRate(entry, audio.sampleRate)
  if (audio.channels === 0 || audio.channels > 0xffff) {
    throw damaged(`The '${entry.type}' sample description gives ${audio.channels} channels.`)
  }
  // The configuration, then what else the entry holds, as it was: the `wave` is what the configuration may have come out of, the `srat` has been read, and any other box of the configuration's type would be a second.
  const others = childBoxes(entry.bytes, audio.inside.body, audio.inside.end)
    .filter((other) => other.type !== 'wave' && other.type !== 'srat' && other.type !== configType)
    .map((other) => entry.bytes.subarray(other.start, other.end))
  let config = found ? entry.bytes.subarray(found.box.start, found.box.end) : mp3Esds()
  if (found && mpeg2At !== null) {
    // Copied for the same reason as above, whatever kind of bytes `entry.bytes` is.
    config = new Uint8Array(config)
    config[mpeg2At - found.box.start] = MPEG4_AUDIO
  }
  const type = entry.type === '.mp3' ? 'mp4a' : entry.type
  return soundEntry(type, audio.channels, rate, [config, ...others])
}
