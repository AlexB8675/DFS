import { abandonUploads, shareLinks } from '@dfs/db'
import type { AdminSession, AdminShare, AdminUpload, Page } from '@dfs/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import { endSession, endUserSessions, type Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { removeStagedVersions } from '../staging.ts'

// Admin → Access (DESIGN.md §9): who is signed in, every share link, and the
// uploads under way, each of which an admin can end. Sessions are named by
// the start of their hash and shares by their ID: nothing here can sign in
// or open a link (D4). The owner's sessions are the owner's to end.

/** How much of a session's hash names it. */
const KEY_LENGTH = 16

/** `GET /admin/sessions`: live sessions, most recently used first; one user's with `userId`. */
export async function listSessions(
  app: FastifyInstance,
  admin: Auth,
  userId: string | undefined,
): Promise<AdminSession[]> {
  const { rows } = await app.db.execute<{
    key: string
    user_id: string
    user_name: string
    created_at: string
    last_seen_at: string | null
    expires_at: string
    ip: string | null
    user_agent: string | null
    limited: boolean
    current: boolean
    can_sign_out: boolean
  }>(sql`
    SELECT left(session.id, ${KEY_LENGTH}) AS key, session.user_id,
      account.display_name AS user_name, session.created_at::text AS created_at,
      session.last_seen_at::text AS last_seen_at, session.expires_at::text AS expires_at,
      session.ip, session.user_agent, account.password_expires_at IS NOT NULL AS limited,
      session.id = ${admin.sessionId} AS current,
      -- As endSessionAsAdmin allows: never this session, and the owner's only by the owner.
      session.id <> ${admin.sessionId} AND (NOT account.is_owner OR ${admin.user.isOwner})
        AS can_sign_out
    FROM sessions session JOIN users account ON account.id = session.user_id
    WHERE session.expires_at > now() ${userId ? sql`AND session.user_id = ${userId}` : sql``}
    ORDER BY coalesce(session.last_seen_at, session.created_at) DESC LIMIT 500`)
  return rows.map((row) => ({
    key: row.key,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: iso(row.created_at),
    lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null,
    expiresAt: iso(row.expires_at),
    ip: row.ip,
    userAgent: row.user_agent,
    limited: row.limited,
    current: row.current,
    canSignOut: row.can_sign_out,
  }))
}

/** `DELETE /admin/sessions/:key`: signs one session out. */
export async function endSessionAsAdmin(
  app: FastifyInstance,
  admin: Auth,
  key: string,
): Promise<void> {
  const { rows } = await app.db.execute<{
    id: string
    user_name: string
    is_owner: boolean
    ip: string | null
  }>(sql`
    SELECT session.id, account.display_name AS user_name, account.is_owner, session.ip
    FROM sessions session JOIN users account ON account.id = session.user_id
    WHERE left(session.id, ${KEY_LENGTH}) = ${key} AND session.expires_at > now()`)
  const [session] = rows
  if (!session || rows.length > 1) throw new ApiError(404, 'not_found', 'No such session.')
  if (session.id === admin.sessionId) {
    throw new ApiError(409, 'self_change', 'That is this session: sign out instead.')
  }
  if (session.is_owner && !admin.user.isOwner) {
    throw new ApiError(409, 'owner_protected', 'Only the owner can sign the owner out.')
  }
  await endSession(app.db, session.id)
  await audit(app.db, {
    actorId: admin.user.id,
    action: 'session.ended',
    target: session.user_name,
    details: session.ip ?? undefined,
  })
}

/**
 * `POST /admin/users/:id/sign-out`: ends every session of a user; of the
 * admin's own, every one but this. Returns how many ended.
 */
