import { ID } from '../matroska/ids.ts'
import { concat } from './build.ts'
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
