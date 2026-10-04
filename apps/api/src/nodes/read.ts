import type {
  DriveNode,
  NodeKind,
  NodePath,
  Page,
  SortField,
  SortOrder,
  SyncState,
} from '@dfs/shared'
import { uuidArray, type Executor } from '@dfs/db'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { ApiError } from '../errors.ts'

// Reading the tree (DESIGN.md §5.1, §9): one query per page, keyset
// pagination with folders first, and an index scan for every sort order.

/** A node as the API shows it, straight from SQL. */
export interface NodeRow extends Record<string, unknown> {
  id: string
  owner_id: string
  parent_id: string | null
  kind: NodeKind
  name: string
  mime_type: string | null
  size_bytes: number
  /** Raw SQL returns timestamps as text (drizzle's driver setup); `iso` reads them. */
  created_at: string
  updated_at: string
  deleted_at: string | null
  trashed_via: string | null
  moderation_reason: string | null
  version_state: string | null
  has_child_folders: boolean
}

/** The columns of a `NodeRow`, for `FROM nodes n` joined with `NODE_JOINS`. */
export const NODE_COLUMNS = sql`
  n.id, n.owner_id, n.parent_id, n.kind, n.name, n.mime_type, n.created_at, n.updated_at,
  n.deleted_at, n.trashed_via, n.moderation_reason,
  (CASE WHEN n.kind = 'folder' THEN coalesce(stats.total_bytes, 0) ELSE n.size_bytes END)::float8
    AS size_bytes,
  version.state::text AS version_state,
  (n.kind = 'folder' AND EXISTS (
    SELECT 1 FROM nodes child
    WHERE child.parent_id = n.id AND child.kind = 'folder' AND child.deleted_at IS NULL
  )) AS has_child_folders`

export const NODE_JOINS = sql`
  LEFT JOIN file_versions version ON version.id = n.current_version_id
  LEFT JOIN folder_stats stats ON stats.node_id = n.id`

/** Not in the trash, and not inside a trashed folder. */
export const VISIBLE = sql`n.deleted_at IS NULL AND n.trashed_via IS NULL`

export function toDriveNode(row: NodeRow): DriveNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    syncState: row.kind === 'file' ? syncState(row.version_state) : null,
    hasChildFolders: row.has_child_folders,
  }
}

/** A timestamp from raw SQL, as the ISO string the API sends. */
export function iso(timestamp: string): string {
  return new Date(timestamp).toISOString()
}

/** A file's state as the UI shows it. A file with no completed version is still uploading. */
function syncState(versionState: string | null): SyncState {
  switch (versionState) {
    case null:
    case 'uploading':
      return 'uploading'
    case 'syncing':
      return 'syncing'
    case 'stored':
      return 'stored'
    default:
      return 'failed'
  }
}

/** One of the owner's nodes that is not in the trash, or a 404. */
export async function visibleNode(db: Executor, ownerId: string, id: string): Promise<NodeRow> {
  const { rows } = await db.execute<NodeRow>(sql`
    SELECT ${NODE_COLUMNS} FROM nodes n ${NODE_JOINS}
    WHERE n.id = ${id} AND n.owner_id = ${ownerId} AND ${VISIBLE}`)
  const [row] = rows
  if (!row) throw notFound()
  return row
}

/** Like `visibleNode`, for a folder that something goes into. */
export async function visibleFolder(db: Executor, ownerId: string, id: string): Promise<NodeRow> {
  const folder = await visibleNode(db, ownerId, id)
  if (folder.kind !== 'folder') {
    throw new ApiError(400, 'not_a_folder', 'The target is not a folder.')
  }
  return folder
}

/** From the root folder down to the node itself. */
export async function nodePath(db: Executor, id: string): Promise<NodePath> {
  const { rows } = await db.execute<{ id: string; name: string }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, name, 0 AS depth FROM nodes WHERE id = ${id}
      UNION ALL
      SELECT parent.id, parent.parent_id, parent.name, chain.depth + 1
      FROM nodes parent JOIN chain ON parent.id = chain.parent_id
    )
    SELECT id, name FROM chain ORDER BY depth DESC`)
  return rows
}

/**
 * Where each folder is, as `My Drive / Photos / 2024`, for a whole page of
 * search or trash results in one query.
 */
export async function folderLocations(
  db: Executor,
  folderIds: readonly string[],
): Promise<Map<string, string>> {
  if (folderIds.length === 0) return new Map()
  const { rows } = await db.execute<{ origin: string; location: string }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id AS origin, id, parent_id, name, 0 AS depth
      FROM nodes WHERE id = ANY(${uuidArray([...new Set(folderIds)])})
      UNION ALL
      SELECT chain.origin, parent.id, parent.parent_id, parent.name, chain.depth + 1
      FROM nodes parent JOIN chain ON parent.id = chain.parent_id
    )
    SELECT origin, string_agg(name, ' / ' ORDER BY depth DESC) AS location
    FROM chain GROUP BY origin`)
  return new Map(rows.map((row) => [row.origin, row.location]))
}

