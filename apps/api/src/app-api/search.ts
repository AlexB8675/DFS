import type { Executor } from '@dfs/db'
import { nameKey, type AppItem } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import {
  decodeCursor,
  encodeCursor,
  NODE_COLUMNS,
  NODE_JOINS,
  VISIBLE,
  type NodeRow,
} from '../nodes/read.ts'
import { escapeLike } from '../nodes/write.ts'
import { toAppItem } from './items.ts'
import { joinPath } from './paths.ts'

/**
 * `GET /v1/search`: names containing the query, ignoring case, in the token's
 * folder and the visible My drive folders below it, never owner-wide. The
 * folder itself is not a result. Paged as the drive's search is.
 */
export async function searchFolder(
  db: Executor,
  folder: NodeRow,
  query: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: AppItem[]; nextCursor: string | null }> {
  const needle = nameKey(query)
  if (needle.length === 0) return { items: [], nextCursor: null }

  const after = cursor ? decodeCursor(cursor) : null
  const resume = after
    ? sql`AND (n.name_key COLLATE "dfs_natural", n.id) > (${after.v}::text COLLATE "dfs_natural", ${after.id}::uuid)`
    : sql``
  const { rows } = await db.execute<NodeRow & { name_key: string; parent_path: string }>(sql`
    WITH RECURSIVE reach AS (
      SELECT ${folder.id}::uuid AS id, ''::text AS path
      UNION ALL
      SELECT sub.id, CASE WHEN reach.path = '' THEN sub.name ELSE reach.path || '/' || sub.name END
      FROM nodes sub /* tree: by parent, drive only */ JOIN reach ON sub.parent_id = reach.id
      WHERE sub.kind = 'folder' AND sub.owner_id = ${folder.owner_id} AND sub.tree = 'drive'
        AND sub.deleted_at IS NULL AND sub.trashed_via IS NULL
    )
    SELECT ${NODE_COLUMNS}, n.name_key, reach.path AS parent_path
    FROM nodes n /* tree: by parent, drive only */ JOIN reach ON n.parent_id = reach.id ${NODE_JOINS}
    WHERE n.owner_id = ${folder.owner_id} AND n.tree = 'drive' AND ${VISIBLE}
      AND (n.kind = 'folder' OR n.current_version_id IS NOT NULL)
      AND n.name_key LIKE ${`%${escapeLike(needle)}%`}
      ${resume}
    ORDER BY n.name_key COLLATE "dfs_natural", n.id
    LIMIT ${limit + 1}`)

  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => toAppItem(row, joinPath(row.parent_path, row.name))),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ k: last.kind, v: last.name_key, id: last.id })
        : null,
  }
}
