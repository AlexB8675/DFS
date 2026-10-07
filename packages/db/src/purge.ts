import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { uuidArray } from './folder-stats.ts'
import { appendJournal, auditRecords, type Executor, type JournalRecord } from './journal.ts'
import { TREE_LOCK_NAMESPACE } from './locks.ts'
import { auditLog } from './schema.ts'

// Removing things for good (DESIGN.md §6.4): emptied trash, pruned versions,
// expired uploads. Frames stop counting toward their blobs (a blob with nothing
// live left goes to the GC), and quota is released at once.
//
// These return their journal records rather than appending them: the caller
// appends everything its transaction journals at the end (see locks.ts).

/**
 * Purges file versions: their frames are released, the bytes of completed
 * ones stop counting toward the owner's quota (D24). The caller removes their
 * staged frames once the transaction commits.
 */
export async function purgeVersions(
  tx: Executor,
  ownerId: string,
  versionIds: readonly string[],
): Promise<JournalRecord[]> {
  if (versionIds.length === 0) return []
  const versions = uuidArray(versionIds)
  // The versions before their blobs, the order of locks.ts: storing a pack
  // waits here for a purge of one of its versions, or is seen by it.
  const { rows } = await tx.execute<{ bytes: number | null }>(sql`
    SELECT sum(size_bytes) FILTER (WHERE state IN ('syncing', 'stored', 'failed'))::float8 AS bytes
    FROM (SELECT * FROM file_versions WHERE id = ANY(${versions}) ORDER BY id FOR UPDATE) locked`)
  const usedBytes = rows[0]?.bytes ?? 0

  // Waits for a pack being sealed with any of their frames (§6.6), so the
  // release below sees the pack and counts those frames out of it. Frames
  // not packed yet stay locked, so the packer leaves them alone.
  await tx.execute(sql`
    SELECT id FROM chunks WHERE version_id = ANY(${versions}) AND blob_id IS NULL
    ORDER BY id FOR UPDATE`)
  // Blobs in ID order too, so two purges of frames in the same packs queue.
  await tx.execute(sql`
    SELECT id FROM blobs
    WHERE id IN (SELECT blob_id FROM chunks WHERE version_id = ANY(${versions}))
    ORDER BY id FOR UPDATE`)
  await tx.execute(sql`
    UPDATE blobs SET
      live_bytes = blobs.live_bytes - released.bytes,
      -- Nothing live left: a stored blob goes to the GC, once this is journaled.
      state = CASE
        WHEN blobs.live_bytes - released.bytes > 0 THEN blobs.state
        WHEN blobs.state = 'stored' THEN 'deleting'::blob_state
        ELSE blobs.state END,
      released_at = CASE
        WHEN blobs.live_bytes - released.bytes <= 0 AND blobs.state = 'stored' THEN now()
        ELSE blobs.released_at END
    FROM (
      SELECT blob_id, sum(frame_size) AS bytes FROM chunks
      WHERE version_id = ANY(${versions}) AND blob_id IS NOT NULL AND purged_at IS NULL
      GROUP BY blob_id
    ) released
    WHERE blobs.id = released.blob_id`)
  await tx.execute(sql`DELETE FROM chunks WHERE version_id = ANY(${versions})`)
  // Their finished uploads go too: those settled their reservations on completion.
  // (Uploads still receiving are abandoned first, which releases theirs.)
  await tx.execute(sql`
    DELETE FROM upload_sessions WHERE version_id = ANY(${versions}) AND state = 'completed'`)
  await tx.execute(sql`
    UPDATE nodes SET current_version_id = NULL WHERE current_version_id = ANY(${versions})`)
  await tx.execute(sql`DELETE FROM file_versions WHERE id = ANY(${versions})`)
  if (usedBytes > 0) {
    await tx.execute(sql`
      UPDATE users SET used_bytes = greatest(0, used_bytes - ${usedBytes}) WHERE id = ${ownerId}`)
  }
  return versionIds.map((id) => ({ kind: 'version.purged', record: { id } }))
}

/** A share link, aliased `link`, that still works: not expired or used up (§7.5). */
export const WORKING_LINK = sql`(link.expires_at IS NULL OR link.expires_at > now())
  AND (link.max_downloads IS NULL OR link.download_count < link.max_downloads)`

