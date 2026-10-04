import type { DriveNode, PublicShare, SharedFolderPage, SharedNode } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyPassword } from '../auth/passwords.ts'
import { ApiError } from '../errors.ts'
import {
  listChildren,
  NODE_COLUMNS,
  NODE_JOINS,
  nodePath,
  toDriveNode,
  VISIBLE,
  type NodeRow,
} from '../nodes/read.ts'
import { tokenHash } from './shares.ts'

// Public share access (DESIGN.md §7.5, D18): no session. A password-protected
// link reveals nothing, not even the item's name, until it is unlocked; the
// unlock cookie is scoped to that link, signed, and dies with a password change.

const UNLOCK_COOKIE = 'dfs_share'
const UNLOCK_LIFETIME_MS = 12 * 60 * 60_000

export interface LiveShare extends Record<string, unknown> {
  id: string
  node_id: string
  password_hash: string | null
  password_version: number
  expires_at: string | null
  max_downloads: number | null
  download_count: number
  revoked_at: string | null
  shared_by: string
}

/** The share behind a token, if it still works: not revoked, expired or used up. */
export async function liveShare(
  app: FastifyInstance,
  token: string,
): Promise<{ share: LiveShare; root: NodeRow }> {
  const { rows } = await app.db.execute<LiveShare>(sql`
    SELECT share.id, share.node_id, share.password_hash, share.password_version,
      share.expires_at::text AS expires_at, share.max_downloads, share.download_count,
      share.revoked_at::text AS revoked_at, owner.display_name AS shared_by
    FROM share_links share
    JOIN nodes node ON node.id = share.node_id
    JOIN users owner ON owner.id = node.owner_id
    WHERE share.token_hash = ${tokenHash(token)}
      AND node.deleted_at IS NULL AND node.trashed_via IS NULL AND owner.disabled_at IS NULL`)
  const [share] = rows
  if (!share) throw new ApiError(404, 'share_not_found', 'This link doesn’t exist.')
  if (share.revoked_at) throw new ApiError(410, 'share_revoked', 'The owner turned this link off.')
  if (share.expires_at && Date.parse(share.expires_at) <= Date.now()) {
    throw new ApiError(410, 'share_expired', 'This link has expired.')
  }
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    throw new ApiError(410, 'share_used_up', 'This link has reached its download limit.')
  }
  const { rows: roots } = await app.db.execute<NodeRow>(sql`
    SELECT ${NODE_COLUMNS} FROM nodes n ${NODE_JOINS} WHERE n.id = ${share.node_id}`)
  const [root] = roots
  if (!root) throw new ApiError(404, 'share_not_found', 'This link doesn’t exist.')
  return { share, root }
}

/** A live share whose password, if any, this browser has given. */
export async function openShare(
  app: FastifyInstance,
  request: FastifyRequest,
  token: string,
): Promise<{ share: LiveShare; root: NodeRow }> {
  const opened = await liveShare(app, token)
  if (!(await isUnlocked(app, request, opened.share))) {
    throw new ApiError(403, 'share_locked', 'Enter the password to open this link.')
  }
  return opened
}

/** `GET /s/:token`. */
export async function describeShare(
  app: FastifyInstance,
  request: FastifyRequest,
  token: string,
): Promise<PublicShare> {
  const { share, root } = await liveShare(app, token)
  if (!(await isUnlocked(app, request, share))) return { locked: true }
  return {
    locked: false,
    root: { ...toSharedNode(toDriveNode(root)), parentId: null },
    sharedBy: share.shared_by,
    expiresAt: share.expires_at ? new Date(share.expires_at).toISOString() : null,
    downloadsLeft:
      share.max_downloads === null ? null : Math.max(0, share.max_downloads - share.download_count),
  }
}

