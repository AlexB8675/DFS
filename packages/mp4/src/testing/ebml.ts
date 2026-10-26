import { ID } from '../matroska/ids.ts'
import { concat, i16 } from './build.ts'
import type { Part } from './build.ts'

// A builder for the EBML the Matroska tests read, used by tests only (DESIGN.md
// §10.4): the elements are written out here, byte by byte, as RFC 8794 gives
// them, so the reader is checked against what the standard says and not against
// what it was written to read. Numbers are big-endian, as in a file. The
// Matroska shapes (the header, the Segment, Info, the SeekHead and the layout of
// a whole file) are built on top of the elements; later tasks add the tracks and
// the clusters.

/** What an element is built from: bytes, or numbers that are bytes (the same as for a box). */
export type { Part }

/** The bytes of an unsigned number, big-endian, in `width` bytes. */
function bigEndian(value: bigint, width: number): number[] {
  const bytes: number[] = []
  for (let shift = 8 * (width - 1); shift >= 0; shift -= 8) {
    bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  }
  return bytes
}

/** An ID as a file writes it, 1 to 4 bytes, the first of which says how many by its leading 0 bits. */
export function idBytes(id: number): number[] {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new RangeError(`${id} is not an element ID.`)
  }
  const width = id < 0x100 ? 1 : id < 0x10000 ? 2 : id < 0x1000000 ? 3 : 4
  // A width of w bytes starts at 2^(7w), where its first byte's leading 0 bits are w - 1 and a 1 bit follows.
  if (id < 2 ** (7 * width)) throw new RangeError(`${id} is not an element ID.`)
  return bigEndian(BigInt(id), width)
}

/** Whether a size of `value` fits `width` bytes: 7 bits to the byte, and all 1 bits is the unknown size. */
function fits(value: bigint, width: number): boolean {
  return value >= 0n && value <= (1n << BigInt(7 * width)) - 2n
}

/**
 * A size as a file writes it: the length marker (a 1 bit after as many 0 bits
 * as the width less one), then the value. It is the fewest bytes that hold the
 * value, unless `width` says how many; a writer pads a size that way when it
 * will come back to fill it in.
 */
export function sizeBytes(value: number, width?: number): number[] {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${value} is not a size.`)
  const wide = BigInt(value)
  let bytes = width
  if (bytes === undefined) {
    bytes = 1
    while (bytes < 8 && !fits(wide, bytes)) bytes += 1
  }
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 8) {
    throw new RangeError(`A size is 1 to 8 bytes wide, not ${bytes}.`)
  }
  if (!fits(wide, bytes)) throw new RangeError(`${value} doesn't fit in a size of ${bytes} bytes.`)
  return bigEndian((1n << BigInt(7 * bytes)) | wide, bytes)
}

/** The size that says an element runs on to the end of what holds it: the marker, then all 1 bits. */
export function unknownSize(width = 8): number[] {
  if (!Number.isInteger(width) || width < 1 || width > 8) {
    throw new RangeError(`A size is 1 to 8 bytes wide, not ${width}.`)
  }
  const marker = 1n << BigInt(7 * width)
  return bigEndian(marker | (marker - 1n), width)
}

/** An element: its ID and its size, then the parts. */
export function element(id: number, ...parts: Part[]): Uint8Array {
  const body = concat(...parts)
  return concat(idBytes(id), sizeBytes(body.length), body)
}

/** An element with the size bytes it is given, which need not be the shortest, or the parts' length. */
export function elementSized(id: number, size: number[], ...parts: Part[]): Uint8Array {
  return concat(idBytes(id), size, ...parts)
}

/** An unsigned integer element, in the fewest whole bytes that hold it, and at least one. */
export function uint(id: number, value: number | bigint): Uint8Array {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new RangeError(`${value} is not an integer.`)
  }
  const wide = BigInt(value)
  if (wide < 0n || wide >= 1n << 64n) {
    throw new RangeError(`${value} doesn't fit in 8 bytes, unsigned.`)
  }
  let width = 1
  while (wide >= 1n << BigInt(8 * width)) width += 1
  return element(id, bigEndian(wide, width))
}

