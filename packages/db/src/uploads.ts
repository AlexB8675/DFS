import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { notifyEvent } from './events.ts'
import { markFoldersDirty, uuidArray } from './folder-stats.ts'
import type { Executor } from './journal.ts'
import { purgeSubtrees, purgeVersions, releaseReservation } from './purge.ts'

/**
 * Gives up uploads that are still receiving: cancelled by the client, or
 * expired (DESIGN.md §6.1). Their reservations are released and their
 * versions purged; a file that never had a completed version goes with them.
 * None of it was journaled, so none of it is (§8): a file joins the journal
 * with its first completed version, a version once it is stored. Returns the
 * versions whose staged frames can be removed after commit.
 */
export async function abandonUploads(
  tx: Executor,
  sessionIds: readonly string[],
): Promise<string[]> {
  if (sessionIds.length === 0) return []
  const { rows } = await tx.execute<{
    user_id: string
    node_id: string
    version_id: string
    reserved: number
  }>(sql`
    DELETE FROM upload_sessions session
    WHERE session.id = ANY(${uuidArray(sessionIds)}) AND session.state = 'receiving'
    RETURNING session.user_id, session.node_id, session.version_id,
      session.reserved_bytes::float8 AS reserved`)
  if (rows.length === 0) return []

  // Locks in the order of locks.ts: files, owners, then the folders that lose
  // a file. Keep the file's key-share lock available to an upload that already
  // holds the owner's quota row, so its foreign keys cannot create a deadlock.
  const nodeIds = [...new Set(rows.map((row) => row.node_id))].sort()
  const { rows: files } = await tx.execute<{
    id: string
    parent_id: string | null
    current_version_id: string | null
  }>(sql`
    SELECT id, parent_id, current_version_id FROM nodes
    WHERE id = ANY(${uuidArray(nodeIds)}) ORDER BY id FOR NO KEY UPDATE`)
  const reservations = new Map<string, number>()
  for (const row of rows)
    reservations.set(row.user_id, (reservations.get(row.user_id) ?? 0) + row.reserved)
  for (const ownerId of [...reservations.keys()].sort())
    await releaseReservation(tx, ownerId, reservations.get(ownerId) ?? 0)

  // Cancelling one version must preserve other uploads onto the same file.
  // Read after taking the node locks: another version may have completed
  // while cancellation waited. The quota lock also waits for newly started
  // versions to commit before this check. A file goes only when nothing remains.
  const { rows: remaining } = await tx.execute<{ node_id: string }>(sql`
    SELECT DISTINCT node_id FROM file_versions
    WHERE node_id = ANY(${uuidArray(nodeIds)})
      AND id <> ALL(${uuidArray(rows.map((row) => row.version_id))})`)
  const retained = new Set(remaining.map((version) => version.node_id))
  const unfinished = new Set(
    files
      .filter((file) => !file.current_version_id && !retained.has(file.id))
      .map((file) => file.id),
  )
  await markFoldersDirty(
    tx,
    files.filter((file) => unfinished.has(file.id)).flatMap((file) => file.parent_id ?? []),
  )

  const staged: string[] = []
  const unfinishedByOwner = new Map<string, Set<string>>()
  const versionsByOwner = new Map<string, string[]>()
  for (const row of rows) {
    if (unfinished.has(row.node_id)) {
      const ids = unfinishedByOwner.get(row.user_id)
      if (ids) ids.add(row.node_id)
      else unfinishedByOwner.set(row.user_id, new Set([row.node_id]))
    } else {
      const ids = versionsByOwner.get(row.user_id)
      if (ids) ids.push(row.version_id)
      else versionsByOwner.set(row.user_id, [row.version_id])
    }
  }
  for (const [ownerId, nodeIds] of unfinishedByOwner) {
    const purged = await purgeSubtrees(tx, ownerId, [...nodeIds])
    staged.push(...purged.versionIds)
  }
  for (const [ownerId, versionIds] of versionsByOwner) {
    await purgeVersions(tx, ownerId, versionIds)
    staged.push(...versionIds)
  }
  return staged
}

/**
 * Gives up uploads whose page has said nothing for `idleMinutes` (§6.1): it
 * closed without cancelling them, crashed or lost its network. At most
 * `limit` at a time; their open folders are told the files went. Returns
 * the versions whose staged frames the caller removes.
 */
export async function abandonIdleUploads(
  db: Database,
  idleMinutes: number,
  limit = 500,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string; user_id: string; parent_id: string | null }>(
      sql`
        SELECT session.id, session.user_id, node.parent_id
        FROM upload_sessions session JOIN nodes node ON node.id = session.node_id
        WHERE session.state = 'receiving'
          AND session.alive_at < now() - make_interval(mins => ${idleMinutes}::int)
        ORDER BY session.id LIMIT ${limit}
        FOR UPDATE OF session SKIP LOCKED`,
    )
    if (rows.length === 0) return []
    const staged = await abandonUploads(
      tx,
      rows.map((row) => row.id),
    )
    for (const [userId, sessions] of Map.groupBy(rows, (row) => row.user_id)) {
      const parentIds = [...new Set(sessions.flatMap((row) => row.parent_id ?? []))]
      await notifyEvent(tx, { userId, type: 'nodes.changed', payload: { parentIds } })
    }
    return staged
  })
}
