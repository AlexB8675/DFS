import { Mp4Error } from './errors.ts'

// The boxes of an MP4 or MOV, and a cursor to read what is inside one
// (DESIGN.md §10.4). Everything here is checked against the range it was given,
// so a box that claims more than is there, or a read past a box's end, is a
// damaged file (`Mp4Error`) and never a wrong number or an exception of the
// language's own.

/** A box in a buffer: its type, where its header starts, where its body starts and where it ends (exclusive). */
export interface Box {
  type: string
  start: number
  body: number
  end: number
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function fourccAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0,
  )
}

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

/**
 * The boxes directly inside [from, to) of `bytes`. A box of size 0 runs to
 * `to`; a box of size 1 has its size in the 8 bytes after its type. A header
 * that is cut short, a size smaller than its own header or a box that claims
 * more than the range holds is a damaged file.
 */
export function childBoxes(bytes: Uint8Array, from: number, to: number): Box[] {
  checkRange(bytes, from, to)
  const view = viewOf(bytes)
  const boxes: Box[] = []
  let at = from
  while (at < to) {
    if (to - at < 8) {
      throw new Mp4Error(
        'damaged',
        `A box header at offset ${at} is cut short: ${to - at} bytes are left where 8 are needed.`,
      )
    }
    const type = fourccAt(bytes, at + 4)
    let size = view.getUint32(at)
    let header = 8
    if (size === 1) {
      if (to - at < 16) {
        throw new Mp4Error(
          'damaged',
          `The header of the '${type}' box at offset ${at} is cut short: its 64-bit size is not all there.`,
        )
      }
      const wide = view.getBigUint64(at + 8)
      if (wide > MAX_SAFE) {
        throw new Mp4Error(
          'damaged',
          `The '${type}' box at offset ${at} claims a size no file has.`,
        )
      }
      size = Number(wide)
      header = 16
    } else if (size === 0) {
      size = to - at
    }
    if (size < header) {
      throw new Mp4Error(
        'damaged',
        `The '${type}' box at offset ${at} claims ${size} bytes, less than its own header.`,
      )
    }
    if (size > to - at) {
      throw new Mp4Error(
        'damaged',
        `The '${type}' box at offset ${at} claims ${size} bytes, but ${to - at} are left in its range.`,
      )
    }
    boxes.push({ type, start: at, body: at + header, end: at + size })
    at += size
  }
  return boxes
}

/** The first child of `parent` of a type, or null. */
export function child(bytes: Uint8Array, parent: Box, type: string): Box | null {
  return childBoxes(bytes, parent.body, parent.end).find((entry) => entry.type === type) ?? null
}

/**
 * A cursor over a range of `bytes`, normally a box's body. Every read is
 * checked against the range's end first, and one that doesn't fit throws
 * `Mp4Error('damaged')` without moving the cursor. Positions are offsets in
 * `bytes`, as a `Box`'s are.
 */
export class Reader {
  readonly #bytes: Uint8Array
  readonly #view: DataView
  readonly #to: number
  #at: number

  constructor(bytes: Uint8Array, from: number, to: number) {
    checkRange(bytes, from, to)
    this.#bytes = bytes
    this.#view = viewOf(bytes)
    this.#to = to
    this.#at = from
  }

  /** Where the next read starts. */
  get position(): number {
    return this.#at
  }

  /** How many bytes are left to read. */
  get remaining(): number {
    return this.#to - this.#at
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1))
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2))
  }

  u24(): number {
    const at = this.#take(3)
    return (this.#view.getUint16(at) << 8) | this.#view.getUint8(at + 2)
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4))
  }

  i16(): number {
    return this.#view.getInt16(this.#take(2))
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4))
  }

  /** 64-bit, refused as damaged above `Number.MAX_SAFE_INTEGER`. */
  u64(): number {
    const at = this.#take(8)
    const value = this.#view.getBigUint64(at)
    if (value > MAX_SAFE) this.#tooLarge(at)
    return Number(value)
  }

  /** Signed 64-bit, refused as damaged beyond `Number.MAX_SAFE_INTEGER` either way. */
  i64(): number {
    const at = this.#take(8)
    const value = this.#view.getBigInt64(at)
    if (value > MAX_SAFE || value < -MAX_SAFE) this.#tooLarge(at)
    return Number(value)
  }

  fourcc(): string {
    return fourccAt(this.#bytes, this.#take(4))
  }

  skip(bytes: number): void {
    this.#take(bytes)
  }

  /** The next `count` bytes, as a view onto the same memory (not a copy). */
  bytes(count: number): Uint8Array {
    const at = this.#take(count)
    return this.#bytes.subarray(at, at + count)
  }

  /** Moves past `count` bytes and returns where they started. */
  #take(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > this.#to - this.#at) {
      throw new Mp4Error(
        'damaged',
        `A read of ${count} bytes at offset ${this.#at} runs past the end of its box at ${this.#to}.`,
      )
    }
    const at = this.#at
    this.#at += count
    return at
  }

  #tooLarge(at: number): never {
    throw new Mp4Error('damaged', `The 64-bit number at offset ${at} is larger than any file's.`)
  }
}
