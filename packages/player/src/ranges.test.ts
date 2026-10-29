import { describe, expect, it } from 'vitest'
import { RangeSet } from './ranges.ts'

// The bytes of a play that the store holds are kept as sorted, disjoint,
// merged ranges (DESIGN.md §10.4; the iron-clad spec §4.7). A set answers what is
// held, how far a read can go on without a gap, and where the next gap is.

/** A set holding exactly the ranges given, added in order. */
function setOf(...held: [number, number][]): RangeSet {
  const set = new RangeSet()
  for (const [start, end] of held) set.add({ start, end })
  return set
}

/** The ranges of a set as pairs, to read them at a glance. */
function pairs(set: RangeSet): [number, number][] {
  return set.ranges().map((range): [number, number] => [range.start, range.end])
}

/** A generator of numbers in [0, 1) from a seed (mulberry32): the same operations on every run and every machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

describe('RangeSet add', () => {
  it('starts empty', () => {
    const set = new RangeSet()
    expect(pairs(set)).toEqual([])
    expect(set.bytes()).toBe(0)
  })

  it('merges ranges that touch', () => {
    const set = setOf([0, 10], [10, 20])
    expect(pairs(set)).toEqual([[0, 20]])
    expect(set.bytes()).toBe(20)
  })

  it('merges a range added before one that it touches', () => {
    expect(pairs(setOf([10, 20], [0, 10]))).toEqual([[0, 20]])
  })

  it('merges ranges that overlap', () => {
    expect(pairs(setOf([0, 15], [10, 25]))).toEqual([[0, 25]])
    expect(pairs(setOf([10, 25], [0, 15]))).toEqual([[0, 25]])
  })

  it('keeps ranges that do not touch apart, in order', () => {
    expect(pairs(setOf([30, 40], [0, 10], [15, 20]))).toEqual([
      [0, 10],
      [15, 20],
      [30, 40],
    ])
  })

  it('merges every range that a new one bridges', () => {
    const set = setOf([0, 10], [20, 30], [40, 50], [60, 70])
    set.add({ start: 5, end: 45 })
    expect(pairs(set)).toEqual([
      [0, 50],
      [60, 70],
    ])
    expect(set.bytes()).toBe(60)
  })

  it('swallows ranges that a new one covers, and leaves the ones beyond it', () => {
    const set = setOf([10, 20], [30, 40], [100, 110])
    set.add({ start: 0, end: 50 })
    expect(pairs(set)).toEqual([
      [0, 50],
      [100, 110],
    ])
  })

  it('does nothing for a range that is already held', () => {
    const set = setOf([0, 100])
    set.add({ start: 20, end: 30 })
    set.add({ start: 0, end: 100 })
    expect(pairs(set)).toEqual([[0, 100]])
  })

  it('does nothing for an empty range, and does not join the ranges on either side of it', () => {
    const set = setOf([0, 10], [20, 30])
    set.add({ start: 15, end: 15 })
    set.add({ start: 15, end: 12 })
    expect(pairs(set)).toEqual([
      [0, 10],
      [20, 30],
    ])
  })

  it('refuses a range that is negative or not a whole number', () => {
    const set = setOf([0, 10])
    expect(() => {
      set.add({ start: -1, end: 5 })
    }).toThrow(RangeError)
    expect(() => {
      set.add({ start: 0, end: 5.5 })
    }).toThrow(RangeError)
    expect(() => {
      set.add({ start: Number.NaN, end: 5 })
    }).toThrow(RangeError)
    expect(pairs(set)).toEqual([[0, 10]])
  })
})

describe('RangeSet remove', () => {
  it('splits a range in two when the removed part is in its middle', () => {
    const set = setOf([0, 30])
    set.remove({ start: 10, end: 20 })
    expect(pairs(set)).toEqual([
      [0, 10],
      [20, 30],
    ])
    expect(set.bytes()).toBe(20)
  })

  it('trims a range at either end', () => {
    const set = setOf([0, 30])
    set.remove({ start: 0, end: 5 })
    set.remove({ start: 25, end: 30 })
    expect(pairs(set)).toEqual([[5, 25]])
  })

  it('removes a range whole', () => {
    const set = setOf([0, 10], [20, 30])
    set.remove({ start: 20, end: 30 })
    expect(pairs(set)).toEqual([[0, 10]])
  })

  it('removes across several ranges, trimming the two at the ends of the cut', () => {
    const set = setOf([0, 10], [20, 30], [40, 50], [60, 70])
    set.remove({ start: 5, end: 65 })
    expect(pairs(set)).toEqual([
      [0, 5],
      [65, 70],
    ])
  })

  it('does nothing for a range that is not held, even one that touches a held range', () => {
    const set = setOf([10, 20])
    set.remove({ start: 0, end: 10 })
    set.remove({ start: 20, end: 30 })
    set.remove({ start: 40, end: 50 })
    expect(pairs(set)).toEqual([[10, 20]])
  })

  it('does nothing for an empty range, even inside a held range', () => {
    const set = setOf([0, 30])
    set.remove({ start: 10, end: 10 })
    set.remove({ start: 20, end: 10 })
    expect(pairs(set)).toEqual([[0, 30]])
  })

  it('empties a set when everything is removed', () => {
    const set = setOf([0, 10], [20, 30])
    set.remove({ start: 0, end: 1000 })
    expect(pairs(set)).toEqual([])
    expect(set.bytes()).toBe(0)
  })

  it('refuses a range that is negative or not a whole number', () => {
    const set = setOf([0, 10])
    expect(() => {
      set.remove({ start: -5, end: 5 })
    }).toThrow(RangeError)
    expect(() => {
      set.remove({ start: 0, end: Number.POSITIVE_INFINITY })
    }).toThrow(RangeError)
    expect(pairs(set)).toEqual([[0, 10]])
  })
})

describe('RangeSet has', () => {
  const set = setOf([0, 20], [30, 40])

  it('is true for a range of which every byte is held', () => {
    expect(set.has({ start: 0, end: 20 })).toBe(true)
    expect(set.has({ start: 5, end: 15 })).toBe(true)
    expect(set.has({ start: 30, end: 40 })).toBe(true)
  })

  it('is false for a range that reaches a byte that is not held', () => {
    expect(set.has({ start: 0, end: 21 })).toBe(false)
    expect(set.has({ start: 10, end: 35 })).toBe(false)
    expect(set.has({ start: 19, end: 31 })).toBe(false)
    expect(set.has({ start: 20, end: 30 })).toBe(false)
    expect(set.has({ start: 50, end: 60 })).toBe(false)
  })

  it('is true for an empty range, which has no byte that is missing', () => {
    expect(set.has({ start: 25, end: 25 })).toBe(true)
    expect(new RangeSet().has({ start: 0, end: 0 })).toBe(true)
  })

  it('is false for any range of an empty set', () => {
    expect(new RangeSet().has({ start: 0, end: 1 })).toBe(false)
  })
})

describe('RangeSet heldFrom', () => {
  it('counts the bytes held from an offset on, without a gap', () => {
    const set = setOf([0, 20])
    expect(set.heldFrom(5)).toBe(15)
    expect(set.heldFrom(0)).toBe(20)
    expect(set.heldFrom(19)).toBe(1)
  })

  it('is 0 where the offset is not held', () => {
    const set = setOf([0, 20], [30, 40])
    expect(set.heldFrom(25)).toBe(0)
    expect(set.heldFrom(20)).toBe(0)
    expect(set.heldFrom(40)).toBe(0)
    expect(set.heldFrom(1000)).toBe(0)
    expect(new RangeSet().heldFrom(0)).toBe(0)
  })

  it('stops at a gap and does not count what lies beyond it', () => {
    const set = setOf([0, 20], [30, 40])
    expect(set.heldFrom(10)).toBe(10)
    expect(set.heldFrom(30)).toBe(10)
  })

  it('refuses an offset that is negative or not a whole number', () => {
    const set = setOf([0, 20])
    expect(() => set.heldFrom(-1)).toThrow(RangeError)
    expect(() => set.heldFrom(0.5)).toThrow(RangeError)
    expect(() => set.heldFrom(Number.NaN)).toThrow(RangeError)
  })
})

describe('RangeSet firstGap', () => {
  const set = setOf([0, 20], [30, 40])

  it('gives the first stretch of the span that is not held', () => {
    expect(set.firstGap(0, 100)).toEqual({ start: 20, end: 30 })
    expect(set.firstGap(25, 100)).toEqual({ start: 25, end: 30 })
    expect(set.firstGap(35, 100)).toEqual({ start: 40, end: 100 })
    expect(set.firstGap(50, 100)).toEqual({ start: 50, end: 100 })
  })

  it('starts the gap at `from` when `from` itself is not held', () => {
    expect(set.firstGap(22, 28)).toEqual({ start: 22, end: 28 })
  })

  it('cuts the gap short at `end`', () => {
    expect(set.firstGap(0, 25)).toEqual({ start: 20, end: 25 })
    expect(set.firstGap(35, 45)).toEqual({ start: 40, end: 45 })
  })

  it('is null when every byte of the span is held', () => {
    expect(set.firstGap(30, 40)).toBeNull()
    expect(set.firstGap(5, 15)).toBeNull()
    expect(set.firstGap(0, 20)).toBeNull()
  })

  it('is null for a span that is empty', () => {
    expect(set.firstGap(25, 25)).toBeNull()
    expect(set.firstGap(25, 10)).toBeNull()
    expect(new RangeSet().firstGap(0, 0)).toBeNull()
  })

  it('is the whole span for an empty set', () => {
    expect(new RangeSet().firstGap(10, 20)).toEqual({ start: 10, end: 20 })
  })

  it('refuses a span that is negative or not a whole number', () => {
    expect(() => set.firstGap(-1, 10)).toThrow(RangeError)
    expect(() => set.firstGap(0, 10.5)).toThrow(RangeError)
    expect(() => set.firstGap(0, Number.NaN)).toThrow(RangeError)
  })
})

describe('RangeSet ranges', () => {
  it('gives the ranges in order', () => {
    expect(setOf([30, 40], [0, 10]).ranges()).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 40 },
    ])
  })

  it('gives a copy: changing what it returns does not change the set', () => {
    const set = setOf([0, 10], [30, 40])
    const given = set.ranges() as { start: number; end: number }[]
    for (const range of given) range.end = 999
    given.push({ start: 5, end: 6 })
    given.length = 0
    expect(pairs(set)).toEqual([
      [0, 10],
      [30, 40],
    ])
    expect(set.bytes()).toBe(20)
  })

  it('gives a list that a later change to the set does not alter', () => {
    const set = setOf([0, 10])
    const before = set.ranges()
    set.add({ start: 10, end: 20 })
    expect(before).toEqual([{ start: 0, end: 10 }])
  })

  it('is not changed by a range that was added and is then altered by its owner', () => {
    const set = new RangeSet()
    const added = { start: 0, end: 10 }
    set.add(added)
    added.end = 500
    expect(pairs(set)).toEqual([[0, 10]])
  })
})

describe('RangeSet against a model', () => {
  const SPAN = 10_000
  const OPERATIONS = 2_000

  it('agrees with an array of booleans through 2,000 random adds and removes', () => {
    const random = generator(0x5eed_0001)
    const below = (limit: number): number => Math.floor(random() * limit)
    const set = new RangeSet()
    const model = new Uint8Array(SPAN)

    /** The bytes held from an offset on, without a gap, by the model. */
    const modelHeldFrom = (offset: number): number => {
      let at = offset
      while (at < SPAN && model[at] === 1) at += 1
      return at - offset
    }

    for (let operation = 0; operation < OPERATIONS; operation += 1) {
      // Lengths run from nothing to a few hundred bytes, now and then a few thousand, so that
      // ranges both stay apart and bridge one another.
      const start = below(SPAN)
      const wide = random() < 0.05
      const length = wide ? below(3_000) : below(300)
      const end = Math.min(SPAN, start + length)
      const adding = random() < 0.55
      if (adding) {
        set.add({ start, end })
        model.fill(1, start, end)
      } else {
        set.remove({ start, end })
        model.fill(0, start, end)
      }

      expect(set.bytes()).toBe(model.reduce((sum, bit) => sum + bit, 0))

      // The ranges stay sorted, disjoint, apart from one another, and not empty.
      let previousEnd = -1
      for (const range of set.ranges()) {
        expect(range.end).toBeGreaterThan(range.start)
        expect(range.start).toBeGreaterThan(previousEnd)
        previousEnd = range.end
      }

      // `has` and `heldFrom`, at a few random places.
      for (let query = 0; query < 4; query += 1) {
        const from = below(SPAN)
        const to = Math.min(SPAN, from + below(400))
        let expected = true
        for (let at = from; at < to; at += 1) if (model[at] !== 1) expected = false
        expect(set.has({ start: from, end: to })).toBe(expected)
        expect(set.heldFrom(from)).toBe(modelHeldFrom(from))

        // `firstGap` is the first run of bytes that the model does not hold.
        let gapStart = from
        while (gapStart < to && model[gapStart] === 1) gapStart += 1
        let gapEnd = gapStart
        while (gapEnd < to && model[gapEnd] !== 1) gapEnd += 1
        expect(set.firstGap(from, to)).toEqual(
          gapStart < to ? { start: gapStart, end: gapEnd } : null,
        )
      }

      // Now and then, `heldFrom` at every offset.
      if (operation % 100 === 99) {
        for (let at = 0; at < SPAN; at += 1) expect(set.heldFrom(at)).toBe(modelHeldFrom(at))
      }
    }
  })
})
