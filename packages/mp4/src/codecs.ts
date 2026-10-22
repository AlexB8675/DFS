import { child, firstBox, Reader } from './boxes.ts'
import type { Box } from './boxes.ts'
import { Mp4Error } from './errors.ts'
import type { SampleEntry } from './movie.ts'

// The name of each picture and sound codec as Media Source asks about it, and
// the sample entry an init segment carries (DESIGN.md §10.4, D45). The names are
// RFC 6381's, which `MediaSource.isTypeSupported` and `addSourceBuffer` take:
// `avc1.64001f`, `hvc1.2.4.L153.B0`, `av01.0.05M.08`, `mp4a.40.2`, `opus`. They
// are read from the codec's own configuration box, never guessed from the
// entry's type. What the player doesn't take is refused as
// `Mp4Error('unsupported-codec')`, with the type in the sentence; a
// configuration that is cut short or lies about its own sizes is `damaged`.
//
// QuickTime writes its sound entries in a form that Chrome's and Firefox's
// Media Source don't take (a version 1 or 2 entry, with the `esds` inside a
// `wave` box), so `initEntry` writes those as the ISO entry they stand for.

/** What a picture entry holds before its child boxes: the 8 bytes every entry has, then the 70 of a VisualSampleEntry (ISO/IEC 14496-12). */
const VISUAL_FIELDS = 78

/** What a sound entry holds before its child boxes in ISO's version 0, which is also QuickTime's: the 8 bytes every entry has, then 20. */
const AUDIO_FIELDS = 28

/** `objectTypeIndication` of MPEG-4 audio, the only one that has an `mp4a.40.N` string. */
const MPEG4_AUDIO = 0x40

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

/** The bytes inside a codec's configuration box in a picture entry, which the codec string is read from. */
function pictureConfig(entry: SampleEntry, type: string): Uint8Array {
  const whole = entryBox(entry)
  const config = child(entry.bytes, afterFields(entry, whole, VISUAL_FIELDS), type)
  if (!config) throw damaged(`The '${entry.type}' sample description has no '${type}' box.`)
  return entry.bytes.subarray(config.body, config.end)
}

