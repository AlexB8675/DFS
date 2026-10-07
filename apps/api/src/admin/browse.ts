import {
  fileCategory,
  type DriveNode,
  type FileCategory,
  type UsageCategory,
  type UserUsage,
} from '@dfs/shared'
import { appendJournal, markFoldersDirty, nodeRecords, notifyEvent, type Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit, auditAlone } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import {
  NODE_COLUMNS,
  NODE_JOINS,
  notFound,
  toDriveNode,
  VISIBLE,
  type NodeRow,
} from '../nodes/read.ts'
import { lockDrive, markTrashed } from '../nodes/write.ts'

// What admins see of other users' drives (DESIGN.md D4): names, sizes, dates
// and usage, never content; and moderation, which moves an item to its
// owner's trash with a reason. Every look and every action is audited.

const USAGE_CATEGORIES: Record<FileCategory, UsageCategory> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  archive: 'archive',
  pdf: 'document',
  text: 'document',
  code: 'document',
  spreadsheet: 'document',
  presentation: 'document',
  document: 'document',
  other: 'other',
}

/** `GET /admin/users/:id/usage`: storage by kind of file. Opening a user's drive is audited. */
export async function userUsage(
  app: FastifyInstance,
  admin: Auth,
  userId: string,
): Promise<UserUsage> {
  const { rows: users } = await app.db.execute<{ used: number; quota: number; name: string }>(sql`
    SELECT used_bytes::float8 AS used, quota_bytes::float8 AS quota, display_name AS name
    FROM users WHERE id = ${userId}`)
  const [user] = users
  if (!user) throw new ApiError(404, 'not_found', 'No such user.')

  // Grouped in SQL by extension and type, so a drive of millions of files is a few rows here.
  const { rows: groups } = await app.db.execute<{
    extension: string | null
    mime_type: string | null
    count: number
    bytes: number
  }>(sql`
    SELECT lower(substring(name from '\\.[^.]*$')) AS extension, mime_type,
      count(*)::int AS count, sum(size_bytes)::float8 AS bytes
    FROM nodes n WHERE owner_id = ${userId} AND kind = 'file' AND ${VISIBLE}
    GROUP BY 1, 2`)
  const categories = new Map<UsageCategory, { bytes: number; count: number }>()
  let fileCount = 0
  for (const group of groups) {
    const category = USAGE_CATEGORIES[fileCategory(`file${group.extension ?? ''}`, group.mime_type)]
    const entry = categories.get(category) ?? { bytes: 0, count: 0 }
    entry.bytes += group.bytes
    entry.count += group.count
    categories.set(category, entry)
    fileCount += group.count
  }

  const { rows: totals } = await app.db.execute<{ folders: number; trash: number }>(sql`
    SELECT
      count(*) FILTER (WHERE kind = 'folder' AND parent_id IS NOT NULL
        AND deleted_at IS NULL AND trashed_via IS NULL)::int AS folders,
      coalesce(sum(size_bytes) FILTER (WHERE kind = 'file'
        AND (deleted_at IS NOT NULL OR trashed_via IS NOT NULL)), 0)::float8 AS trash
    FROM nodes WHERE owner_id = ${userId}`)
  await auditAlone(app.db, { actorId: admin.user.id, action: 'admin.viewed', target: user.name })
  return {
    usedBytes: user.used,
    quotaBytes: user.quota,
    fileCount,
    folderCount: totals[0]?.folders ?? 0,
    trashBytes: totals[0]?.trash ?? 0,
    categories: [...categories]
      .map(([category, entry]) => ({ category, ...entry }))
      .sort((a, b) => b.bytes - a.bytes),
  }
}

/** Any user's node outside the trash, for the read-only browser. */
export async function anyVisibleNode(db: Executor, id: string): Promise<NodeRow> {
  const { rows } = await db.execute<NodeRow>(sql`
    SELECT ${NODE_COLUMNS} FROM nodes n ${NODE_JOINS} WHERE n.id = ${id} AND ${VISIBLE}`)
  const [node] = rows
  if (!node) throw notFound()
  return node
}

export async function adminNode(app: FastifyInstance, id: string): Promise<DriveNode> {
  return toDriveNode(await anyVisibleNode(app.db, id))
}

/**
 * `DELETE /admin/nodes/:id`: moves an item to its owner's trash with the
 * reason, which the owner sees there; their open folder updates live.
 */
export async function moderate(
  app: FastifyInstance,
  admin: Auth,
  id: string,
  reason: string,
): Promise<void> {
  await app.db.transaction(async (tx) => {
    const { rows: owners } = await tx.execute<{ owner_id: string }>(sql`
      SELECT owner_id FROM nodes WHERE id = ${id}`)
    const [owner] = owners
    if (!owner) throw notFound()
    await lockDrive(tx, owner.owner_id)
    const node = await anyVisibleNode(tx, id)
    if (!node.parent_id) throw new ApiError(403, 'forbidden', 'A root folder cannot be removed.')
    const updated = await markTrashed(tx, [id], reason)
    await markFoldersDirty(tx, [node.parent_id])
    const { rows } = await tx.execute<{ name: string }>(sql`
      SELECT display_name AS name FROM users WHERE id = ${node.owner_id}`)
    const audited = await audit(tx, {
      actorId: admin.user.id,
      action: 'node.moderated',
      target: `${node.name} (${rows[0]?.name ?? 'unknown'})`,
      details: reason,
      nodeId: id,
    })
    await notifyEvent(tx, {
      userId: node.owner_id,
      type: 'nodes.changed',
      payload: { parentIds: [node.parent_id] },
    })
    await appendJournal(tx, [...nodeRecords(updated), ...audited])
  })
}
