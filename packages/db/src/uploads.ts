import { sql } from 'drizzle-orm'
import { markFoldersDirty, uuidArray } from './folder-stats.ts'
import { appendJournal, type Executor, type JournalRecord } from './journal.ts'
import { purgeSubtrees, purgeVersions, releaseReservation } from './purge.ts'

/**
 * Gives up uploads that are still receiving: cancelled by the client, or
 * expired (DESIGN.md §6.1). Their reservations are released and their
 * versions purged; a file that never had a completed version goes with them.
 * Returns the versions whose staged frames can be removed after commit.
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
    first_version: boolean
    parent_id: string | null
    has_current: boolean
  }>(sql`
    DELETE FROM upload_sessions session
    USING file_versions version, nodes node
    WHERE session.id = ANY(${uuidArray(sessionIds)}) AND session.state = 'receiving'
      AND version.id = session.version_id AND node.id = session.node_id
    RETURNING session.user_id, session.node_id, session.version_id,
      session.reserved_bytes::float8 AS reserved, version.version_no = 1 AS first_version,
      node.parent_id, node.current_version_id IS NOT NULL AS has_current`)

  // Locks in the order of locks.ts: files, owners, then the folders that lose a file.
  const nodeIds = [...new Set(rows.map((row) => row.node_id))].sort()
  await tx.execute(
    sql`SELECT id FROM nodes WHERE id = ANY(${uuidArray(nodeIds)}) ORDER BY id FOR UPDATE`,
  )
  for (const row of rows) await releaseReservation(tx, row.user_id, row.reserved)
  // A file that never had a completed version goes with its upload.
  const unfinished = (row: (typeof rows)[number]) => row.first_version && !row.has_current
  await markFoldersDirty(
    tx,
    rows.filter(unfinished).flatMap((row) => row.parent_id ?? []),
  )

  const staged: string[] = []
  const records: JournalRecord[] = []
  for (const row of rows) {
    if (unfinished(row)) {
      const purged = await purgeSubtrees(tx, row.user_id, [row.node_id])
      staged.push(...purged.versionIds)
      records.push(...purged.records)
    } else {
      records.push(...(await purgeVersions(tx, row.user_id, [row.version_id])))
      staged.push(row.version_id)
    }
  }
  await appendJournal(tx, records)
  return staged
}
