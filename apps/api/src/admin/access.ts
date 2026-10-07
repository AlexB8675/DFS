import {
  abandonUploads,
  appendJournal,
  shareDeletedRecords,
  shareLinks,
  WORKING_LINK,
} from '@dfs/db'
import type { AdminSession, AdminShare, AdminShareOwner, AdminUpload, Page } from '@dfs/shared'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit, auditAlone } from '../audit.ts'
import { endSession, endUserSessions, type Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { escapeLike } from '../nodes/write.ts'
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
  await auditAlone(app.db, {
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
  await auditAlone(app.db, {
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
}

const SELECT_SHARES = sql`
  SELECT share.id, share.node_id, node.name AS node_name, node.kind AS node_kind,
    node.owner_id, owner.display_name AS owner_name, node.parent_id,
    share.created_at::text AS created_at, share.expires_at::text AS expires_at,
    share.password_hash IS NOT NULL AS has_password, share.max_downloads, share.download_count
  FROM share_links share
  JOIN nodes node ON node.id = share.node_id
  JOIN users owner ON owner.id = node.owner_id`

interface ListedRow extends ShareRow {
  owner_username: string
  path: string
  version: AdminShare['version']
  working: boolean
}

/**
 * Every link as the admin pages list it, `listed`: with its owner, the
 * folders its item is in, the version it serves, and whether it works. With
 * `q`, only links whose item, folder path or owner contains it.
 */
function listedShares(q: string | undefined) {
  const words = q ? `%${escapeLike(q)}%` : null
  return sql`
    WITH RECURSIVE chain AS (
      SELECT link.id AS share_id, node.parent_id AS next, ''::text AS path
      FROM share_links link JOIN nodes node ON node.id = link.node_id
      UNION ALL
      -- Up to the top, leaving out the root, which every path starts in.
      SELECT chain.share_id, parent.parent_id,
        CASE
          WHEN parent.parent_id IS NULL THEN chain.path
          WHEN chain.path = '' THEN parent.name
          ELSE parent.name || ' / ' || chain.path
        END
      FROM chain JOIN nodes parent ON parent.id = chain.next
    ), listed AS (
      SELECT link.id, link.node_id, node.name AS node_name, node.kind AS node_kind,
        node.owner_id, owner.display_name AS owner_name, owner.username AS owner_username,
        node.parent_id, chain.path,
        link.created_at::text AS created_at, link.expires_at::text AS expires_at,
        link.password_hash IS NOT NULL AS has_password, link.max_downloads,
        link.download_count,
        CASE
          WHEN node.kind = 'folder' THEN NULL
          WHEN link.version_id IS NULL THEN 'deleted'
          WHEN link.version_id = node.current_version_id THEN 'current'
          ELSE 'earlier'
        END AS version,
        (${WORKING_LINK} AND (node.kind = 'folder' OR link.version_id IS NOT NULL)) AS working
      FROM share_links link
      JOIN nodes node ON node.id = link.node_id
      JOIN users owner ON owner.id = node.owner_id
      JOIN chain ON chain.share_id = link.id AND chain.next IS NULL
      ${
        words
          ? sql`WHERE node.name ILIKE ${words} OR chain.path ILIKE ${words}
              OR owner.display_name ILIKE ${words} OR owner.username ILIKE ${words}`
          : sql``
      }
    )`
}

/**
 * `GET /admin/shares`: links, newest first: only those that work with
 * `active`, one user's with `ownerId`, those matching `q`.
 */
export async function listShares(
  app: FastifyInstance,
  options: {
    cursor: string | undefined
    limit: number
    active: boolean
    ownerId: string | undefined
    q: string | undefined
  },
): Promise<Page<AdminShare>> {
  const { cursor, limit, active, ownerId, q } = options
  const { rows } = await app.db.execute<ListedRow>(sql`
    ${listedShares(q)}
    SELECT * FROM listed
    WHERE true
      ${cursor ? sql`AND id < ${cursor}` : sql``}
      ${ownerId ? sql`AND owner_id = ${ownerId}` : sql``}
      ${active ? sql`AND working` : sql``}
    ORDER BY id DESC LIMIT ${limit + 1}`)
  const page = rows.slice(0, limit)
  return {
    items: page.map(toAdminShare),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  }
}

/**
 * `GET /admin/shares/owners`: the users with links, by name, with how many
 * match (`q`) and how many of those work; only those with one working with
 * `active`.
 */
export async function shareOwners(
  app: FastifyInstance,
  options: { active: boolean; q: string | undefined },
): Promise<AdminShareOwner[]> {
  const { rows } = await app.db.execute<{
    owner_id: string
    owner_name: string
    owner_username: string
    links: number
    working: number
  }>(sql`
    ${listedShares(options.q)}
    SELECT owner_id, owner_name, owner_username, count(*)::int AS links,
      (count(*) FILTER (WHERE working))::int AS working
    FROM listed
    GROUP BY owner_id, owner_name, owner_username
    ${options.active ? sql`HAVING count(*) FILTER (WHERE working) > 0` : sql``}
    ORDER BY lower(owner_name), owner_id`)
  return rows.map((row) => ({
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerUsername: row.owner_username,
    links: row.links,
    working: row.working,
  }))
}

/** `DELETE /admin/shares/:id`: turns any user's link off, which deletes it. */
export async function deleteShareAsAdmin(
  app: FastifyInstance,
  admin: Auth,
  id: string,
): Promise<void> {
  const { rows } = await app.db.execute<ShareRow>(sql`${SELECT_SHARES} WHERE share.id = ${id}`)
  const [share] = rows
  if (!share) throw new ApiError(404, 'not_found', 'No such link.')
  await app.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(shareLinks)
      .where(eq(shareLinks.id, id))
      .returning({ id: shareLinks.id })
    // Gone already: nothing changed, so nothing to note.
    if (deleted.length === 0) return
    const audited = await audit(tx, {
      actorId: admin.user.id,
      action: 'share.revoked',
      target: share.node_name,
      nodeId: share.node_id,
      details: `${share.owner_name}’s link`,
    })
    await appendJournal(tx, [...shareDeletedRecords([id]), ...audited])
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
  await auditAlone(app.db, {
    actorId: admin.user.id,
    action: 'upload.cancelled',
    target: found.file_name,
    details: `${found.user_name}’s upload`,
  })
}

function toAdminShare(row: ListedRow): AdminShare {
  const now = Date.now()
  const state =
    row.version === 'deleted'
      ? 'version_deleted'
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
    ownerUsername: row.owner_username,
    parentId: row.parent_id,
    path: row.path,
    createdAt: iso(row.created_at),
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    hasPassword: row.has_password,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    version: row.version,
    state,
  }
}

function iso(value: string): string {
  return new Date(value).toISOString()
}
