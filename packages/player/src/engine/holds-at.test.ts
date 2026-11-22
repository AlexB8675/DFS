import { describe, expect, it } from 'vitest'
import { GAP_EDGE_SECONDS } from '../limits.ts'
import { holdingRange, holdsAt } from './holds-at.ts'

// Whether a track's buffered ranges hold a playhead (DESIGN.md §10.4): the rule for a seek being inside the window.

describe('holdsAt', () => {
  it('holds a time inside a range with room ahead', () => {
    expect(holdsAt([[0, 10]], 4, false)).toBe(true)
  })

  it('does not hold the last stretch of a range that is not the end of the file: the room ahead is required', () => {
    expect(holdsAt([[0, 10]], 10 - GAP_EDGE_SECONDS / 2, false)).toBe(false)
    expect(holdsAt([[0, 10]], 10, false)).toBe(false)
  })

  it('holds a time a little before a range starts, by the edge', () => {
    expect(holdsAt([[5, 10]], 5 - GAP_EDGE_SECONDS / 2, false)).toBe(true)
    expect(holdsAt([[5, 10]], 5 - GAP_EDGE_SECONDS * 2, false)).toBe(false)
  })

  it('holds the end of the last range when the feed is done', () => {
    expect(holdsAt([[0, 10]], 10, true)).toBe(true)
    expect(holdsAt([[0, 10]], 10 + GAP_EDGE_SECONDS / 2, true)).toBe(true)
  })

  it('does not hold a time past the last range by more than the edge, even when the feed is done', () => {
    expect(holdsAt([[0, 10]], 10 + GAP_EDGE_SECONDS * 2, true)).toBe(false)
  })

  it('does not hold the end of a range that has another after it, even when the feed is done', () => {
    expect(
      holdsAt(
        [
          [0, 4],
          [8, 12],
        ],
        4,
        true,
      ),
    ).toBe(false)
    expect(
      holdsAt(
        [
          [0, 4],
          [8, 12],
        ],
        6,
        true,
      ),
    ).toBe(false)
  })

  it('holds nothing when there are no ranges', () => {
    expect(holdsAt([], 1, true)).toBe(false)
  })
})

describe('holdingRange', () => {
  const ranges: [number, number][] = [
    [0, 10],
    [10.15, 20],
  ]

  it('after the end, gives the next range for a target in the gap just past a range, not the range before it (F4)', () => {
    expect(holdingRange(ranges, 10.05, true)).toEqual([10.15, 20])
  })

  it('keeps the end tolerance for the last range only (F4)', () => {
    expect(holdingRange(ranges, 20 + GAP_EDGE_SECONDS / 2, true)).toEqual([10.15, 20])
    expect(holdingRange(ranges, 20 + GAP_EDGE_SECONDS * 2, true)).toBeUndefined()
    expect(holdingRange(ranges, 20, false)).toBeUndefined()
  })

  it('agrees with holdsAt', () => {
    expect(holdingRange([[0, 10]], 4, false)).toEqual([0, 10])
    expect(holdingRange([], 4, true)).toBeUndefined()
  })
})