/** Whether a working share link serves this version. */
function servedByLink(versionId: ReturnType<typeof sql>) {
  return sql`EXISTS (
    SELECT 1 FROM share_links link WHERE link.version_id = ${versionId} AND ${WORKING_LINK})`
}

/**
 * Of these earlier versions, those no active share link serves, which can
 * go (D20). Locks them first: making a link takes a key-share lock on its
 * version, so a link made meanwhile is seen, or waits for the purge and
 * finds its version gone. Lock order (locks.ts): a file before its versions.
 */
export async function unneededVersions(
  tx: Executor,
  versionIds: readonly string[],
): Promise<string[]> {
  if (versionIds.length === 0) return []
  const ids = uuidArray(versionIds)
  await tx.execute(sql`SELECT id FROM file_versions WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`)
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT version.id FROM file_versions version
    WHERE version.id = ANY(${ids}) AND NOT ${servedByLink(sql`version.id`)}`)
  return rows.map((row) => row.id)
}

/**
 * Purges earlier versions whose last share link has stopped working since
 * their file got a newer one (§6.4): expired, revoked or used up. At most
 * `limit`, one owner per transaction; versions being purged or linked right
 * now wait for the next round. Returns the versions whose staged frames the
 * caller removes, once committed.
 */
export async function purgeUnneededVersions(db: Database, limit = 500): Promise<string[]> {
  const { rows: due } = await db.execute<{ id: string; owner_id: string }>(sql`
    SELECT version.id, node.owner_id FROM file_versions version
    JOIN nodes node ON node.id = version.node_id
    WHERE version.id <> node.current_version_id
      AND version.state IN ('syncing', 'stored', 'failed')
      AND NOT ${servedByLink(sql`version.id`)}
    ORDER BY version.id LIMIT ${limit}`)
  const purged: string[] = []
  for (const [ownerId, rows] of Map.groupBy(due, (row) => row.owner_id)) {
    const versionIds = await db.transaction(async (tx) => {
      const { rows: locked } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM file_versions WHERE id = ANY(${uuidArray(rows.map((row) => row.id))})
        ORDER BY id FOR UPDATE SKIP LOCKED`)
      const { rows: unneeded } = await tx.execute<{ id: string }>(sql`
        SELECT version.id FROM file_versions version
        WHERE version.id = ANY(${uuidArray(locked.map((row) => row.id))})
          AND NOT ${servedByLink(sql`version.id`)}`)
      const ids = unneeded.map((row) => row.id)
      await appendJournal(tx, await purgeVersions(tx, ownerId, ids))
      return ids
    })
    // Counted once committed: staged frames of a purge rolled back must stay.
    purged.push(...versionIds)
  }
  return purged
}

export interface Purged {
  /** Versions whose staged frames can be removed once the transaction commits. */
  versionIds: string[]
  records: JournalRecord[]
}

/**
 * Removes nodes and everything below them for good, with their versions,
 * shares and uploads (releasing reservations).
 */
export async function purgeSubtrees(
  tx: Executor,
  ownerId: string,
  rootIds: readonly string[],
): Promise<Purged> {
  if (rootIds.length === 0) return { versionIds: [], records: [] }
  const { rows: subtree } = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE below AS (
      SELECT id FROM nodes WHERE id = ANY(${uuidArray(rootIds)}) AND owner_id = ${ownerId}
      UNION ALL
      SELECT child.id FROM nodes child JOIN below ON child.parent_id = below.id
    )
    SELECT id FROM below`)
  const nodeIds = uuidArray(subtree.map((row) => row.id))
  // Uploads before nodes, as completion holds its session while updating its
  // file. Taking the node first could deadlock with that completion.
  await tx.execute(sql`
    SELECT id FROM upload_sessions WHERE node_id = ANY(${nodeIds}) ORDER BY id FOR UPDATE`)
  // Nodes before the user's row, the order of locks.ts.
  await tx.execute(sql`SELECT id FROM nodes WHERE id = ANY(${nodeIds}) ORDER BY id FOR UPDATE`)

  const { rows: uploads } = await tx.execute<{ reserved: number }>(sql`
    DELETE FROM upload_sessions WHERE node_id = ANY(${nodeIds})
    RETURNING (CASE WHEN state = 'receiving' THEN reserved_bytes ELSE 0 END)::float8 AS reserved`)
  const reservedBytes = uploads.reduce((total, upload) => total + upload.reserved, 0)
  if (reservedBytes > 0) await releaseReservation(tx, ownerId, reservedBytes)

  const { rows: versions } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM file_versions WHERE node_id = ANY(${nodeIds})`)
  const versionIds = versions.map((version) => version.id)
  const records = await purgeVersions(tx, ownerId, versionIds)

  await tx.execute(sql`DELETE FROM share_links WHERE node_id = ANY(${nodeIds})`)
  // Markers before stats, as folding takes them.
  await tx.execute(sql`DELETE FROM folder_stats_dirty WHERE node_id = ANY(${nodeIds})`)
  await tx.execute(sql`DELETE FROM folder_stats WHERE node_id = ANY(${nodeIds})`)
  await tx.execute(sql`DELETE FROM nodes WHERE id = ANY(${nodeIds})`)
  for (const id of rootIds) records.push({ kind: 'node.purge', record: { id } })
  return { versionIds, records }
}

