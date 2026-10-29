// The bytes of a play that the store holds, as ranges (DESIGN.md §10.4; the iron-clad
// spec §4.7). The set is a plain array of `[start, end)` ranges, sorted, disjoint
// and merged (two that touch are one), so that it says at once what is held, how
// far a read can go on without a gap, and where the next gap is. A play holds at
// most about 2,048 runs, so a tree would only add code: a search of the array and a
// splice are as quick as the store needs. The module is pure.

import type { ByteRange } from '@dfs/mp4'

/** A position in a file: a whole number that is not negative. Anything else is a `RangeError`. */
function position(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${value} is not a position in a file`)
  }
  return value
}

/** The bytes of a file that are held, as ranges that are sorted, disjoint and never touching one another. */
export class RangeSet {
  /** The held ranges. Each is the set's own object, and none leaves it. */
  #runs: ByteRange[] = []

  /** The index of the first range that ends after `offset`, or the number of ranges if none does. */
  #firstEndingAfter(offset: number): number {
    let low = 0
    let high = this.#runs.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const run = this.#runs[middle]
      if (run !== undefined && run.end > offset) high = middle
      else low = middle + 1
    }
    return low
  }

  /** Holds the bytes of `range`, joining it to every held range that it touches or overlaps. An empty range holds nothing. */
  add(range: ByteRange): void {
    const start = position(range.start)
    const end = position(range.end)
    if (end <= start) return
    // The first range that touches the new one is the first that ends at `start` or after it.
    const first = this.#firstEndingAfter(start - 1)
    let after = first
    let joinedStart = start
    let joinedEnd = end
    let run = this.#runs[after]
    while (run !== undefined && run.start <= end) {
      joinedStart = Math.min(joinedStart, run.start)
      joinedEnd = Math.max(joinedEnd, run.end)
      after += 1
      run = this.#runs[after]
    }
    this.#runs.splice(first, after - first, { start: joinedStart, end: joinedEnd })
  }

  /** Lets go of the bytes of `range`, splitting a range that it cuts in the middle. An empty range lets go of nothing. */
  remove(range: ByteRange): void {
    const start = position(range.start)
    const end = position(range.end)
    if (end <= start) return
    // A range that only touches the cut, ending at `start` or starting at `end`, is not cut by it.
    const first = this.#firstEndingAfter(start)
    const head = this.#runs[first]
    if (head === undefined || head.start >= end) return
    let tail = head
    let after = first + 1
    let run = this.#runs[after]
    while (run !== undefined && run.start < end) {
      tail = run
      after += 1
      run = this.#runs[after]
    }
    const kept: ByteRange[] = []
    if (head.start < start) kept.push({ start: head.start, end: start })
    if (tail.end > end) kept.push({ start: end, end: tail.end })
    this.#runs.splice(first, after - first, ...kept)
  }

  /** Whether every byte of `range` is held. An empty range has no byte that is missing, so it is held. */
  has(range: ByteRange): boolean {
    const start = position(range.start)
    const end = position(range.end)
    if (end <= start) return true
    // The ranges are merged, so a held stretch lies in a single one of them.
    const run = this.#runs[this.#firstEndingAfter(start)]
    return run !== undefined && run.start <= start && run.end >= end
  }

  /** How many bytes are held from `offset` on, up to the first gap: 0 when `offset` itself is not held. */
  heldFrom(offset: number): number {
    const at = position(offset)
    const run = this.#runs[this.#firstEndingAfter(at)]
    return run !== undefined && run.start <= at ? run.end - at : 0
  }

  /** The first stretch of `[from, end)` that is not held, or null if all of it is, or if it is empty. */
  firstGap(from: number, end: number): ByteRange | null {
    const start = position(from)
    const limit = position(end)
    if (start >= limit) return null
    const index = this.#firstEndingAfter(start)
    const run = this.#runs[index]
    // `start` is not held: the gap runs to the next held range, or to the limit.
    if (run === undefined || run.start > start) {
      return { start, end: run === undefined ? limit : Math.min(limit, run.start) }
    }
    // `start` is held: the gap begins where its range ends, if that is before the limit.
    if (run.end >= limit) return null
    const next = this.#runs[index + 1]
    return { start: run.end, end: next === undefined ? limit : Math.min(limit, next.start) }
  }

  /** The held ranges in order, as copies: nothing a caller does to them changes the set. */
  ranges(): readonly ByteRange[] {
    return this.#runs.map((run) => ({ start: run.start, end: run.end }))
  }

  /** How many bytes are held. */
  bytes(): number {
    let total = 0
    for (const run of this.#runs) total += run.end - run.start
    return total
  }
}
