import type { TrashPage } from '@dfs/shared'
import { appendJournal, purgeSubtrees, type Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.ts'
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

/**
 * `GET /trash`: items the user trashed, newest first, with where they would
 * go back to, and how long the trash keeps them.
 */
export async function listTrash(
  db: Executor,
  auth: Auth,
  cursor: string | undefined,
  limit: number,
  retentionDays: number,
): Promise<TrashPage> {
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
    retentionDays,
  }
}

/** `DELETE /trash/:id`: one trashed item, and everything below it, for good. */
export async function deleteForever(app: FastifyInstance, auth: Auth, id: string): Promise<void> {
  const staged = await app.db.transaction(async (tx) => {
    await lockDrive(tx, auth.user.id)
    const { rows } = await tx.execute<TrashedRow>(sql`
      SELECT id, name FROM nodes
      WHERE id = ${id} AND owner_id = ${auth.user.id} AND deleted_at IS NOT NULL`)
    if (!rows[0]) throw notFound()
    const purged = await purgeSubtrees(tx, auth.user.id, [id])
    const audited = await audit(tx, purgedEntries(auth, rows, null))
    await appendJournal(tx, [...purged.records, ...audited])
    return purged.versionIds
  })
  await removeStagedVersions(app, staged)
}

/** `DELETE /trash`: everything the user trashed. */
export async function emptyTrash(app: FastifyInstance, auth: Auth): Promise<void> {
  const staged = await app.db.transaction(async (tx) => {
    await lockDrive(tx, auth.user.id)
    const { rows } = await tx.execute<TrashedRow>(sql`
      SELECT id, name FROM nodes WHERE owner_id = ${auth.user.id} AND deleted_at IS NOT NULL`)
    const purged = await purgeSubtrees(
      tx,
      auth.user.id,
      rows.map((row) => row.id),
    )
    const audited = await audit(tx, purgedEntries(auth, rows, 'emptied the trash'))
    await appendJournal(tx, [...purged.records, ...audited])
    return purged.versionIds
  })
  await removeStagedVersions(app, staged)
}

interface TrashedRow extends Record<string, unknown> {
  id: string
  name: string
}

/** One audit entry per item deleted for good; what was below it goes unnamed. */
function purgedEntries(auth: Auth, rows: readonly TrashedRow[], details: string | null) {
  return rows.map((row) => ({
    actorId: auth.user.id,
    action: 'node.purged',
    target: row.name,
    details,
    nodeId: row.id,
  }))
}

function decodeTrashCursor(text: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')))
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Invalid pagination cursor.')
  }
}
