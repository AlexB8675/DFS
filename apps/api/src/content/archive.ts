import { createHash, randomBytes } from 'node:crypto'
import type { ArchiveTicket } from '@dfs/shared'
import { archiveTickets, uuidArray, type Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { NODE_COLUMNS, NODE_JOINS, VISIBLE, notFound, type NodeRow } from '../nodes/read.ts'
import { PackWarmer } from './pack-warmer.ts'
import { readVersion, type ReadableVersion } from './reader.ts'
import type { ZipEntry } from './zip.ts'

// ZIP downloads (DESIGN.md §6.2, D17): a folder, or several items through a
// short-lived, single-use link that the browser then opens with a plain
// navigation, so its download manager shows progress.

const TICKET_LIFETIME_MS = 60_000

interface TreeRow extends ReadableVersion {
  root_id: string
  path: string
  kind: 'folder' | 'file'
  updated_at: string
}

/**
 * The entries of a ZIP holding these items and everything below them, files
 * still uploading or failed left out: they can't be read. Top-level names
 * that clash get ` (1)`, … added.
 */
export async function archiveEntries(
  app: FastifyInstance,
  roots: readonly NodeRow[],
): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  if (roots.length === 0) return entries
  const trees = new Map<string, TreeRow[]>()
  for (const row of await subtrees(
    app.db,
    roots.map((root) => root.id),
  )) {
    const tree = trees.get(row.root_id)
    if (tree) tree.push(row)
    else trees.set(row.root_id, [row])
  }
  // Files are read in this order; packs most of whose frames they need are fetched whole.
  const ordered = roots.flatMap((root) => trees.get(root.id) ?? [])
  const warmer = await PackWarmer.plan(
    app,
    ordered.flatMap((row) => (row.version_id ? [row.version_id] : [])),
  )
  const taken = new Set<string>()
  for (const root of roots) {
    const top = uniqueName(root.name, taken)
    for (const row of trees.get(root.id) ?? []) {
      const path = row.path ? `${top}/${row.path}` : top
      const modifiedAt = new Date(row.updated_at)
      if (row.kind === 'folder') {
        entries.push({ path: `${path}/`, modifiedAt })
      } else if (row.version_id) {
        entries.push({
          path,
          modifiedAt,
          size: row.size_bytes,
          data: async function* () {
            await warmer?.before(row.version_id)
            yield* readVersion(app, row, 0, row.size_bytes - 1)
          },
        })
      }
    }
  }
  return entries
}

/** `POST /archive`: a one-time link for a ZIP of several items. */
export async function createArchiveTicket(
  app: FastifyInstance,
  auth: Auth,
  ids: string[],
): Promise<ArchiveTicket> {
  const nodes = await ownedVisible(app.db, auth.user.id, ids)
  if (nodes.length !== new Set(ids).size) throw notFound()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + TICKET_LIFETIME_MS)

  // Named after the folder they came from, unless that is the root.
  const parentIds = new Set(nodes.map((node) => node.parent_id))
  const [parentId] = parentIds
  let prefix = 'DFS'
  if (parentIds.size === 1 && parentId && parentId !== auth.user.rootNodeId) {
    const { rows } = await app.db.execute<{ name: string }>(
      sql`SELECT name FROM nodes WHERE id = ${parentId}`,
    )
    prefix = rows[0]?.name ?? prefix
  }
  const fileName = `${prefix} (${String(nodes.length)} items).zip`
  await app.db.insert(archiveTickets).values({
    tokenHash: hash(token),
    userId: auth.user.id,
    nodeIds: nodes.map((node) => node.id),
    fileName,
    expiresAt,
  })
  return { url: `/api/archive/${token}`, fileName, expiresAt: expiresAt.toISOString() }
}

/** `GET /archive/:token`: redeems a link, once. Items trashed meanwhile are left out. */
export async function redeemArchiveTicket(
  app: FastifyInstance,
  auth: Auth,
  token: string,
): Promise<{ fileName: string; nodes: NodeRow[] }> {
  const { rows } = await app.db.execute<{ node_ids: string[]; file_name: string }>(sql`
    DELETE FROM archive_tickets
    WHERE token_hash = ${hash(token)} AND user_id = ${auth.user.id} AND expires_at > now()
    RETURNING node_ids, file_name`)
  const [ticket] = rows
  if (!ticket) throw new ApiError(404, 'archive_expired', 'This download link has expired.')
  return {
    fileName: ticket.file_name,
    nodes: await ownedVisible(app.db, auth.user.id, ticket.node_ids),
  }
}

async function ownedVisible(db: Executor, ownerId: string, ids: string[]): Promise<NodeRow[]> {
  const { rows } = await db.execute<NodeRow>(sql`
    SELECT ${NODE_COLUMNS} FROM nodes n ${NODE_JOINS}
    WHERE n.id = ANY(${uuidArray([...new Set(ids)])}) AND n.owner_id = ${ownerId} AND ${VISIBLE}
    ORDER BY n.kind, n.name_key COLLATE "dfs_natural"`)
  return rows
}

/** Selected nodes and their visible descendants, with paths relative to each root. */
async function subtrees(db: Executor, rootIds: string[]): Promise<TreeRow[]> {
  const { rows } = await db.execute<TreeRow>(sql`
    WITH RECURSIVE tree AS (
      SELECT id AS root_id, id, kind, ''::text AS path, current_version_id, updated_at
      FROM nodes WHERE id = ANY(${uuidArray(rootIds)}) AND deleted_at IS NULL AND trashed_via IS NULL
      UNION ALL
      SELECT tree.root_id, child.id, child.kind,
        CASE WHEN tree.path = '' THEN child.name ELSE tree.path || '/' || child.name END,
        child.current_version_id,
        child.updated_at
      FROM nodes child JOIN tree ON child.parent_id = tree.id
      WHERE child.deleted_at IS NULL AND child.trashed_via IS NULL
    )
    SELECT tree.root_id, tree.path, tree.kind, tree.updated_at::text AS updated_at,
      version.id AS version_id, version.size_bytes::float8 AS size_bytes, version.chunk_size,
      version.chunk_count, version.wrapped_dek, version.key_id
    FROM tree
    LEFT JOIN file_versions version
      ON version.id = tree.current_version_id AND version.state IN ('syncing', 'stored')
    ORDER BY tree.root_id, tree.path COLLATE "C"`)
  return rows
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name
  for (let n = 1; taken.has(candidate.toLowerCase()); n += 1) candidate = `${name} (${String(n)})`
  taken.add(candidate.toLowerCase())
  return candidate
}

function hash(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}
