import { Mp4Error } from '../errors.ts'
import { ID } from './ids.ts'

// EBML, the container that Matroska and WebM are written in (RFC 8794, DESIGN.md
// §10.4): an element is an ID of 1 to 4 bytes, a size of 1 to 8 bytes and then
// that many bytes of data. Everything here is checked against the range it was
// given, so an element that claims more than is there, or a number wider than a
// number holds exactly, is a damaged file (`Mp4Error`) and never a wrong number
// or an exception of the language's own.

/**
 * An element in a buffer: its ID, where its header starts, where its data
 * starts and where it ends (exclusive). All are offsets in the bytes the
 * header was read from. `sized` is false for an element of unknown size, which
 * only a Segment or a Cluster may be: its `end` is then the limit it was read
 * with, which is not where the element ends but all that is known of it.
 */
export interface Element {
  id: number
  start: number
  data: number
  end: number
  sized: boolean
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** Refuses a range that isn't inside `bytes`, which only a caller that miscounted can ask for. */
function checkRange(bytes: Uint8Array, from: number, to: number): void {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from > to ||
    to > bytes.length
  ) {
    throw new Mp4Error(
      'damaged',
      `The range from ${from} to ${to} is not inside the ${bytes.length} bytes that were read.`,
    )
  }
}

/** Refuses an element whose data isn't inside `bytes`, and gives that width. */
function dataWidth(bytes: Uint8Array, el: Element): number {
  checkRange(bytes, el.data, el.end)
  return el.end - el.data
}

/** How many bytes an ID or a size takes, from its first byte, which must not be 0: the leading 0 bits, and one. */
function widthOf(first: number): number {
  return Math.clz32(first) - 23
}

/**
 * The header of the element at `at`, read from [at, limit) of `bytes`: null
 * when the header (its ID and its size) isn't whole before `limit`, so that a
 * caller with more bytes to come can read again. A header that is malformed is
 * a damaged file even next to `limit`, once the bytes that show it are there:
 * an ID wider than 4 bytes (a first byte below 0x10), a size wider than 8 (a
 * first byte of 0) or a size above 2^53 - 1. A size whose value bits are all 1
 * is no size at all but "unknown" (`sized: false`, ending at `limit`); any other
 * size may end past `limit`, which is for the caller to decide.
 */
export function readHeader(bytes: Uint8Array, at: number, limit: number): Element | null {
  checkRange(bytes, at, limit)
  if (at === limit) return null

  const firstId = bytes[at] ?? 0
  if (firstId < 0x10) {
    throw new Mp4Error(
      'damaged',
      `The element at offset ${at} has an ID wider than 4 bytes: its first byte is ${firstId}.`,
    )
  }
  const idWidth = widthOf(firstId)
  const sizeAt = at + idWidth
  if (sizeAt >= limit) return null

  const firstSize = bytes[sizeAt] ?? 0
  if (firstSize === 0) {
    throw new Mp4Error(
      'damaged',
      `The element at offset ${at} has a size wider than 8 bytes: its first byte is 0.`,
    )
  }
  const sizeWidth = widthOf(firstSize)
  const data = sizeAt + sizeWidth
  if (data > limit) return null

  let id = 0
  for (let i = at; i < sizeAt; i += 1) id = id * 256 + (bytes[i] ?? 0)

  // The marker bit gives the width and is not part of the value. A size whose
  // value bits are all 1 is the unknown one, which is told by the bytes
  // themselves: a number at 8 bytes could not tell it from the size below it.
  const valueMask = 0xff >> sizeWidth
  let unknown = (firstSize & valueMask) === valueMask
  let size = firstSize & valueMask
  for (let i = sizeAt + 1; i < data; i += 1) {
    const byte = bytes[i] ?? 0
    if (byte !== 0xff) unknown = false
    // Once above 2^53 - 1 it stays there, and a sum that is rounded is never
    // back below it, so the test after the loop is exact.
    size = size * 256 + byte
  }
  if (unknown) return { id, start: at, data, end: limit, sized: false }

  if (size > Number.MAX_SAFE_INTEGER || data + size > Number.MAX_SAFE_INTEGER) {
    throw new Mp4Error(
      'damaged',
      `The element at offset ${at} claims a size no file has: it would end beyond 2^53 - 1.`,
    )
  }
  return { id, start: at, data, end: data + size, sized: true }
}

