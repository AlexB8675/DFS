import { sql } from 'drizzle-orm'
import { uuidArray } from './folder-stats.ts'
import type { Executor, JournalRecord } from './journal.ts'

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
  const { rows } = await tx.execute<{ bytes: number | null }>(sql`
    SELECT sum(size_bytes)::float8 AS bytes FROM file_versions
    WHERE id = ANY(${versions}) AND state IN ('syncing', 'stored', 'failed')`)
  const usedBytes = rows[0]?.bytes ?? 0

  // Waits for a pack being sealed with any of their frames (§6.6), so the
  // release below sees the pack and counts those frames out of it. Frames
  // not packed yet stay locked, so the packer leaves them alone.
  await tx.execute(sql`
    SELECT id FROM chunks WHERE version_id = ANY(${versions}) AND blob_id IS NULL
    ORDER BY id FOR UPDATE`)
  await tx.execute(sql`
    UPDATE blobs SET
      live_bytes = blobs.live_bytes - released.bytes,
      state = CASE WHEN blobs.live_bytes - released.bytes <= 0 AND blobs.state = 'stored'
        THEN 'deleting'::blob_state ELSE blobs.state END
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