/** `avc1.PPCCLL`: the profile, its compatibility flags and the level, which are bytes 1 to 3 of `avcC`, each as two lowercase hex digits. */
function avcString(entry: SampleEntry): string {
  const bits = new BitReader(pictureConfig(entry, 'avcC'), "'avcC' box")
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
  const bits = new BitReader(pictureConfig(entry, 'hvcC'), "'hvcC' box")
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
  const bits = new BitReader(pictureConfig(entry, 'av1C'), "'av1C' box")
  bits.read(8) // the marker and the version
  const profile = bits.read(3)
  const level = bits.read(5)
  const tier = bits.read(1)
  const high = bits.read(1)
  const twelve = bits.read(1)
  const depth = twelve ? 12 : high ? 10 : 8
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`
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

/** What `esds` says of the stream: the type of its object, and the AudioSpecificConfig when it has one. */
interface StreamConfig {
  objectType: number
  config: Descriptor | null
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
  const fields = new Reader(bytes, decoder.from, decoder.to)
  const objectType = fields.u8()
  fields.skip(12) // the stream's type, the size of its buffer, its highest and its average bit rate
  return { objectType, config: findDescriptor(bytes, fields.position, decoder.to, 0x05) }
}

/** The audio object type that begins an AudioSpecificConfig: 5 bits, where 31 says that it is 32 plus the next 6. */
function audioObjectType(bytes: Uint8Array, config: Descriptor): number {
  const bits = new BitReader(bytes.subarray(config.from, config.to), 'AudioSpecificConfig')
  const type = bits.read(5)
  return type === 31 ? 32 + bits.read(6) : type
}

/** What the fields of a sound entry say, and where its `esds` is. */
interface AudioEntry {
  /** QuickTime's version of the entry: 0, which ISO's is, or 1 or 2. */
  version: number
  channels: number
  /** In hertz. */
  sampleRate: number
  /** Where the entry's boxes start, as a box that `child` can look in. */
  inside: Box
}

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
  if (version > 2) throw damaged(`${sound} is version ${version}, and only 0, 1 and 2 are read.`)
  reader.skip(6) // revision and vendor
  let channels = reader.u16()
  reader.skip(6) // the size of a sample, the compression ID and the size of a packet
  let sampleRate = reader.u32() / 0x10000
  // Version 1 adds 16 bytes: samples per packet, bytes per packet, per frame and per sample.
  if (version === 1) reader.skip(16)
  // Version 2 adds 36.
  if (version === 2) {
    // The fields above say 3 channels and a rate of 1; the ones that count are these.
    reader.skip(4) // the size of the entry so far
    const rate = reader.bytes(8)
    sampleRate = new DataView(rate.buffer, rate.byteOffset, 8).getFloat64(0)
    channels = reader.u32()
    reader.skip(20) // 0x7F000000, the bits per channel, flags and the sizes of a packet
  }
  return { version, channels, sampleRate, inside: { ...whole, body: reader.position } }
}

/** The `esds` of a sound entry: its own, or the one inside the `wave` box that QuickTime keeps it in. */
function findEsds(entry: SampleEntry, inside: Box): { esds: Box; direct: boolean } {
  const direct = child(entry.bytes, inside, 'esds')
  if (direct) return { esds: direct, direct: true }
  const wrapper = child(entry.bytes, inside, 'wave')
  const wrapped = wrapper ? child(entry.bytes, wrapper, 'esds') : null
  if (!wrapped) throw damaged(`The '${entry.type}' sample description has no 'esds' box.`)
  return { esds: wrapped, direct: false }
}

function mp4aString(entry: SampleEntry): string {
  const { inside } = readAudioEntry(entry)
  const { esds } = findEsds(entry, inside)
  const { objectType, config } = readStream(entry.bytes, esds)
  if (objectType !== MPEG4_AUDIO) {
    throw unsupported(
      `The sound is of object type 0x${hex(objectType, 2)}, and only MPEG-4 audio (AAC) is a codec that the player takes.`,
    )
  }
  if (!config) {
    throw damaged(`The 'esds' box at offset ${esds.start} has no DecoderSpecificInfo.`)
  }
  return `mp4a.40.${audioObjectType(entry.bytes, config)}`
}

/**
 * The RFC 6381 string that Media Source is asked about for an entry, read from
 * its configuration. An entry of a codec the player doesn't take (PCM, MPEG-4
 * Visual, MP3, Dolby, anything that isn't H.264, H.265, AV1, AAC or Opus, and an
 * `mp4a` that isn't MPEG-4 audio) is refused as `unsupported-codec`; one whose
 * configuration is missing, cut short or lies about its sizes as `damaged`.
 */
export function codecString(entry: SampleEntry): string {
  switch (entry.type) {
    case 'avc1':
    case 'avc3':
      return avcString(entry)
    case 'hvc1':
    case 'hev1':
      return hevcString(entry)
    case 'av01':
      return av1String(entry)
    case 'mp4a':
      return mp4aString(entry)
    case 'Opus': {
      // The decoder is made from the `dOps`; without it there is nothing to play.
      const whole = entryBox(entry)
      if (!child(entry.bytes, afterFields(entry, whole, AUDIO_FIELDS), 'dOps')) {
        throw damaged(`The 'Opus' sample description has no 'dOps' box.`)
      }
      return 'opus'
    }
    default:
      throw unsupported(
        `The sample description '${entry.type}' is not a codec that the player takes.`,
      )
  }
}

/** An ISO version 0 `mp4a` for this many channels and this sample rate (16.16), followed by the `esds` box given. */
function isoMp4a(channels: number, rate: number, esds: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + AUDIO_FIELDS + esds.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  out.set([0x6d, 0x70, 0x34, 0x61], 4) // 'mp4a'; the 6 reserved bytes after it are 0
  view.setUint16(14, 1) // the data reference index: the one `dref` of an init segment
  // The version, the revision and the vendor are 0.
  view.setUint16(24, channels)
  view.setUint16(26, 16) // the size of a sample
  // The compression ID and the size of a packet are 0.
  view.setUint32(32, rate)
  out.set(esds, 8 + AUDIO_FIELDS)
  return out
}

/**
 * The entry that goes in an init segment (`stsd`) for a track's description:
 * the entry's own bytes, as the view `readMovie` gave, except a QuickTime sound
 * entry (an `mp4a` of version 1 or 2, or one whose `esds` is inside a `wave`
 * box), which Chrome's and Firefox's Media Source don't take and which is
 * written as an ISO version 0 `mp4a` that holds that `esds` and nothing else:
 * data reference index 1, the channels, 16 bits to a sample and the rate in
 * 16.16. A version 2 rate that doesn't fit in 16 bits is refused as
 * `unsupported-codec`. An entry that `codecString` refuses is refused here for
 * the same reason, so that what is carried is always what was asked about.
 */
export function initEntry(entry: SampleEntry): Uint8Array {
  codecString(entry)
  if (entry.type !== 'mp4a') return entry.bytes
  const audio = readAudioEntry(entry)
  const found = findEsds(entry, audio.inside)
  if (audio.version === 0 && found.direct) return entry.bytes

  // The rate in 16.16, as the entry has it in version 0 or 1, which is copied as it is; version 2 has a float to be put in the 16 bits ISO gives the whole part.
  const rate = Math.round(audio.sampleRate * 0x10000)
  if (audio.version === 2) {
    if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
      throw damaged(
        `The '${entry.type}' sample description gives a sample rate of ${audio.sampleRate}.`,
      )
    }
    if (rate > 0xffffffff) {
      throw unsupported(
        `The sound's sample rate of ${audio.sampleRate} Hz does not fit in the 16 bits that an ISO sound entry has for it.`,
      )
    }
  }
  if (audio.channels > 0xffff) {
    throw damaged(`The '${entry.type}' sample description gives ${audio.channels} channels.`)
  }
  return isoMp4a(audio.channels, rate, entry.bytes.subarray(found.esds.start, found.esds.end))
}