/** A signed integer element, in the fewest whole bytes that hold it in two's complement, and at least one. */
export function int(id: number, value: number | bigint): Uint8Array {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new RangeError(`${value} is not an integer.`)
  }
  const wide = BigInt(value)
  if (wide < -(1n << 63n) || wide >= 1n << 63n) {
    throw new RangeError(`${value} doesn't fit in 8 bytes, signed.`)
  }
  let width = 1
  while (wide < -(1n << BigInt(8 * width - 1)) || wide >= 1n << BigInt(8 * width - 1)) width += 1
  return element(id, bigEndian(BigInt.asUintN(8 * width, wide), width))
}

/** A float element of 4 bytes or 8. */
export function float(id: number, value: number, width: 4 | 8 = 8): Uint8Array {
  const body = new Uint8Array(width)
  const view = new DataView(body.buffer)
  if (width === 4) view.setFloat32(0, value)
  else view.setFloat64(0, value)
  return element(id, body)
}

/** A string element: the text as UTF-8, with no 0 byte of its own (a test adds the padding it wants). */
export function string(id: number, text: string): Uint8Array {
  return element(id, new TextEncoder().encode(text))
}

/** A binary element: the bytes as they are. */
export function binary(id: number, bytes: Part): Uint8Array {
  return element(id, bytes)
}

/** The IDs of two header elements that the reader never looks at, which the builder writes as a real file has them. */
const EBML_VERSION = 0x4286
const DOC_TYPE_VERSION = 0x4287

/**
 * The EBML header of a file, as ffmpeg writes it: version 1, read version 1, an
 * ID of 4 bytes at most and a size of 8, then the DocType, the DocType's version
 * (4) and its read version, which is 2 unless asked for.
 */
export function ebmlHeader({
  docType = 'matroska',
  readVersion = 2,
}: { docType?: string; readVersion?: number } = {}): Uint8Array {
  return element(
    ID.EBML,
    uint(EBML_VERSION, 1),
    uint(ID.EBMLReadVersion, 1),
    uint(ID.EBMLMaxIDLength, 4),
    uint(ID.EBMLMaxSizeLength, 8),
    string(ID.DocType, docType),
    uint(DOC_TYPE_VERSION, 4),
    uint(ID.DocTypeReadVersion, readVersion),
  )
}

/**
 * One entry of a SeekHead: the ID of an element and where it is, counted from
 * the start of the Segment's data. The position is always 8 bytes wide, as a
 * writer that comes back to fill it in writes it, so that the SeekHead is as
 * long whatever the positions are, which a layout needs to know them.
 */
export function seekEntry(id: number, position: number): Uint8Array {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RangeError(`${position} is not a position.`)
  }
  return element(
    ID.Seek,
    binary(ID.SeekID, idBytes(id)),
    element(ID.SeekPosition, bigEndian(BigInt(position), 8)),
  )
}

/** A SeekHead of the entries given, each an element's ID and its position from the Segment's data. */
export function seekHead(entries: [id: number, position: number][]): Uint8Array {
  return element(ID.SeekHead, ...entries.map(([id, position]) => seekEntry(id, position)))
}

/** Info with the TimestampScale and the Duration (in ticks) that it is given, and with none of them left out when they are not. */
export function info({ scale, duration }: { scale?: number; duration?: number }): Uint8Array {
  const parts: Uint8Array[] = []
  if (scale !== undefined) parts.push(uint(ID.TimestampScale, scale))
  if (duration !== undefined) parts.push(float(ID.Duration, duration))
  return element(ID.Info, ...parts)
}

/** A Segment around its children, of the size they add up to or, with `unknown`, of unknown size, as a recording that is still being written has it. */
export function segment(
  children: Uint8Array[],
  { unknown = false }: { unknown?: boolean } = {},
): Uint8Array {
  return unknown
    ? elementSized(ID.Segment, unknownSize(), ...children)
    : element(ID.Segment, ...children)
}

