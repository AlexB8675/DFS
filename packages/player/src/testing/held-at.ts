// When the store held the bytes a picture needs (DESIGN.md §10.4; the plays suite's data-to-decoder time), told from
// the reads of the downloader that resolved: pure, so that it is pinned in Node.

/** A read of the downloader as it resolved: the file range [start, end) and when, on `performance.now()`'s clock. */
export interface ReadStamp {
  start: number
  end: number
  at: number
}

/**
 * The moment the store held every byte in `needed` (the end offset of each, exclusive): the latest, over them, of
 * when the read that covers its last byte resolved, if that read resolved at or after `mark`. A byte that only a read
 * from before `mark` brought was held when the seek began (the eager download had it), and counts as held at `mark`:
 * when every needed byte is, the time is the whole seek, from `mark` (R50). A byte that no read covers at all is a
 * fault of the measure, and fails the test naming it: it is never taken as held. Null when there is nothing to say a
 * moment by (Matroska, whose index keeps no frame table).
 *
 * `heldAtMark(end)` says whether the store held the byte before `end` when the seek began: the onward download writes
 * the store without a `read`, so a byte it brought is in no read of the list, and only the store knows it was there.
 */
export function heldAt(
  reads: readonly ReadStamp[],
  mark: number,
  needed: readonly number[],
  what: string,
  heldAtMark: (end: number) => boolean,
): number | null {
  if (needed.length === 0) return null
  let latest = mark
  for (const end of needed) {
    const covers = (read: ReadStamp): boolean => read.start < end && end <= read.end
    const after = reads.find((read) => read.at >= mark && covers(read))
    if (after !== undefined) {
      latest = Math.max(latest, after.at)
    } else if (!heldAtMark(end) && !reads.some((read) => read.at < mark && covers(read))) {
      throw new Error(`The measure of ${what} found no read that covers the bytes up to ${end}.`)
    }
  }
  return latest
}