// ── Folder listings ──────────────────────────────────────────────────────────

export interface ListOptions {
  kind?: NodeKind | undefined
  sort: SortField
  order: SortOrder
  cursor?: string | undefined
  limit: number
}

/** Where a page ended: the segment (folders, then files), its sort value, and the ID. */
const cursorSchema = z.object({ k: z.enum(['folder', 'file']), v: z.string(), id: z.uuid() })
type Cursor = z.infer<typeof cursorSchema>

/** `GET /nodes/:id/children`: folders first, then files, each sorted as asked. */
export async function listChildren(
  db: Executor,
  parentId: string,
  options: ListOptions,
): Promise<Page<DriveNode>> {
  const after = options.cursor ? decodeCursor(options.cursor) : null
  const segments: NodeKind[] = options.kind ? [options.kind] : ['folder', 'file']
  const start = after ? segments.indexOf(after.k) : 0
  if (start < 0) throw invalidCursor()

  // One more than a page, to know whether another page follows.
  const rows: (NodeRow & { sort_value: string })[] = []
  for (const kind of segments.slice(start)) {
    const wanted = options.limit + 1 - rows.length
    if (wanted <= 0) break
    rows.push(
      ...(await listSegment(db, parentId, kind, options, after?.k === kind ? after : null, wanted)),
    )
  }

  const page = rows.slice(0, options.limit)
  const last = page.at(-1)
  const more = rows.length > options.limit && last !== undefined
  return {
    items: page.map(toDriveNode),
    nextCursor: more ? encodeCursor({ k: last.kind, v: last.sort_value, id: last.id }) : null,
  }
}

async function listSegment(
  db: Executor,
  parentId: string,
  kind: NodeKind,
  options: ListOptions,
  after: Cursor | null,
  limit: number,
): Promise<(NodeRow & { sort_value: string })[]> {
  const { expression, cast } = sortExpression(options.sort, kind)
  const direction = options.order === 'asc' ? sql`ASC` : sql`DESC`
  const comparison = options.order === 'asc' ? sql`>` : sql`<`
  const resume = after
    ? sql`AND (${expression}, n.id) ${comparison} (${cast(after.v)}, ${after.id}::uuid)`
    : sql``
  const { rows } = await db.execute<NodeRow & { sort_value: string }>(sql`
    SELECT ${NODE_COLUMNS}, (${expression})::text AS sort_value
    FROM nodes n ${NODE_JOINS}
    WHERE n.parent_id = ${parentId} AND n.kind = ${kind} AND n.deleted_at IS NULL ${resume}
    ORDER BY ${expression} ${direction}, n.id ${direction}
    LIMIT ${limit}`)
  return rows
}

function sortExpression(
  sort: SortField,
  kind: NodeKind,
): { expression: SQL; cast: (value: string) => SQL } {
  switch (sort) {
    case 'name':
      return {
        expression: sql`n.name_key COLLATE "dfs_natural"`,
        cast: (value) => sql`${value}::text COLLATE "dfs_natural"`,
      }
    case 'updatedAt':
      return { expression: sql`n.updated_at`, cast: (value) => sql`${value}::timestamptz` }
    case 'size':
      // Folder sizes come from their stats, so that segment can't use an index; folders are few.
      return {
        expression: kind === 'folder' ? sql`coalesce(stats.total_bytes, 0)` : sql`n.size_bytes`,
        cast: (value) => sql`${value}::bigint`,
      }
  }
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export function decodeCursor(text: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')))
  } catch {
    throw invalidCursor()
  }
}

function invalidCursor(): ApiError {
  return new ApiError(400, 'invalid_cursor', 'Invalid pagination cursor.')
}

export function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'This item no longer exists.')
}
