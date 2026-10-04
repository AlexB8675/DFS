import type { Page, TrashItem } from '@dfs/shared'
import { purgeSubtrees, type Executor } from '@dfs/db'
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

function decodeTrashCursor(text: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')))
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Invalid pagination cursor.')
  }
}