/** A part of a file's Segment: its bytes, or a function of where every part starts (from the Segment's data) that gives them. */
export type FilePart = Uint8Array | ((positions: number[]) => Uint8Array)

/** A file laid out: its bytes, the offset of each part in the file, and the offset where the Segment's data starts. */
export interface MatroskaFile {
  bytes: Uint8Array
  offsets: number[]
  segmentData: number
}

/**
 * A file of the EBML header (`header`, a Matroska one unless given) and a
 * Segment of the parts, one after the other, with the offset of each part in the
 * file, so that a test can name exact positions. A part may be a function of the
 * positions of all the parts from the Segment's data (what a SeekHead holds),
 * which is called twice, once to measure and once with the real positions, and
 * must give as many bytes each time.
 */
export function matroskaFile(
  parts: FilePart[],
  { header = ebmlHeader(), unknown = false }: { header?: Uint8Array; unknown?: boolean } = {},
): MatroskaFile {
  const measured = parts.map((part) =>
    typeof part === 'function' ? part(parts.map(() => 0)) : part,
  )
  const positions: number[] = []
  let at = 0
  for (const part of measured) {
    positions.push(at)
    at += part.length
  }
  const children = parts.map((part, index) => {
    if (typeof part !== 'function') return part
    const bytes = part(positions)
    if (bytes.length !== measured[index]?.length) {
      throw new RangeError(`Part ${index} is not as long with the real positions as without them.`)
    }
    return bytes
  })
  const whole = segment(children, { unknown })
  const segmentData = header.length + (whole.length - at)
  return {
    bytes: concat(header, whole),
    offsets: positions.map((position) => segmentData + position),
    segmentData,
  }
}

/** The nine fields of a Colour element, named as the reader names them, each written as the unsigned integer it is. */
export interface ColourSpec {
  matrix?: number
  primaries?: number
  transfer?: number
  range?: number
  bitsPerChannel?: number
  chromaSubsamplingHorz?: number
  chromaSubsamplingVert?: number
  chromaSitingHorz?: number
  chromaSitingVert?: number
}

/** A track's Video element: the sizes are unsigned integers, `rollDegrees` is the float of a ProjectionPoseRoll in a Projection, and an empty `colour` is an empty Colour element. */
export interface VideoSpec {
  pixelWidth?: number
  pixelHeight?: number
  displayWidth?: number
  displayHeight?: number
  displayUnit?: number
  colour?: ColourSpec
  rollDegrees?: number
}

/** A track's Audio element: the two frequencies are floats, the rest unsigned integers. */
export interface AudioSpec {
  samplingFrequency?: number
  outputSamplingFrequency?: number
  channels?: number
  bitDepth?: number
}

/**
 * One ContentEncoding. `compression` is a ContentCompression, which is empty
 * (so that its algorithm is the default) when it is `{}`; `encryption` is a
 * ContentEncryption, of the AES algorithm.
 */
export interface EncodingSpec {
  scope?: number
  type?: number
  compression?: { algo?: number; settings?: Uint8Array }
  encryption?: boolean
}

/**
 * A TrackEntry's fields, each written as the element RFC 9559 gives it and left
 * out when not given, so that a test can leave out what the reader defaults or
 * refuses. `type` is the TrackType (1 for a picture, 2 for a sound, 17 for
 * subtitles). `encodings` is the ContentEncodings: absent when undefined, empty
 * when `[]`. `extra` is whole elements written last, after all of these, so that
 * a test can put a child that is broken, or one the reader doesn't know, behind them.
 */
export interface TrackSpec {
  number?: number
  type?: number
  enabled?: boolean
  default?: boolean
  forced?: boolean
  language?: string
  codecId?: string
  codecPrivate?: Uint8Array
  codecDelay?: number
  seekPreRoll?: number
  defaultDuration?: number
  timestampScale?: number
  video?: VideoSpec
  audio?: AudioSpec
  encodings?: EncodingSpec[]
  blockAdditions?: { type?: number; extraData?: Uint8Array }[]
  extra?: Uint8Array[]
}

