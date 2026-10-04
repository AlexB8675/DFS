import { nameKey, type Page, type SearchResult } from '@dfs/shared'
import type { Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { Auth } from '../auth/sessions.ts'
import {
  decodeCursor,
  encodeCursor,
  folderLocations,
  NODE_COLUMNS,
  NODE_JOINS,
  toDriveNode,
  VISIBLE,
  type NodeRow,
} from './read.ts'
import { escapeLike } from './write.ts'

/**
 * `GET /search?q=`: names containing the query, ignoring case, in the user's
 * drive, outside the trash (§5.1). The trigram index serves queries of three
 * characters or more; shorter ones scan the user's nodes.
 */
export async function searchNodes(
  db: Executor,
  auth: Auth,
  query: string,
  cursor: string | undefined,
  limit: number,
): Promise<Page<SearchResult>> {
  const needle = nameKey(query)
  if (needle.length === 0) return { items: [], nextCursor: null }

  const after = cursor ? decodeCursor(cursor) : null
  const resume = after
    ? sql`AND (n.name_key COLLATE "dfs_natural", n.id) > (${after.v}::text COLLATE "dfs_natural", ${after.id}::uuid)`
    : sql``
  const { rows } = await db.execute<NodeRow & { name_key: string }>(sql`
    SELECT ${NODE_COLUMNS}, n.name_key
    FROM nodes n ${NODE_JOINS}
    WHERE n.owner_id = ${auth.user.id} AND n.parent_id IS NOT NULL AND ${VISIBLE}
      AND n.name_key LIKE ${`%${escapeLike(needle)}%`}
      ${resume}
    ORDER BY n.name_key COLLATE "dfs_natural", n.id
    LIMIT ${limit + 1}`)

  const page = rows.slice(0, limit)
  const locations = await folderLocations(
    db,
    page.flatMap((row) => row.parent_id ?? []),
  )
  const last = page.at(-1)
  return {
    items: page.map((row) => ({
      ...toDriveNode(row),
      location: row.parent_id ? (locations.get(row.parent_id) ?? '') : '',
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ k: last.kind, v: last.name_key, id: last.id })
        : null,
  }
}