export async function signOutUser(
  app: FastifyInstance,
  admin: Auth,
  userId: string,
): Promise<number> {
  const { rows } = await app.db.execute<{ display_name: string; is_owner: boolean }>(sql`
    SELECT display_name, is_owner FROM users WHERE id = ${userId}`)
  const [user] = rows
  if (!user) throw new ApiError(404, 'not_found', 'No such user.')
  if (user.is_owner && !admin.user.isOwner) {
    throw new ApiError(409, 'owner_protected', 'Only the owner can sign the owner out.')
  }
  const { rows: live } = await app.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM sessions
    WHERE user_id = ${userId} AND expires_at > now() AND id <> ${admin.sessionId}`)
  await endUserSessions(app.db, userId, userId === admin.user.id ? admin.sessionId : undefined)
  await audit(app.db, {
    actorId: admin.user.id,
    action: 'user.signed_out',
    target: user.display_name,
  })
  return live[0]?.count ?? 0
}

interface ShareRow extends Record<string, unknown> {
  id: string
  node_id: string
  node_name: string
  node_kind: 'file' | 'folder'
  owner_id: string
  owner_name: string
  parent_id: string | null
  created_at: string
  expires_at: string | null
  has_password: boolean
  max_downloads: number | null
  download_count: number
  revoked_at: string | null
}

const SELECT_SHARES = sql`
  SELECT share.id, share.node_id, node.name AS node_name, node.kind AS node_kind,
    node.owner_id, owner.display_name AS owner_name, node.parent_id,
    share.created_at::text AS created_at, share.expires_at::text AS expires_at,
    share.password_hash IS NOT NULL AS has_password, share.max_downloads, share.download_count,
    share.revoked_at::text AS revoked_at
  FROM share_links share
  JOIN nodes node ON node.id = share.node_id
  JOIN users owner ON owner.id = node.owner_id`

/** `GET /admin/shares`: every user's links, newest first; only those still working with `active`. */
export async function listShares(
  app: FastifyInstance,
  options: { cursor: string | undefined; limit: number; active: boolean },
): Promise<Page<AdminShare>> {
  const { cursor, limit, active } = options
  const { rows } = await app.db.execute<ShareRow>(sql`
    ${SELECT_SHARES}
    WHERE true
      ${cursor ? sql`AND share.id < ${cursor}` : sql``}
      ${
        active
          ? sql`AND share.revoked_at IS NULL
              AND (share.expires_at IS NULL OR share.expires_at > now())
              AND (share.max_downloads IS NULL OR share.download_count < share.max_downloads)`
          : sql``
      }
    ORDER BY share.id DESC LIMIT ${limit + 1}`)
  const page = rows.slice(0, limit)
  return {
    items: page.map(toAdminShare),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  }
}

/** `DELETE /admin/shares/:id`: turns any user's link off for good. */
export async function revokeShareAsAdmin(
  app: FastifyInstance,
  admin: Auth,
  id: string,
): Promise<void> {
  const { rows } = await app.db.execute<ShareRow>(sql`${SELECT_SHARES} WHERE share.id = ${id}`)
  const [share] = rows
  if (!share) throw new ApiError(404, 'not_found', 'No such link.')
  const revoked = await app.db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
    .returning({ id: shareLinks.id })
  // Off already: nothing changed, so nothing to note.
  if (revoked.length === 0) return
  await audit(app.db, {
    actorId: admin.user.id,
    action: 'share.revoked',
    target: share.node_name,
    nodeId: share.node_id,
    details: `${share.owner_name}’s link`,
  })
}

/** `GET /admin/uploads`: uploads still receiving parts, oldest first. */
export async function listUploads(app: FastifyInstance): Promise<AdminUpload[]> {
  const { rows } = await app.db.execute<{
    id: string
    user_id: string
    user_name: string
    node_id: string
    file_name: string
    parent_id: string | null
    size_bytes: number
    received_bytes: number
    created_at: string
    expires_at: string
  }>(sql`
    SELECT upload.id, upload.user_id, account.display_name AS user_name, upload.node_id,
      node.name AS file_name, node.parent_id, version.size_bytes::float8 AS size_bytes,
      (SELECT coalesce(sum(plain_size), 0)::float8 FROM chunks
        WHERE version_id = upload.version_id) AS received_bytes,
      upload.created_at::text AS created_at, upload.expires_at::text AS expires_at
    FROM upload_sessions upload
    JOIN users account ON account.id = upload.user_id
    JOIN nodes node ON node.id = upload.node_id
    JOIN file_versions version ON version.id = upload.version_id
    WHERE upload.state = 'receiving' AND upload.expires_at > now()
    ORDER BY upload.created_at LIMIT 200`)
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    nodeId: row.node_id,
    fileName: row.file_name,
    parentId: row.parent_id,
    sizeBytes: row.size_bytes,
    receivedBytes: row.received_bytes,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  }))
}

/**
 * `DELETE /admin/uploads/:id`: gives up any user's upload, as cancelling it
 * would: its parts go, and its reservation is given back.
 */
export async function cancelUploadAsAdmin(
  app: FastifyInstance,
  admin: Auth,
  id: string,
): Promise<void> {
  const { found, staged } = await app.db.transaction(async (tx) => {
    // Locked, as the deletion below would lock it first anyway (locks.ts): an
    // upload completing meanwhile finishes before this looks, or waits.
    const { rows } = await tx.execute<{ file_name: string; user_name: string }>(sql`
      SELECT node.name AS file_name, account.display_name AS user_name
      FROM upload_sessions upload
      JOIN nodes node ON node.id = upload.node_id
      JOIN users account ON account.id = upload.user_id
      WHERE upload.id = ${id} AND upload.state = 'receiving'
      FOR UPDATE OF upload`)
    const [upload] = rows
    return { found: upload, staged: upload ? await abandonUploads(tx, [id]) : [] }
  })
  if (!found) throw new ApiError(404, 'not_found', 'No such upload under way.')
  await removeStagedVersions(app, staged)
  await audit(app.db, {
    actorId: admin.user.id,
    action: 'upload.cancelled',
    target: found.file_name,
    details: `${found.user_name}’s upload`,
  })
}

function toAdminShare(row: ShareRow): AdminShare {
  const now = Date.now()
  const state = row.revoked_at
    ? 'revoked'
    : row.expires_at && Date.parse(row.expires_at) <= now
      ? 'expired'
      : row.max_downloads !== null && row.download_count >= row.max_downloads
        ? 'used_up'
        : 'active'
  return {
    id: row.id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    nodeKind: row.node_kind,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    parentId: row.parent_id,
    createdAt: iso(row.created_at),
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    hasPassword: row.has_password,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    state,
  }
}

function iso(value: string): string {
  return new Date(value).toISOString()
}