/** `POST /s/:token/unlock`: a right password sets a cookie for this link only. */
export async function unlockShare(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  password: string,
): Promise<void> {
  const key = `${request.ip}:${token}`
  const wait = app.limits.shareUnlock.waitMs(key)
  if (wait > 0) {
    throw new ApiError(
      429,
      'rate_limited',
      'Too many wrong passwords. Wait a little, then try again.',
      {
        'retry-after': String(Math.ceil(wait / 1000)),
      },
    )
  }
  const { share } = await liveShare(app, token)
  if (share.password_hash === null) return
  if (!(await verifyPassword(share.password_hash, password))) {
    app.limits.shareUnlock.hit(key)
    throw new ApiError(403, 'wrong_password', 'That password isn’t right.')
  }
  const expiresAt = Date.now() + UNLOCK_LIFETIME_MS
  const claim = unlockClaim(share, expiresAt)
  const mac = Buffer.from(await app.keys.sign(claim)).toString('base64url')
  reply.setCookie(UNLOCK_COOKIE, `${String(expiresAt)}.${mac}`, {
    path: `/api/s/${token}`,
    httpOnly: true,
    secure: app.config.nodeEnv === 'production',
    sameSite: 'strict',
    expires: new Date(expiresAt),
  })
}

/** `GET /s/:token/children`: a folder inside the share, with its path from the shared folder. */
export async function sharedChildren(
  app: FastifyInstance,
  root: NodeRow,
  parentId: string | undefined,
  cursor: string | undefined,
  limit: number,
): Promise<SharedFolderPage> {
  const folder = parentId ? await nodeInShare(app, root, parentId) : root
  if (folder.kind !== 'folder') throw notFound()
  const page = await listChildren(app.db, folder.id, { sort: 'name', order: 'asc', cursor, limit })
  const path = await nodePath(app.db, folder.id)
  const start = path.findIndex((node) => node.id === root.id)
  return {
    items: page.items.map(toSharedNode),
    nextCursor: page.nextCursor,
    path: path.slice(start),
  }
}

/** A visible node at or below the share's root, or a 404: a share never reaches outside it. */
export async function nodeInShare(
  app: FastifyInstance,
  root: NodeRow,
  id: string,
): Promise<NodeRow> {
  if (id === root.id) return root
  const { rows } = await app.db.execute<NodeRow>(sql`
    SELECT ${NODE_COLUMNS} FROM nodes n ${NODE_JOINS} WHERE n.id = ${id} AND ${VISIBLE}`)
  const [node] = rows
  if (!node) throw notFound()
  const path = await nodePath(app.db, id)
  if (!path.some((ancestor) => ancestor.id === root.id)) throw notFound()
  return node
}

/**
 * Counts a download, unless the link is used up by now: one atomic update,
 * so two downloads can't both take the last one.
 */
export async function countDownload(app: FastifyInstance, share: LiveShare): Promise<void> {
  const { rows } = await app.db.execute(sql`
    UPDATE share_links SET download_count = download_count + 1
    WHERE id = ${share.id} AND (max_downloads IS NULL OR download_count < max_downloads)
    RETURNING id`)
  if (rows.length === 0)
    throw new ApiError(410, 'share_used_up', 'This link has reached its download limit.')
}

async function isUnlocked(
  app: FastifyInstance,
  request: FastifyRequest,
  share: LiveShare,
): Promise<boolean> {
  if (share.password_hash === null) return true
  const [expires = '', mac = ''] = (request.cookies[UNLOCK_COOKIE] ?? '').split('.')
  const expiresAt = Number(expires)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false
  return app.keys.verify(unlockClaim(share, expiresAt), Buffer.from(mac, 'base64url'))
}

/** What the unlock cookie vouches for: this share, this password, until then. */
function unlockClaim(share: LiveShare, expiresAt: number): string {
  return `share-unlock:${share.id}:${String(share.password_version)}:${String(expiresAt)}`
}

/** What a share page may see of a node: nothing about the owner's drive. */
function toSharedNode(node: DriveNode): SharedNode {
  const { id, parentId, kind, name, mimeType, sizeBytes, updatedAt } = node
  return { id, parentId, kind, name, mimeType, sizeBytes, updatedAt }
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'This item no longer exists.')
}
