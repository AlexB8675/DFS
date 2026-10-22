// A builder for the boxes the tests read, used by tests only (DESIGN.md §10.4):
// the boxes are written out here, byte by byte, so the reader is checked
// against what the standard says and not against what it was written to read.
// Numbers are big-endian, as in a file.

/** What a box is built from: bytes, or numbers that are bytes. */
export type Part = Uint8Array | number[]

function big(value: number | bigint, bits: number, signed: boolean): number[] {
  const wide = BigInt(value)
  const limit = 1n << BigInt(bits)
  const [low, high] = signed ? [-(limit >> 1n), limit >> 1n] : [0n, limit]
  if (wide < low || wide >= high) {
    throw new RangeError(`${value} doesn't fit in ${bits} bits${signed ? ', signed' : ''}.`)
  }
  const unsigned = BigInt.asUintN(bits, wide)
  const bytes: number[] = []
  for (let shift = bits - 8; shift >= 0; shift -= 8) {
    bytes.push(Number((unsigned >> BigInt(shift)) & 0xffn))
  }
  return bytes
}

export function u16(value: number): number[] {
  return big(value, 16, false)
}

export function i16(value: number): number[] {
  return big(value, 16, true)
}

export function u32(value: number): number[] {
  return big(value, 32, false)
}

export function i32(value: number): number[] {
  return big(value, 32, true)
}

export function u64(value: number | bigint): number[] {
  return big(value, 64, false)
}

export function i64(value: number | bigint): number[] {
  return big(value, 64, true)
}

/** A box type or other four-character code, as its 4 bytes. */
export function fourcc(code: string): number[] {
  if (code.length !== 4) throw new RangeError(`'${code}' is not four characters.`)
  return Array.from(code, (letter) => letter.charCodeAt(0))
}

export function concat(...parts: Part[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A box: its size and type, then the parts. */
export function box(type: string, ...parts: Part[]): Uint8Array {
  const body = concat(...parts)
  return concat(u32(8 + body.length), fourcc(type), body)
}

/** A box that starts with a version byte and 24 bits of flags. */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Part[]
): Uint8Array {
  return box(type, [version], big(flags, 24, false), ...parts)
}
