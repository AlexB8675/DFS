import { TIMELINE_MAX_BYTES } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import type { Executor } from './journal.ts'

// Play timelines and stream sessions (DESIGN.md §16): what the page, the
// engine and the server saw of one play of a video, as batches of events in
// order. The API takes the page's batches and the server's stream sessions
// write their own through `appendTimelineBatch`. They are diagnostics, so
// not journaled: the leading bot drops them after `TIMELINE_RETENTION_DAYS`,
// and the oldest beyond `TIMELINE_MAX_TOTAL_BYTES` in all.

/** How long a timeline is kept after its last batch. */
export const TIMELINE_RETENTION_DAYS = 28
/** All timelines' events together, in bytes: the oldest go past this (§16). */
export const TIMELINE_MAX_TOTAL_BYTES = 2 * 1024 ** 3

/** Who a timeline belongs to, and what it is about. IDs are as the database spells them. */
export interface TimelineOwner {
  /** A page's play, or one of the server's stream sessions. */
  kind: 'play' | 'stream'
  via: 'drive' | 'link' | 'stream'
  nodeId: string
  versionId: string
  /** Null for a link's viewer. */
  userId: string | null
  /** The link a viewer came through. */
  shareId: string | null
  /** A stream session's page play, where its page said so. */
  playId: string | null
  /** Where the batch came from; the timeline keeps its first one. */
  address: string
  userAgent: string | null
  /** The page's clock at the play's start. */
  clientStartedAt: Date | null
  /** When a stream session began, on the server's clock; null means now (a page's play). */
  startedAt: Date | null
}

/** What became of a batch: kept, kept already, refused for size, or someone else's. */
export type AppendOutcome = 'stored' | 'duplicate' | 'full' | 'not_yours'

/**
 * Adds a batch of events to the play's or session's timeline `id`, making the
 * timeline if it is new, in one transaction that holds the timeline's row, so
 * batches arriving together are counted one after the other. A timeline that
 * isn't the owner's (its kind, route, file, user or link differ) takes
 * nothing: the address may differ, as a phone changes network mid-play, and
 * so may the version, as a replaced file plays on in the same play. A batch
 * whose `seq` is there already is a `duplicate` and changes nothing, even if
 * the timeline has filled since. Otherwise a batch that would take the
 * timeline past `TIMELINE_MAX_BYTES` is refused as `full`, its size being the
 * UTF-8 bytes of its events as JSON; and one that fits is stored, and
 * counted with its bytes in the timeline.
 */
export async function appendTimelineBatch(
  db: Database,
  id: string,
  owner: TimelineOwner,
  batch: {
    seq: number
    events: readonly unknown[]
    address: string
    /** The page's clock when it sent the batch; null for a stream session's. */
    sentMs: number | null
  },
): Promise<AppendOutcome> {
  const events = JSON.stringify(batch.events)
  const size = Buffer.byteLength(events)
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO timelines (
        id, kind, play_id, via, node_id, version_id, user_id, share_id,
        address, user_agent, client_started_at, started_at)
      VALUES (
        ${id}, ${owner.kind}, ${owner.playId}, ${owner.via}, ${owner.nodeId}, ${owner.versionId},
        ${owner.userId}, ${owner.shareId}, ${owner.address}, ${owner.userAgent},
        ${owner.clientStartedAt}, coalesce(${owner.startedAt}, now()))
      ON CONFLICT (id) DO NOTHING`)
    const { rows } = await tx.execute<{
      kind: string
      via: string
      node_id: string
      user_id: string | null
      share_id: string | null
      bytes: number
    }>(sql`
      SELECT kind, via, node_id, user_id, share_id, bytes::float8 AS bytes
      FROM timelines WHERE id = ${id} FOR UPDATE`)
    const timeline = rows[0]
    // Made above, or there already: only a drop between the two statements loses it.
    if (!timeline) throw new Error(`timeline ${id} was dropped while a batch was added`)
    if (
      timeline.kind !== owner.kind ||
      timeline.via !== owner.via ||
      timeline.node_id !== owner.nodeId ||
      timeline.user_id !== owner.userId ||
      timeline.share_id !== owner.shareId
    ) {
      return 'not_yours'
    }

    const { rows: seen } = await tx.execute(sql`
      SELECT 1 FROM timeline_batches WHERE timeline_id = ${id} AND seq = ${batch.seq}`)
    if (seen.length > 0) return 'duplicate'
    if (timeline.bytes + size > TIMELINE_MAX_BYTES) return 'full'

    await tx.execute(sql`
      INSERT INTO timeline_batches (timeline_id, seq, sent_ms, address, events, bytes)
      VALUES (${id}, ${batch.seq}, ${batch.sentMs}, ${batch.address}, ${events}::jsonb, ${size})`)
    await tx.execute(sql`
      UPDATE timelines SET bytes = bytes + ${size}, batches = batches + 1, updated_at = now()
      WHERE id = ${id}`)
    return 'stored'
  })
}

/**
 * Drops the timelines nobody added to for `days` days, then the oldest past
 * `maxBytes` in all, with their batches (they go with the cascade). The
 * newest are kept: those whose running total of `bytes`, newest start first,
 * stays within `maxBytes`. What the cap counts is the sum of the timelines'
 * `bytes`, not the table's size on disk, so it is exact. Returns how many
 * went for age (`expired`) and for size (`trimmed`).
 */
export async function pruneTimelines(
  db: Executor,
  limits: { days: number; maxBytes: number } = {
    days: TIMELINE_RETENTION_DAYS,
    maxBytes: TIMELINE_MAX_TOTAL_BYTES,
  },
): Promise<{ expired: number; trimmed: number }> {
  const { rows: expired } = await db.execute<{ count: number }>(sql`
    WITH deleted AS (
      DELETE FROM timelines
      WHERE updated_at < now() - make_interval(days => ${limits.days}::int)
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM deleted`)
  const { rows: trimmed } = await db.execute<{ count: number }>(sql`
    WITH deleted AS (
      DELETE FROM timelines
      WHERE id IN (
        SELECT id FROM (
          SELECT id, sum(bytes) OVER (ORDER BY started_at DESC, id DESC) AS total
          FROM timelines
        ) ranked
        WHERE total > ${limits.maxBytes}
      )
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM deleted`)
  return { expired: expired[0]?.count ?? 0, trimmed: trimmed[0]?.count ?? 0 }
}
