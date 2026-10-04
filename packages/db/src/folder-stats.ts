import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import type { Executor } from './journal.ts'
import { LOCK_NAMESPACE, LOCKS } from './locks.ts'

// Folder sizes (DESIGN.md §12.1). A change marks the folders whose direct
// contents changed; a background pass recomputes those folders and every
// ancestor, deepest first, from the tree itself. Bulk uploads into one folder
// mark it once, so they don't contend on the root's row, and recomputing
// (rather than adding up deltas) stays right when a folder with pending
// changes is moved or trashed.

/** Notes that these folders' direct contents changed. Cheap: one row per folder until folded. */
export async function markFoldersDirty(tx: Executor, folderIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(folderIds)]
  if (ids.length === 0) return
  await tx.execute(sql`
    INSERT INTO folder_stats_dirty (node_id)
    SELECT unnest(${uuidArray(ids)})
    ON CONFLICT (node_id) DO NOTHING`)
}

/**
 * Recomputes the stats of up to `batch` dirty folders and their ancestors.
 * Returns how many dirty folders it took, so a caller can loop until 0.
 */
export async function foldFolderStats(db: Database, batch = 500): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCKS.folderStats})`)
    const taken = await tx.execute<{ node_id: string }>(sql`
      DELETE FROM folder_stats_dirty
      WHERE node_id IN (SELECT node_id FROM folder_stats_dirty ORDER BY marked_at LIMIT ${batch})
      RETURNING node_id`)
    if (taken.rows.length === 0) return 0

    // Each dirty folder and its ancestors, with their depth below the root.
    const closure = await tx.execute<{ id: string; depth: number }>(sql`
      WITH RECURSIVE up (id, parent_id, origin, distance) AS (
        SELECT id, parent_id, id, 0 FROM nodes
        WHERE id = ANY(${uuidArray(taken.rows.map((row) => row.node_id))}) AND kind = 'folder'
        UNION ALL
        SELECT parent.id, parent.parent_id, up.origin, up.distance + 1
        FROM nodes parent JOIN up ON parent.id = up.parent_id
      ),
      ranked AS (
        SELECT id, max(distance) OVER (PARTITION BY origin) - distance AS depth FROM up
      )
      SELECT id, max(depth)::int AS depth FROM ranked GROUP BY id`)

    const byDepth = new Map<number, string[]>()
    for (const { id, depth } of closure.rows)
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), id])
    // Children before parents, one statement per level.
    for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
      await tx.execute(sql`
        INSERT INTO folder_stats (node_id, file_count, total_bytes, updated_at)
        SELECT folder.id,
          files.count + coalesce(subfolders.count, 0),
          files.bytes + coalesce(subfolders.bytes, 0),
          now()
        FROM unnest(${uuidArray(byDepth.get(depth) ?? [])}) AS folder(id)
        CROSS JOIN LATERAL (
          SELECT count(*) AS count, coalesce(sum(size_bytes), 0) AS bytes FROM nodes
          WHERE parent_id = folder.id AND kind = 'file' AND deleted_at IS NULL
        ) files
        CROSS JOIN LATERAL (
          SELECT sum(stats.file_count) AS count, sum(stats.total_bytes) AS bytes
          FROM nodes child JOIN folder_stats stats ON stats.node_id = child.id
          WHERE child.parent_id = folder.id AND child.kind = 'folder' AND child.deleted_at IS NULL
        ) subfolders
        ON CONFLICT (node_id) DO UPDATE SET
          file_count = excluded.file_count,
          total_bytes = excluded.total_bytes,
          updated_at = excluded.updated_at`)
    }
    return taken.rows.length
  })
}

/** Folds until nothing is dirty: for tests and for catching up. */
export async function foldAllFolderStats(db: Database): Promise<void> {
  while ((await foldFolderStats(db)) > 0) {
    // Keep going.
  }
}

/** A `uuid[]` parameter. (drizzle would expand a JS array into a list of parameters.) */
export function uuidArray(ids: readonly string[]) {
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

/** A `text[]` parameter, each value quoted the way Postgres array literals want. */
export function textArray(values: readonly string[]) {
  const quoted = values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
  return sql`${`{${quoted.join(',')}}`}::text[]`
}
