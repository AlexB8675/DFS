import { sql } from 'drizzle-orm'
import { bigintArray } from './folder-stats.ts'
import type { Executor } from './journal.ts'

// Which packs compaction merges (DESIGN.md §6.6, D32), as one rule: the
// leading bot merges by it, and Admin → Storage shows what it would merge.

export interface CompactionRule {
  /** `COMPACT_THRESHOLD`: the share of a full pack under which a pack's live bytes qualify it. */
  threshold: number
  /** `PACK_TARGET_BYTES`: a full pack, which a merged one never exceeds. */
  packTargetBytes: number
  /** `COMPACT_MIN_AGE_DAYS`: how long ago a pack must have been stored. */
  minAgeDays: number
}

export interface Candidate extends Record<string, unknown> {
  id: number
  size_bytes: number
  live_bytes: number
}

/**
 * Packs compaction may merge, in ID order: stored, their live bytes under
 * `threshold` of a full pack whatever their own size, and stored at least
 * `minAgeDays` ago, so files deleted soon after their upload go first.
 */
export async function compactionCandidates(
  db: Executor,
  rule: CompactionRule,
  skip: readonly number[] = [],
): Promise<Candidate[]> {
  const { rows } = await db.execute<Candidate>(sql`
    SELECT id::float8 AS id, size_bytes, live_bytes FROM blobs
    WHERE kind = 'pack' AND state = 'stored'
      AND live_bytes < ${rule.threshold * rule.packTargetBytes}::float8
      AND stored_at <= now() - make_interval(days => ${rule.minAgeDays}::int)
      AND NOT id = ANY(${bigintArray(skip)})
    ORDER BY id`)
  return rows
}

/**
 * Candidates in groups, in ID order so files uploaded together stay
 * together: as many whole packs to a group as their live bytes fit in a full
 * pack. A group of one is left, as rewriting one pack saves no message.
 */
export function compactionGroups<T extends Pick<Candidate, 'id' | 'live_bytes'>>(
  candidates: readonly T[],
  packTargetBytes: number,
): T[][] {
  const groups: T[][] = [[]]
  let bytes = 0
  for (const pack of candidates) {
    const group = groups.at(-1) ?? []
    if (group.length > 0 && bytes + pack.live_bytes > packTargetBytes) {
      groups.push([pack])
      bytes = pack.live_bytes
    } else {
      group.push(pack)
      bytes += pack.live_bytes
    }
  }
  return groups.filter((group) => group.length >= 2)
}

/** What merging would do. */
export interface CompactionFigures {
  /** Packs merged: those that hold little, in groups of two or more. */
  packs: number
  /** The new packs they become, one per group. */
  into: number
  /** Their files' bytes, which go into the new packs. */
  liveBytes: number
  /** What they hold beyond that, deleted files' bytes, which leave Discord with them. */
  freedBytes: number
}

/** What merging the packs due now would do, and what merging every pack that holds little would. */
export async function compactionFigures(
  db: Executor,
  rule: CompactionRule,
): Promise<{ due: CompactionFigures; all: CompactionFigures }> {
  const figures = async (minAgeDays: number): Promise<CompactionFigures> => {
    const groups = compactionGroups(
      await compactionCandidates(db, { ...rule, minAgeDays }),
      rule.packTargetBytes,
    )
    const packs = groups.flat()
    const sum = (bytes: (pack: Candidate) => number) =>
      packs.reduce((total, pack) => total + bytes(pack), 0)
    const liveBytes = sum((pack) => pack.live_bytes)
    return {
      packs: packs.length,
      into: groups.length,
      liveBytes,
      freedBytes: sum((pack) => pack.size_bytes) - liveBytes,
    }
  }
  const [due, all] = await Promise.all([figures(rule.minAgeDays), figures(0)])
  return { due, all }
}
