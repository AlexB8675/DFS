// What a reader of a file in the page is given and asks for (DESIGN.md §10.4,
// D45). The module is pure: it never reads a file. A reader is called with the
// parts of the file its caller holds (chunks, each at an offset of the file) and
// gives either its result or the next range of the file it needs, which the
// caller reads, adds as a chunk and calls it again with. The same shape serves
// both containers.

/** A range of a file: from `start` up to, and not including, `end`. */
export interface ByteRange {
  start: number
  end: number
}

/** A part of a file that a caller holds: its bytes, and the offset of the first of them in the file. */
export interface Chunk {
  start: number
  bytes: Uint8Array
}

/** What a reader gives each time it is called: its result, or the range of the file it needs to go on. */
export type Step<T> = { done: T } | { need: ByteRange }

/** Where a chunk ends in the file. */
function endOf(chunk: Chunk): number {
  return chunk.start + chunk.bytes.length
}

/**
 * Of the chunks that hold the byte at `start`, the one that reaches furthest
 * (the first of them if two reach as far), as it is: not joined with any
 * other. Null when no chunk holds it. A chunk of no bytes holds none.
 */
export function heldFrom(chunks: readonly Chunk[], start: number): Chunk | null {
  let best: Chunk | null = null
  for (const chunk of chunks) {
    if (chunk.start > start || endOf(chunk) <= start) continue
    if (best === null || endOf(chunk) > endOf(best)) best = chunk
  }
  return best
}

/**
 * The bytes of the file from `start`, as far as the chunks hold them without a
 * gap, but no further than `limit`: all of [start, limit) when they hold it,
 * and when they don't, up to where the first gap is, which may be nothing at
 * all. A view onto the chunk when one holds all that is given; a copy of exactly
 * those bytes (not of the chunks) when it takes several, which may touch or
 * overlap, in any order.
 */
export function heldPrefix(chunks: readonly Chunk[], start: number, limit: number): Uint8Array {
  const run: Chunk[] = []
  let at = start
  while (at < limit) {
    const chunk = heldFrom(chunks, at)
    if (chunk === null) break
    run.push(chunk)
    at = Math.min(limit, endOf(chunk))
  }

  const [only, ...rest] = run
  if (only === undefined) return new Uint8Array(0)
  if (rest.length === 0) return only.bytes.subarray(start - only.start, at - only.start)

  const joined = new Uint8Array(at - start)
  let from = start
  for (const chunk of run) {
    const to = Math.min(at, endOf(chunk))
    joined.set(chunk.bytes.subarray(from - chunk.start, to - chunk.start), from - start)
    from = to
  }
  return joined
}

/**
 * The bytes of [start, end) of the file when the chunks hold all of them: a
 * view onto the chunk when one holds the whole range, a copy when chunks that
 * touch or overlap cover it (so a range that two reads hold between them is
 * held), and null when any byte of it is in none. A range that isn't one (an end
 * before its start, or a number that isn't a position in a file) is a RangeError,
 * the caller's mistake.
 */
export function heldBytes(chunks: readonly Chunk[], start: number, end: number): Uint8Array | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`${start} to ${end} is not a range of a file.`)
  }
  const held = heldPrefix(chunks, start, end)
  return held.length === end - start ? held : null
}