/** The IDs of elements that a real file's tracks hold and the reader never looks at, which the builder writes as a file has them. */
const TRACK_UID = 0x73c5
const PROJECTION_TYPE = 0x7671
const CONTENT_ENCODING_ORDER = 0x5031
const CONTENT_ENC_ALGO = 0x47e1

/** An unsigned integer element for each field of `values` that is given, in the order of `ids`. */
function uints<Key extends string>(
  ids: readonly (readonly [Key, number])[],
  values: Partial<Record<Key, number>>,
): Uint8Array[] {
  const parts: Uint8Array[] = []
  for (const [key, id] of ids) {
    const value = values[key]
    if (value !== undefined) parts.push(uint(id, value))
  }
  return parts
}

function colourElement(spec: ColourSpec): Uint8Array {
  return element(
    ID.Colour,
    ...uints(
      [
        ['matrix', ID.MatrixCoefficients],
        ['bitsPerChannel', ID.BitsPerChannel],
        ['chromaSubsamplingHorz', ID.ChromaSubsamplingHorz],
        ['chromaSubsamplingVert', ID.ChromaSubsamplingVert],
        ['chromaSitingHorz', ID.ChromaSitingHorz],
        ['chromaSitingVert', ID.ChromaSitingVert],
        ['range', ID.Range],
        ['transfer', ID.TransferCharacteristics],
        ['primaries', ID.Primaries],
      ],
      spec,
    ),
  )
}

function videoElement(spec: VideoSpec): Uint8Array {
  const parts = uints(
    [
      ['pixelWidth', ID.PixelWidth],
      ['pixelHeight', ID.PixelHeight],
      ['displayWidth', ID.DisplayWidth],
      ['displayHeight', ID.DisplayHeight],
      ['displayUnit', ID.DisplayUnit],
    ],
    spec,
  )
  if (spec.colour !== undefined) parts.push(colourElement(spec.colour))
  if (spec.rollDegrees !== undefined) {
    parts.push(
      element(
        ID.Projection,
        uint(PROJECTION_TYPE, 0),
        float(ID.ProjectionPoseRoll, spec.rollDegrees),
      ),
    )
  }
  return element(ID.Video, ...parts)
}

function audioElement(spec: AudioSpec): Uint8Array {
  const parts: Uint8Array[] = []
  if (spec.samplingFrequency !== undefined) {
    parts.push(float(ID.SamplingFrequency, spec.samplingFrequency))
  }
  if (spec.outputSamplingFrequency !== undefined) {
    parts.push(float(ID.OutputSamplingFrequency, spec.outputSamplingFrequency))
  }
  if (spec.channels !== undefined) parts.push(uint(ID.Channels, spec.channels))
  if (spec.bitDepth !== undefined) parts.push(uint(ID.BitDepth, spec.bitDepth))
  return element(ID.Audio, ...parts)
}

function encodingElement(spec: EncodingSpec, order: number): Uint8Array {
  const parts: Uint8Array[] = [uint(CONTENT_ENCODING_ORDER, order)]
  if (spec.scope !== undefined) parts.push(uint(ID.ContentEncodingScope, spec.scope))
  if (spec.type !== undefined) parts.push(uint(ID.ContentEncodingType, spec.type))
  if (spec.compression !== undefined) {
    const { algo, settings } = spec.compression
    const fields: Uint8Array[] = []
    if (algo !== undefined) fields.push(uint(ID.ContentCompAlgo, algo))
    if (settings !== undefined) fields.push(binary(ID.ContentCompSettings, settings))
    parts.push(element(ID.ContentCompression, ...fields))
  }
  if (spec.encryption === true) {
    parts.push(element(ID.ContentEncryption, uint(CONTENT_ENC_ALGO, 5)))
  }
  return element(ID.ContentEncoding, ...parts)
}

/**
 * A TrackEntry of the fields it is given, written in the order a real file has
 * them: the number (and the UID that goes with it), the type, the flags, the
 * track's own settings, its codec and its encodings, then the extra data of its
 * codec, the Video or Audio element and the extra elements.
 */
