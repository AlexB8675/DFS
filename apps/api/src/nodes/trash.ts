import type { Page, TrashItem } from '@dfs/shared'
import { appendJournal, uuidArray, type Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { removeStagedVersions } from '../staging.ts'
import {
  folderLocations,
  iso,
  NODE_COLUMNS,
  NODE_JOINS,
  notFound,
  toDriveNode,
  type NodeRow,
} from './read.ts'
import { lockDrive } from './write.ts'

// The trash (DESIGN.md §6.3, §6.4): what users trashed, newest first, and
// deleting it for good.

const cursorSchema = z.object({ v: z.string(), id: z.uuid() })

/** `GET /trash`: items the user trashed, newest first, with where they would go back to. */
export async function listTrash(
  db: Executor,
  auth: Auth,
  cursor: string | undefined,
  limit: number,
): Promise<Page<TrashItem>> {
  const after = cursor ? decodeTrashCursor(cursor) : null
  const resume = after
    ? sql`AND (n.deleted_at, n.id) < (${after.v}::timestamptz, ${after.id}::uuid)`
    : sql``
  const { rows } = await db.execute<NodeRow & { deleted_value: string }>(sql`
    SELECT ${NODE_COLUMNS}, n.deleted_at::text AS deleted_value
    FROM nodes n ${NODE_JOINS}
    WHERE n.owner_id = ${auth.user.id} AND n.deleted_at IS NOT NULL ${resume}
    ORDER BY n.deleted_at DESC, n.id DESC
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
      deletedAt: iso(row.deleted_at ?? row.updated_at),
      location: row.parent_id ? (locations.get(row.parent_id) ?? '') : '',
      moderationReason: row.moderation_reason,
    })),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: last.deleted_value, id: last.id })).toString('base64url')
        : null,
  }
}

/** `DELETE /trash/:id`: one trashed item, and everything below it, for good. */
export async function deleteForever(app: FastifyInstance, auth: Auth, id: string): Promise<void> {
  const staged = await app.db.transaction(async (tx) => {
    await lockDrive(tx, auth.user.id)
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM nodes
      WHERE id = ${id} AND owner_id = ${auth.user.id} AND deleted_at IS NOT NULL`)
    if (!rows[0]) throw notFound()
    return purgeSubtrees(tx, auth.user.id, [id])
  })
  await removeStagedVersions(app, staged)
}

/** `DELETE /trash`: everything the user trashed. */
export async function emptyTrash(app: FastifyInstance, auth: Auth): Promise<void> {
  const staged = await app.db.transaction(async (tx) => {
    await lockDrive(tx, auth.user.id)
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE owner_id = ${auth.user.id} AND deleted_at IS NOT NULL`)
    return purgeSubtrees(
      tx,
      auth.user.id,
      rows.map((row) => row.id),
    )
  })
  await removeStagedVersions(app, staged)
}

/**
 * Removes nodes and everything below them for good (§6.4): their versions'
 * frames stop counting toward their blobs (a blob with nothing live left is
 * marked for deletion), quota and reservations are released, and shares and
 * uploads go. Returns the versions whose staged frames can be removed once
 * the transaction commits.
 */
export async function purgeSubtrees(
  tx: Executor,
  ownerId: string,
  rootIds: readonly string[],
): Promise<string[]> {
  if (rootIds.length === 0) return []
  const { rows: subtree } = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE below AS (
      SELECT id FROM nodes WHERE id = ANY(${uuidArray(rootIds)}) AND owner_id = ${ownerId}
      UNION ALL
      SELECT child.id FROM nodes child JOIN below ON child.parent_id = below.id
    )
    SELECT id FROM below`)
  const nodeIds = uuidArray(subtree.map((row) => row.id))

  const { rows: versions } = await tx.execute<{
    id: string
    size_bytes: number
    completed: boolean
  }>(sql`
    SELECT id, size_bytes::float8 AS size_bytes, state IN ('syncing', 'stored', 'failed') AS completed
    FROM file_versions WHERE node_id = ANY(${nodeIds})`)
  const versionIds = uuidArray(versions.map((version) => version.id))
  const usedBytes = versions.reduce((total, v) => total + (v.completed ? v.size_bytes : 0), 0)

  const { rows: uploads } = await tx.execute<{ reserved: number | null }>(sql`
    DELETE FROM upload_sessions WHERE node_id = ANY(${nodeIds})
    RETURNING (CASE WHEN state = 'receiving' THEN reserved_bytes ELSE 0 END)::float8 AS reserved`)
  const reservedBytes = uploads.reduce((total, upload) => total + (upload.reserved ?? 0), 0)

  // Frames in blobs stop counting; blobs with nothing live left go to the GC.
  await tx.execute(sql`
    UPDATE blobs SET
      live_bytes = blobs.live_bytes - released.bytes,
      state = CASE WHEN blobs.live_bytes - released.bytes <= 0 AND blobs.state = 'stored'
        THEN 'deleting'::blob_state ELSE blobs.state END
    FROM (
      SELECT blob_id, sum(frame_size) AS bytes FROM chunks
      WHERE version_id = ANY(${versionIds}) AND blob_id IS NOT NULL AND purged_at IS NULL
      GROUP BY blob_id
    ) released
    WHERE blobs.id = released.blob_id`)
  await tx.execute(sql`DELETE FROM chunks WHERE version_id = ANY(${versionIds})`)
  await tx.execute(sql`UPDATE nodes SET current_version_id = NULL WHERE id = ANY(${nodeIds})`)
  await tx.execute(sql`DELETE FROM file_versions WHERE id = ANY(${versionIds})`)
  await tx.execute(sql`DELETE FROM share_links WHERE node_id = ANY(${nodeIds})`)
  await tx.execute(sql`DELETE FROM folder_stats WHERE node_id = ANY(${nodeIds})`)
  await tx.execute(sql`DELETE FROM folder_stats_dirty WHERE node_id = ANY(${nodeIds})`)
  await tx.execute(sql`DELETE FROM nodes WHERE id = ANY(${nodeIds})`)
  await tx.execute(sql`
    UPDATE users SET
      used_bytes = greatest(0, used_bytes - ${usedBytes}),
      reserved_bytes = greatest(0, reserved_bytes - ${reservedBytes})
    WHERE id = ${ownerId}`)

  await appendJournal(
    tx,
    rootIds.map((id) => ({ kind: 'node.purge', record: { id } })),
  )
  return versions.map((version) => version.id)
}

function decodeTrashCursor(text: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')))
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Invalid pagination cursor.')
  }
}
