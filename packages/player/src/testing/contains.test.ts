import { describe, expect, it } from 'vitest'
import { indexOfRun } from './contains.ts'

// The at-rest checks look for a run of a file's bytes in what a browser keeps (DESIGN.md §10.4).

describe('indexOfRun', () => {
  it('finds a run where it is', () => {
    const haystack = Uint8Array.of(9, 9, 1, 2, 3, 4, 9)
    expect(indexOfRun(haystack, Uint8Array.of(1, 2, 3))).toBe(2)
    expect(indexOfRun(haystack, Uint8Array.of(9))).toBe(0)
    expect(indexOfRun(haystack, Uint8Array.of(4, 9))).toBe(5)
  })

  it('finds a run after a false start, and one that overlaps its own beginning', () => {
    expect(indexOfRun(Uint8Array.of(1, 2, 1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(2)
    expect(indexOfRun(Uint8Array.of(7, 7, 7, 8), Uint8Array.of(7, 7, 8))).toBe(1)
  })

  it('finds a run that ends at the last byte, and one that is all of the haystack', () => {
    expect(indexOfRun(Uint8Array.of(0, 5, 6), Uint8Array.of(5, 6))).toBe(1)
    expect(indexOfRun(Uint8Array.of(5, 6), Uint8Array.of(5, 6))).toBe(0)
  })

  it('is -1 when the run is not there, or the haystack is shorter, or the run has no bytes', () => {
    expect(indexOfRun(Uint8Array.of(1, 2, 3), Uint8Array.of(2, 4))).toBe(-1)
    expect(indexOfRun(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(-1)
    expect(indexOfRun(Uint8Array.of(1, 2), new Uint8Array(0))).toBe(-1)
  })
})
