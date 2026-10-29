// A play's bytes counted in blocks (DESIGN.md §10.4; the iron-clad spec §4.7). The
// store seals, keeps and evicts whole blocks of `BLOCK_BYTES`, so every part of the
// store that meets a byte of the file turns it into a block through these three
// functions, and none does the arithmetic itself. The module is pure.

import type { ByteRange } from '@dfs/mp4'
import { BLOCK_BYTES } from './limits.ts'

/** The block that holds the byte at `offset` of the file. An offset that is negative or not a whole number is a `RangeError`. */
export function blockOf(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`the offset ${offset} is not a position in a file`)
  }
  return Math.floor(offset / BLOCK_BYTES)
}

/**
 * The bytes that block `index` covers in a file of `fileSize` bytes. Every block is
 * `BLOCK_BYTES` long but the last, which ends where the file does. A block at or past
 * the end of the file, or an index that is negative or not a whole number, is a
 * `RangeError`.
 */
export function blockSpan(index: number, fileSize: number): ByteRange {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`${index} is not the index of a block`)
  }
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`${fileSize} is not the size of a file`)
  }
  const start = index * BLOCK_BYTES
  if (start >= fileSize) {
    throw new RangeError(
      `block ${index} starts at ${start}, at or past the end of a file of ${fileSize} bytes`,
    )
  }
  return { start, end: Math.min(start + BLOCK_BYTES, fileSize) }
}

/**
 * The first and the last block that a range touches, the last being the one that
 * holds the range's last byte (and not the one that holds its `end`, which is
 * outside it). An empty range touches no block, so it is a `RangeError`, as is one
 * with a bound that is negative or not a whole number.
 */
export function blocksOf(range: ByteRange): { first: number; last: number } {
  if (range.end <= range.start) {
    throw new RangeError(`the range ${range.start} to ${range.end} is empty`)
  }
  return { first: blockOf(range.start), last: blockOf(range.end - 1) }
}