/**
 * The elements directly inside `parent`, which must be whole in `bytes`, with
 * the CRC-32 and Void elements left out wherever they stand: the first is a
 * checksum and the second padding, and neither says anything about the file. A
 * child whose header is cut short by its parent, that runs past its parent or
 * that has an unknown size is a damaged file: only a Segment or a Cluster may be
 * of unknown size, and the walks of those two deal with it.
 */
export function children(bytes: Uint8Array, parent: Element): Element[] {
  checkRange(bytes, parent.data, parent.end)
  const found: Element[] = []
  let at = parent.data
  while (at < parent.end) {
    const el = readHeader(bytes, at, parent.end)
    if (el === null) {
      throw new Mp4Error(
        'damaged',
        `An element header at offset ${at} is cut short: ${parent.end - at} bytes are left in its parent.`,
      )
    }
    if (!el.sized) {
      throw new Mp4Error(
        'damaged',
        `The element at offset ${at} has an unknown size, which only a Segment or a Cluster may have.`,
      )
    }
    if (el.end > parent.end) {
      throw new Mp4Error(
        'damaged',
        `The element at offset ${at} claims ${el.end - el.data} bytes, but ${parent.end - el.data} are left in its parent.`,
      )
    }
    if (el.id !== ID.CRC32 && el.id !== ID.Void) found.push(el)
    at = el.end
  }
  return found
}

/**
 * An unsigned integer of 0 to 8 bytes, big-endian; 0 bytes is 0. Above
 * 2^53 - 1, which a number no longer holds exactly, or wider than 8 bytes, it is
 * a damaged file.
 */
export function readUint(bytes: Uint8Array, el: Element): number {
  const width = dataWidth(bytes, el)
  if (width > 8) {
    throw new Mp4Error(
      'damaged',
      `The integer at offset ${el.data} is ${width} bytes wide, where 8 are the most.`,
    )
  }
  let value = 0
  for (let i = el.data; i < el.end; i += 1) value = value * 256 + (bytes[i] ?? 0)
  // Once above 2^53 - 1 it stays there, and a sum that is rounded is never back
  // below it, so this test is exact.
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Mp4Error(
      'damaged',
      `The integer at offset ${el.data} is outside the range a number can hold exactly.`,
    )
  }
  return value
}

/**
 * A signed integer of 0 to 8 bytes, two's complement and big-endian; 0 bytes
 * is 0. Beyond 2^53 - 1 either way, or wider than 8 bytes, it is a damaged file.
 */
export function readInt(bytes: Uint8Array, el: Element): number {
  const width = dataWidth(bytes, el)
  if (width > 8) {
    throw new Mp4Error(
      'damaged',
      `The integer at offset ${el.data} is ${width} bytes wide, where 8 are the most.`,
    )
  }
  if (width === 0) return 0
  let unsigned = 0n
  for (let i = el.data; i < el.end; i += 1) unsigned = (unsigned << 8n) | BigInt(bytes[i] ?? 0)
  const value = BigInt.asIntN(8 * width, unsigned)
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    throw new Mp4Error(
      'damaged',
      `The integer at offset ${el.data} is outside the range a number can hold exactly.`,
    )
  }
  return Number(value)
}

/** A float of 4 or 8 bytes, big-endian; 0 bytes is 0. Any other width is a damaged file. */
export function readFloat(bytes: Uint8Array, el: Element): number {
  const width = dataWidth(bytes, el)
  if (width === 0) return 0
  if (width !== 4 && width !== 8) {
    throw new Mp4Error(
      'damaged',
      `The float at offset ${el.data} is ${width} bytes wide, where 0, 4 and 8 are the widths there are.`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.data, width)
  return width === 4 ? view.getFloat32(0) : view.getFloat64(0)
}

/**
 * The text of a string element: UTF-8 up to the first 0 byte, since a writer
 * may pad the element with them. Bytes that aren't UTF-8 become U+FFFD and are
 * not an error, as a name is something to show and never one to refuse a file
 * for.
 */
export function readString(bytes: Uint8Array, el: Element): string {
  checkRange(bytes, el.data, el.end)
  let end = el.data
  while (end < el.end && bytes[end] !== 0) end += 1
  return new TextDecoder('utf-8').decode(bytes.subarray(el.data, end))
}

/** The data of an element, as a view onto the same memory (not a copy). */
export function readBytes(bytes: Uint8Array, el: Element): Uint8Array {
  checkRange(bytes, el.data, el.end)
  return bytes.subarray(el.data, el.end)
}
