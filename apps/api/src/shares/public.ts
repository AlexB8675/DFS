import type { DriveNode, PublicShare, SharedFolderPage, SharedNode } from '@dfs/shared'
import { sql, type SQL } from 'drizzle-orm'
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
  /** A file link's version (§7.5); `null` for a folder link. */
  version_id: string | null
  shared_by: string
}

/** The share behind a token, if it still works: not expired or used up. */
export function liveShare(
  app: FastifyInstance,
  token: string,
): Promise<{ share: LiveShare; root: NodeRow }> {
  return liveShareWhere(app, sql`share.token_hash = ${tokenHash(token)}`)
}

/** The share `id`, if it still works: for a stream link made through it (§6.7). */
export function liveShareById(
  app: FastifyInstance,
  id: string,
): Promise<{ share: LiveShare; root: NodeRow }> {
  return liveShareWhere(app, sql`share.id = ${id}`)
}

async function liveShareWhere(
  app: FastifyInstance,
  condition: SQL,
): Promise<{ share: LiveShare; root: NodeRow }> {
  const { rows } = await app.db.execute<LiveShare>(sql`
    SELECT share.id, share.node_id, share.password_hash, share.password_version,
      share.expires_at::text AS expires_at, share.max_downloads, share.download_count,
      share.version_id, owner.display_name AS shared_by
    FROM share_links share
    JOIN nodes node ON node.id = share.node_id
    JOIN users owner ON owner.id = node.owner_id
    WHERE ${condition}
      AND node.deleted_at IS NULL AND node.trashed_via IS NULL AND owner.disabled_at IS NULL`)
  const [share] = rows
  // A link turned off is deleted: it is gone, like one that never was.
  if (!share) throw new ApiError(404, 'share_not_found', 'This link doesn’t exist.')
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
  if (root.kind === 'file' && share.version_id === null) {
    throw new ApiError(
      410,
      'share_version_deleted',
      'The version of this file that was shared is gone.',
    )
  }
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
    root: { ...(await sharedRoot(app, share, root)), parentId: null },
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

/**
 * A link's item as its page shows it: a file link's, with the size and date
 * of the version it serves, which may be an earlier one than the drive's.
 */
async function sharedRoot(
  app: FastifyInstance,
  share: LiveShare,
  root: NodeRow,
): Promise<SharedNode> {
  const node = toSharedNode(toDriveNode(root))
  if (share.version_id === null) return node
  const { rows } = await app.db.execute<{
    size_bytes: number
    modified: string
    current: boolean
  }>(sql`
    SELECT version.size_bytes::float8 AS size_bytes,
      coalesce(version.modified_at, version.created_at)::text AS modified,
      node.current_version_id = version.id AS current
    FROM file_versions version JOIN nodes node ON node.id = version.node_id
    WHERE version.id = ${share.version_id}`)
  const [version] = rows
  if (!version || version.current) return node
  return {
    ...node,
    sizeBytes: version.size_bytes,
    updatedAt: new Date(version.modified).toISOString(),
  }
}

/** What a share page may see of a node: nothing about the owner's drive. */
function toSharedNode(node: DriveNode): SharedNode {
  const { id, parentId, kind, name, mimeType, sizeBytes, updatedAt } = node
  return { id, parentId, kind, name, mimeType, sizeBytes, updatedAt }
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'This item no longer exists.')
}
