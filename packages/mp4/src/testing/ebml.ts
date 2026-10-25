import { concat } from './build.ts'
import type { Part } from './build.ts'

// A builder for the EBML the Matroska tests read, used by tests only (DESIGN.md
// §10.4): the elements are written out here, byte by byte, as RFC 8794 gives
// them, so the reader is checked against what the standard says and not against
// what it was written to read. Numbers are big-endian, as in a file. Later
// tasks add the Matroska shapes (the header, the Segment, tracks, clusters) on
// top of these.

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