/**
 * Purges what has been in the trash longer than `retentionDays` (§6.4), as
 * emptying the trash would: the oldest `limit` items at most, one drive per
 * transaction, each logged as deleted by the system. Returns how many went,
 * and the purged versions, whose staged frames the caller removes.
 */
export async function expireTrash(
  db: Database,
  retentionDays: number,
  limit = 500,
): Promise<{ items: number; versionIds: string[] }> {
  const cutoff = sql`now() - make_interval(days => ${retentionDays}::int)`
  const { rows: due } = await db.execute<{ owner_id: string; id: string }>(sql`
    SELECT owner_id, id FROM nodes
    WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}
    ORDER BY deleted_at LIMIT ${limit}`)
  let items = 0
  const versionIds: string[] = []
  for (const [ownerId, rows] of Map.groupBy(due, (row) => row.owner_id)) {
    const purged = await db.transaction(async (tx) => {
      // The drive's tree lock, as the API's trash and restore take it.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${TREE_LOCK_NAMESPACE}, hashtext(${ownerId}))`,
      )
      // Its owner may have restored or emptied some meanwhile.
      const { rows: still } = await tx.execute<{ id: string; name: string; owner: string }>(sql`
        SELECT node.id, node.name, account.display_name AS owner
        FROM nodes node JOIN users account ON account.id = node.owner_id
        WHERE node.id = ANY(${uuidArray(rows.map((row) => row.id))})
          AND node.owner_id = ${ownerId} AND node.deleted_at < ${cutoff}`)
      if (still.length === 0) return null
      const { versionIds: versions, records } = await purgeSubtrees(
        tx,
        ownerId,
        still.map((row) => row.id),
      )
      const entries = await tx
        .insert(auditLog)
        .values(
          still.map((row) => ({
            userId: null,
            action: 'node.purged',
            nodeId: row.id,
            meta: {
              target: `${row.name} (${row.owner})`,
              details: `after ${String(retentionDays)} days in the trash`,
            },
          })),
        )
        .returning()
      await appendJournal(tx, [...records, ...auditRecords(entries)])
      return { count: still.length, versions }
    })
    // Counted once committed: staged frames of a purge rolled back must stay.
    if (!purged) continue
    items += purged.count
    versionIds.push(...purged.versions)
  }
  return { items, versionIds }
}

/** Gives back bytes an upload had reserved (§5.1). */
export async function releaseReservation(
  tx: Executor,
  ownerId: string,
  bytes: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE users SET reserved_bytes = greatest(0, reserved_bytes - ${bytes}) WHERE id = ${ownerId}`)
}

/**
 * Blobs whose `live_bytes` aren't the sum of the frames still in them: always
 * empty, unless a purge and a pack or an upload got in each other's way. A
 * check for tests and for a running stack.
 */
export async function liveBytesDrift(
  db: Executor,
): Promise<{ id: number; live_bytes: number; frames: number }[]> {
  const { rows } = await db.execute<{ id: number; live_bytes: number; frames: number }>(sql`
    SELECT blob.id::float8 AS id, blob.live_bytes,
      coalesce(sum(chunk.frame_size), 0)::int AS frames
    FROM blobs blob LEFT JOIN chunks chunk ON chunk.blob_id = blob.id AND chunk.purged_at IS NULL
    WHERE blob.state <> 'deleted'
    GROUP BY blob.id
    HAVING blob.live_bytes <> coalesce(sum(chunk.frame_size), 0)`)
  return rows
}