export function trackEntry(spec: TrackSpec): Uint8Array {
  const parts: Uint8Array[] = []
  if (spec.number !== undefined) {
    parts.push(uint(ID.TrackNumber, spec.number), uint(TRACK_UID, spec.number))
  }
  if (spec.type !== undefined) parts.push(uint(ID.TrackType, spec.type))
  if (spec.enabled !== undefined) parts.push(uint(ID.FlagEnabled, spec.enabled ? 1 : 0))
  if (spec.default !== undefined) parts.push(uint(ID.FlagDefault, spec.default ? 1 : 0))
  if (spec.forced !== undefined) parts.push(uint(ID.FlagForced, spec.forced ? 1 : 0))
  if (spec.defaultDuration !== undefined) {
    parts.push(uint(ID.DefaultDuration, spec.defaultDuration))
  }
  if (spec.timestampScale !== undefined) {
    parts.push(float(ID.TrackTimestampScale, spec.timestampScale))
  }
  if (spec.language !== undefined) parts.push(string(ID.Language, spec.language))
  if (spec.codecId !== undefined) parts.push(string(ID.CodecID, spec.codecId))
  if (spec.codecPrivate !== undefined) parts.push(binary(ID.CodecPrivate, spec.codecPrivate))
  if (spec.codecDelay !== undefined) parts.push(uint(ID.CodecDelay, spec.codecDelay))
  if (spec.seekPreRoll !== undefined) parts.push(uint(ID.SeekPreRoll, spec.seekPreRoll))
  if (spec.encodings !== undefined) {
    parts.push(
      element(
        ID.ContentEncodings,
        ...spec.encodings.map((encoding, order) => encodingElement(encoding, order)),
      ),
    )
  }
  for (const addition of spec.blockAdditions ?? []) {
    const fields: Uint8Array[] = []
    if (addition.type !== undefined) fields.push(uint(ID.BlockAddIDType, addition.type))
    if (addition.extraData !== undefined) {
      fields.push(binary(ID.BlockAddIDExtraData, addition.extraData))
    }
    parts.push(element(ID.BlockAdditionMapping, ...fields))
  }
  if (spec.video !== undefined) parts.push(videoElement(spec.video))
  if (spec.audio !== undefined) parts.push(audioElement(spec.audio))
  parts.push(...(spec.extra ?? []))
  return element(ID.TrackEntry, ...parts)
}

/** A Tracks element around the entries (a TrackEntry from `trackEntry`, or any bytes a test wants in its place). */
export function tracksElement(entries: Uint8Array[]): Uint8Array {
  return element(ID.Tracks, ...entries)
}

/** The three ways a block can lace its frames (RFC 9559 §10.3): Xiph's, EBML's and fixed-size. */
export type Lacing = 'xiph' | 'ebml' | 'fixed'

/** What a block holds: its track, its timecode (signed 16 bits, from its cluster's), and its frames, which are laced when `lacing` says how. */
export interface BlockSpec {
  track: number
  timecode: number
  lacing?: Lacing
  frames: Part[]
}

/** What the flags byte of a block says of its lacing, in bits 0x06: Xiph 01, fixed-size 10 and EBML 11. */
const LACING_FLAGS: Record<Lacing, number> = { xiph: 0x02, fixed: 0x04, ebml: 0x06 }

/** A frame's size in Xiph lacing: as many bytes of 255 as it holds, then the rest (below 255), so that a size is told by its last byte. */
function xiphSize(size: number): number[] {
  return [...new Array<number>(Math.floor(size / 255)).fill(255), size % 255]
}

/**
 * A size, in EBML lacing, that follows another: the difference as a vint of
 * the fewest bytes that hold it, the value being offset by 2^(7n - 1) - 1 so that
 * a negative difference is a positive number (an all-1 value is left unused, as
 * for a size).
 */
