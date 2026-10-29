import { describe, expect, it } from 'vitest'
import { blockOf, blockSpan, blocksOf } from './blocks.ts'
import { BLOCK_BYTES } from './limits.ts'

// A play's bytes are counted in blocks of 1 MiB (DESIGN.md §10.4; the iron-clad
// spec §4.7): the unit of storage, of sealing and of eviction. These three
// functions turn an offset, a block and a range into one another.

describe('blockOf', () => {
  it('puts the first byte of a file in block 0', () => {
    expect(blockOf(0)).toBe(0)
  })

  it('keeps the last byte before a boundary in the block below it', () => {
    expect(blockOf(BLOCK_BYTES - 1)).toBe(0)
    expect(blockOf(BLOCK_BYTES)).toBe(1)
    expect(blockOf(2 * BLOCK_BYTES - 1)).toBe(1)
    expect(blockOf(2 * BLOCK_BYTES)).toBe(2)
  })

  it('counts offsets past 4 GiB without wrapping', () => {
    expect(blockOf(5 * 1024 ** 3)).toBe(5 * 1024)
  })

  it('refuses an offset that is negative or not a whole number', () => {
    expect(() => blockOf(-1)).toThrow(RangeError)
    expect(() => blockOf(1.5)).toThrow(RangeError)
    expect(() => blockOf(Number.NaN)).toThrow(RangeError)
    expect(() => blockOf(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('blockSpan', () => {
  it('spans a whole block of a file that has more after it', () => {
    expect(blockSpan(0, 10 * BLOCK_BYTES)).toEqual({ start: 0, end: BLOCK_BYTES })
    expect(blockSpan(3, 10 * BLOCK_BYTES)).toEqual({ start: 3 * BLOCK_BYTES, end: 4 * BLOCK_BYTES })
  })

  it('cuts the last block short at the end of the file', () => {
    expect(blockSpan(2, 2.5 * BLOCK_BYTES)).toEqual({
      start: 2 * BLOCK_BYTES,
      end: 2.5 * BLOCK_BYTES,
    })
  })

  it('keeps a last block that fills its block whole', () => {
    expect(blockSpan(1, 2 * BLOCK_BYTES)).toEqual({ start: BLOCK_BYTES, end: 2 * BLOCK_BYTES })
  })

  it('spans a file of one byte as a block of one byte', () => {
    expect(blockSpan(0, 1)).toEqual({ start: 0, end: 1 })
  })

  it('refuses an index at or past the end of the file', () => {
    expect(() => blockSpan(3, 2.5 * BLOCK_BYTES)).toThrow(RangeError)
    expect(() => blockSpan(2, 2 * BLOCK_BYTES)).toThrow(RangeError)
    expect(() => blockSpan(0, 0)).toThrow(RangeError)
  })

  it('refuses an index that is negative or not a whole number', () => {
    expect(() => blockSpan(-1, 10 * BLOCK_BYTES)).toThrow(RangeError)
    expect(() => blockSpan(1.5, 10 * BLOCK_BYTES)).toThrow(RangeError)
    expect(() => blockSpan(Number.NaN, 10 * BLOCK_BYTES)).toThrow(RangeError)
  })

  it('refuses a size that is negative or not a number', () => {
    expect(() => blockSpan(0, -1)).toThrow(RangeError)
    expect(() => blockSpan(0, Number.NaN)).toThrow(RangeError)
  })

  it('gives spans that follow one another to the end of the file with no gap and no overlap', () => {
    const size = 7 * BLOCK_BYTES + 12_345
    let next = 0
    for (let index = 0; index < 8; index += 1) {
      const span = blockSpan(index, size)
      expect(span.start).toBe(next)
      expect(blockOf(span.start)).toBe(index)
      expect(blockOf(span.end - 1)).toBe(index)
      next = span.end
    }
    expect(next).toBe(size)
  })
})

describe('blocksOf', () => {
  it('names the one block of a range inside it', () => {
    expect(blocksOf({ start: 0, end: 1 })).toEqual({ first: 0, last: 0 })
    expect(blocksOf({ start: 0, end: BLOCK_BYTES })).toEqual({ first: 0, last: 0 })
  })

  it('names the last block as the one that holds the last byte, not the end', () => {
    expect(blocksOf({ start: 0, end: BLOCK_BYTES + 1 })).toEqual({ first: 0, last: 1 })
    expect(blocksOf({ start: BLOCK_BYTES, end: 2 * BLOCK_BYTES })).toEqual({ first: 1, last: 1 })
  })

  it('names both blocks of a range that crosses a boundary', () => {
    expect(blocksOf({ start: BLOCK_BYTES - 1, end: BLOCK_BYTES + 1 })).toEqual({
      first: 0,
      last: 1,
    })
  })

  it('names every block of a long range', () => {
    expect(blocksOf({ start: 3 * BLOCK_BYTES + 5, end: 9 * BLOCK_BYTES })).toEqual({
      first: 3,
      last: 8,
    })
  })

  it('refuses an empty range', () => {
    expect(() => blocksOf({ start: 5, end: 5 })).toThrow(RangeError)
    expect(() => blocksOf({ start: 10, end: 5 })).toThrow(RangeError)
  })

  it('refuses a range with a negative or fractional end', () => {
    expect(() => blocksOf({ start: -1, end: 5 })).toThrow(RangeError)
    expect(() => blocksOf({ start: 0, end: 1.5 })).toThrow(RangeError)
    expect(() => blocksOf({ start: 0, end: Number.NaN })).toThrow(RangeError)
  })
})
