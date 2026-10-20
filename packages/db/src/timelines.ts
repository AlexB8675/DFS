import { TIMELINE_MAX_BYTES } from '@dfs/shared'
import { sql, type SQL } from 'drizzle-orm'
import type { Database } from './client.ts'
import { uuidArray } from './folder-stats.ts'
import type { Executor } from './journal.ts'

// Play timelines and stream sessions (DESIGN.md §16): what the page, the
// engine and the server saw of one play of a video, as batches of events in
// order. The API takes the page's batches and the server's stream sessions
// write their own through `appendTimelineBatch`. They are diagnostics, so
// not journaled: the leading bot drops them after `TIMELINE_RETENTION_DAYS`,
// and the least recently written beyond `TIMELINE_MAX_TOTAL_BYTES` in all.

/** How long a timeline is kept after its last batch. */
export const TIMELINE_RETENTION_DAYS = 28
/** All timelines' events together, in bytes: the least recently written go past this (§16). */
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
 * Drops the timelines nobody added to for `days` days, then the least
 * recently written past `maxBytes` in all, with their batches (they go with
 * the cascade). The newest are kept: those whose running total of `bytes`,
 * newest last batch first, stays within `maxBytes`. So a play still sending
 * batches is never cut for an idle one that began after it, which would
 * split it. What the cap counts is the sum of the timelines' `bytes`, not the
 * table's size on disk, so it is exact. Returns how many went for age
 * (`expired`) and for size (`trimmed`).
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
          SELECT id, sum(bytes) OVER (ORDER BY updated_at DESC, id DESC) AS total
          FROM timelines
        ) ranked
        WHERE total > ${limits.maxBytes}
      )
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM deleted`)
  return { expired: expired[0]?.count ?? 0, trimmed: trimmed[0]?.count ?? 0 }
}

/** A timeline's row, as the CLI shows it. */
export interface TimelineRow {
  id: string
  kind: 'play' | 'stream'
  playId: string | null
  via: 'drive' | 'link' | 'stream'
  nodeId: string
  versionId: string
  userId: string | null
  /** The user's name, while the account exists. */
  username: string | null
  shareId: string | null
  address: string
  userAgent: string | null
  clientStartedAt: Date | null
  startedAt: Date
  updatedAt: Date
  bytes: number
  batches: number
  /** The file's name, while it exists. A vault file's stays out (§7.7). */
  fileName: string | null
}

/** One batch, its events as stored. */
export interface BatchRow {
  seq: number
  receivedAt: Date
  sentMs: number | null
  address: string
  events: unknown[]
}

export interface TimelineRead {
  timeline: TimelineRow
  batches: BatchRow[]
  /** For a play: the stream sessions that served it (their `play_id` is its id), oldest first. */
  sessions: { timeline: TimelineRow; batches: BatchRow[] }[]
}

/** The timelines `tail` (a WHERE, ORDER BY and LIMIT) picks, with their user's and file's names. */
async function selectTimelines(db: Executor, tail: SQL): Promise<TimelineRow[]> {
  // Timestamps are selected as epoch milliseconds, which `Date` takes exactly: drizzle's
  // `execute` hands `timestamptz` back as text.
  const { rows } = await db.execute<{
    id: string
    kind: TimelineRow['kind']
    play_id: string | null
    via: TimelineRow['via']
    node_id: string
    version_id: string
    user_id: string | null
    username: string | null
    share_id: string | null
    address: string
    user_agent: string | null
    client_started_ms: number | null
    started_ms: number
    updated_ms: number
    bytes: number
    batches: number
    file_name: string | null
  }>(sql`
    SELECT t.id, t.kind, t.play_id, t.via, t.node_id, t.version_id, t.user_id, users.username,
      t.share_id, t.address, t.user_agent,
      floor(extract(epoch FROM t.client_started_at) * 1000)::float8 AS client_started_ms,
      floor(extract(epoch FROM t.started_at) * 1000)::float8 AS started_ms,
      floor(extract(epoch FROM t.updated_at) * 1000)::float8 AS updated_ms,
      t.bytes::float8 AS bytes, t.batches, node.name AS file_name
    FROM timelines t
    LEFT JOIN users ON users.id = t.user_id
    LEFT JOIN nodes node /* tree: not the vault: an admin's read names no vault file (§7.7) */ ON node.id = t.node_id AND node.tree <> 'vault'
    ${tail}`)
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    playId: row.play_id,
    via: row.via,
    nodeId: row.node_id,
    versionId: row.version_id,
    userId: row.user_id,
    username: row.username,
    shareId: row.share_id,
    address: row.address,
    userAgent: row.user_agent,
    clientStartedAt: row.client_started_ms === null ? null : new Date(row.client_started_ms),
    startedAt: new Date(row.started_ms),
    updatedAt: new Date(row.updated_ms),
    bytes: row.bytes,
    batches: row.batches,
    fileName: row.file_name,
  }))
}

/** The batches of the timelines `ids`, in `seq` order, by timeline. */
async function selectBatches(
  db: Executor,
  ids: readonly string[],
): Promise<Map<string, BatchRow[]>> {
  const { rows } = await db.execute<{
    timeline_id: string
    seq: number
    received_ms: number
    sent_ms: number | null
    address: string
    events: unknown[]
  }>(sql`
    SELECT timeline_id, seq, floor(extract(epoch FROM received_at) * 1000)::float8 AS received_ms,
      sent_ms, address, events
    FROM timeline_batches WHERE timeline_id = ANY(${uuidArray(ids)})
    ORDER BY timeline_id, seq`)
  const byTimeline = new Map<string, BatchRow[]>()
  for (const row of rows) {
    const batch: BatchRow = {
      seq: row.seq,
      receivedAt: new Date(row.received_ms),
      sentMs: row.sent_ms,
      address: row.address,
      events: row.events,
    }
    const found = byTimeline.get(row.timeline_id)
    if (found) found.push(batch)
    else byTimeline.set(row.timeline_id, [batch])
  }
  return byTimeline
}

/**
 * The `limit` most recently started timelines, newest first: plays and the
 * sessions no play of theirs holds. A session that a listed play holds (the
 * play's own reader's, as `readTimeline` links them) shows under it, so it
 * takes no place in the list or its limit. One naming a play whose page never
 * sent a timeline, or another reader's play, or no play, is listed.
 */
export async function listTimelines(db: Executor, limit: number): Promise<TimelineRow[]> {
  return selectTimelines(
    db,
    sql`WHERE NOT (t.kind = 'stream' AND t.play_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM timelines p
        WHERE p.id = t.play_id AND p.kind = 'play'
          AND p.user_id IS NOT DISTINCT FROM t.user_id
          AND p.share_id IS NOT DISTINCT FROM t.share_id))
      ORDER BY t.started_at DESC, t.id DESC LIMIT ${limit}`,
  )
}

/**
 * One timeline with its batches in `seq` order and, for a play, the stream
 * sessions that served it, oldest first; null if there is none. They are the
 * play's own reader's: a play ID comes from the page, so another reader's
 * session naming it isn't its.
 */
export async function readTimeline(db: Executor, id: string): Promise<TimelineRead | null> {
  const [timeline] = await selectTimelines(db, sql`WHERE t.id = ${id}`)
  if (!timeline) return null
  const sessions =
    timeline.kind === 'play'
      ? await selectTimelines(
          db,
          sql`WHERE t.kind = 'stream' AND t.play_id = ${id}
            AND t.user_id IS NOT DISTINCT FROM ${timeline.userId}
            AND t.share_id IS NOT DISTINCT FROM ${timeline.shareId}
            ORDER BY t.started_at, t.id`,
        )
      : []
  const batches = await selectBatches(db, [timeline.id, ...sessions.map((session) => session.id)])
  return {
    timeline,
    batches: batches.get(timeline.id) ?? [],
    sessions: sessions.map((session) => ({
      timeline: session,
      batches: batches.get(session.id) ?? [],
    })),
  }
}