function ebmlDifference(difference: number): number[] {
  for (let width = 1; width <= 7; width += 1) {
    const offset = 2 ** (7 * width - 1) - 1
    if (Math.abs(difference) <= offset) return sizeBytes(difference + offset, width)
  }
  throw new RangeError(`${difference} is a difference too wide for a test's block.`)
}

/** The body of a block: the track as a vint, the timecode, the flags, and for a laced block the count less 1 and the sizes of all frames but the last, then the frames. */
function blockBody({ track, timecode, lacing, frames }: BlockSpec, flags: number): Uint8Array {
  if (frames.length === 0) throw new RangeError('A block holds at least one frame.')
  const head = [...sizeBytes(track), ...i16(timecode), flags | (lacing ? LACING_FLAGS[lacing] : 0)]
  if (lacing === undefined) {
    if (frames.length !== 1) throw new RangeError('A block with no lacing holds one frame.')
    return concat(head, ...frames)
  }
  if (frames.length > 256) throw new RangeError('A lace holds 256 frames at most.')
  const sizes = frames.map((frame) => frame.length)
  const stored = sizes.slice(0, -1)
  let laced: number[] = []
  if (lacing === 'xiph') {
    laced = stored.flatMap((size) => xiphSize(size))
  } else if (lacing === 'ebml') {
    laced = stored.flatMap((size, index) =>
      index === 0 ? sizeBytes(size) : ebmlDifference(size - (stored[index - 1] ?? 0)),
    )
  } else if (sizes.some((size) => size !== sizes[0])) {
    throw new RangeError('The frames of fixed-size lacing are all of one size.')
  }
  return concat(head, [frames.length - 1], laced, ...frames)
}

/** A SimpleBlock: the block's body, with the keyframe flag (0x80) when `keyframe`. */
export function simpleBlock({
  keyframe = false,
  ...spec
}: BlockSpec & { keyframe?: boolean }): Uint8Array {
  return element(ID.SimpleBlock, blockBody(spec, keyframe ? 0x80 : 0))
}

/**
 * A BlockGroup: a Block (whose flags carry the lacing and no keyframe, as a
 * BlockGroup's keyframe is told by its having no reference), then the BlockDuration
 * and the ReferenceBlock (a signed number of ticks, from this block to the one it
 * refers to) when given them.
 */
export function blockGroup({
  reference,
  duration,
  ...spec
}: BlockSpec & { reference?: number; duration?: number }): Uint8Array {
  return element(
    ID.BlockGroup,
    element(ID.Block, blockBody(spec, 0)),
    ...(duration === undefined ? [] : [uint(ID.BlockDuration, duration)]),
    ...(reference === undefined ? [] : [int(ID.ReferenceBlock, reference)]),
  )
}

/** The table of the CRC-32 that zlib and Matroska use (the polynomial 0xEDB88320, reflected): the remainder of each byte. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let remainder = byte
  for (let bit = 0; bit < 8; bit += 1) {
    remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1
  }
  return remainder >>> 0
})

/** The CRC-32 of `bytes`, as an unsigned number. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * A Cluster: the Timestamp (in ticks, in the fewest bytes that hold it) and then
 * the children, which are blocks and whatever else a test wants in the cluster.
 * With `crc` the CRC-32 comes first, as ffmpeg writes it, over everything after it
 * and little-endian, as RFC 9559 gives it. With `unknown` the size is the unknown
 * one, which a writer that is still writing leaves. The two may be given together,
 * for a test that wants both.
 */
export function cluster(
  timestamp: number,
  children: Uint8Array[],
  { unknown = false, crc = false }: { unknown?: boolean; crc?: boolean } = {},
): Uint8Array {
  const body = concat(uint(ID.Timestamp, timestamp), ...children)
  const sum = crc32(body)
  const data = crc
    ? concat(
        element(ID.CRC32, [sum & 0xff, (sum >>> 8) & 0xff, (sum >>> 16) & 0xff, sum >>> 24]),
        body,
      )
    : body
  return unknown ? elementSized(ID.Cluster, unknownSize(), data) : element(ID.Cluster, data)
}
