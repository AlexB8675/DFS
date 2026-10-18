import {
  canonicalShareToken,
  type DriveNode,
  type PublicShare,
  type SharedFolderPage,
  type SharedNode,
} from '@dfs/shared'
import { sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyPassword } from '../auth/passwords.ts'
import { addressKey } from '../auth/rate-limit.ts'
import { ApiError } from '../errors.ts'
import {
  listChildren,
  NODE_COLUMNS,
  NODE_JOINS,
  nodePath,
  NOT_VAULT,
  toDriveNode,
  VISIBLE,
  type NodeRow,
} from '../nodes/read.ts'
import { lookupTokenHashes } from './tokens.ts'

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
  /** The file a file link was made for (§7.5): its version then; `null` for a folder link. */
  version_id: string | null
  /** The file was replaced since the link was made, which deletes it (D42): a link left over. */
  replaced: boolean
  shared_by: string
}

/**
 * The share behind a token, if it still works: not expired or used up. A code
 * typed in capitals or with lookalikes is read as the code it was made as; a
 * code may be stored under any master key in the key file (D46).
 *
 * A short code can be guessed, so an address that asks for 30 links that don't
 * exist in 10 minutes is refused every link, long ones too (§7.5, D46). Only a
 * miss counts: a link that works, or one expired or used up, was not a guess.
 *
 * The limit is checked twice. The first check spares the database a lookup for
 * an address already refused. But a miss is counted only after its lookup,
 * and guesses sent at once all pass the first check before any is counted, so
 * the limit is checked again as the lookup settles, in the same step that
 * counts the miss. JavaScript runs that step without interruption, so at most
 * 30 misses are answered per window however many were in flight. Over the limit
 * the answer is 429 whatever the lookup found, so a guesser learns nothing.
 */
export async function liveShare(
  app: FastifyInstance,
  request: FastifyRequest,
  token: string,
): Promise<{ share: LiveShare; root: NodeRow }> {
  const guesser = addressKey(request.ip)
  const early = app.limits.shareGuesses.waitMs(guesser)
  if (early > 0) throw tooManyGuesses(early)
  const hashes = await lookupTokenHashes(app.keys, canonicalShareToken(token))
  const stored = sql.join(
    hashes.map((hash) => sql`${hash}`),
    sql`, `,
  )
  let outcome: { found: { share: LiveShare; root: NodeRow } } | { error: unknown }
  try {
    outcome = { found: await liveShareWhere(app, sql`share.token_hash IN (${stored})`) }
  } catch (error) {
    outcome = { error }
  }
  // No await from this check to the count, so no other guess slips in between.
  const wait = app.limits.shareGuesses.waitMs(guesser)
  if (wait > 0) throw tooManyGuesses(wait)
  if ('error' in outcome) {
    if (outcome.error instanceof ApiError && outcome.error.code === 'share_not_found') {
      app.limits.shareGuesses.hit(guesser)
    }
    throw outcome.error
  }
  return outcome.found
}

function tooManyGuesses(waitMs: number): ApiError {
  return new ApiError(
    429,
    'rate_limited',
    'Too many links were tried from here. Wait a few minutes, then try again.',
    { 'retry-after': String(Math.ceil(waitMs / 1000)) },
  )
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
      share.version_id, owner.display_name AS shared_by,
      (node.kind = 'file' AND share.version_id IS DISTINCT FROM node.current_version_id) AS replaced
    FROM share_links share
    JOIN nodes node ON node.id = share.node_id /* tree: not vault */
    JOIN users owner ON owner.id = node.owner_id
    WHERE ${condition}
      AND node.deleted_at IS NULL AND node.trashed_via IS NULL AND node.tree <> 'vault'
      AND owner.disabled_at IS NULL`)
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
    SELECT ${NODE_COLUMNS} FROM nodes n /* tree: by id, gated */ ${NODE_JOINS} WHERE n.id = ${share.node_id}`)
  const [root] = roots
  if (!root) throw new ApiError(404, 'share_not_found', 'This link doesn’t exist.')
  // Replacing a file deletes its links (D42); one left over from before is as deleted.
  if (share.replaced) throw new ApiError(404, 'share_not_found', 'This link doesn’t exist.')
  return { share, root }
}

/** A live share whose password, if any, this browser has given. */
export async function openShare(
  app: FastifyInstance,
  request: FastifyRequest,
  token: string,
): Promise<{ share: LiveShare; root: NodeRow }> {
  const opened = await liveShare(app, request, token)
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
  const { share, root } = await liveShare(app, request, token)
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
  // The share page always asks with the code as made, and a cookie's path is
  // case-sensitive, so a code typed with lookalikes still sets one it can use
  // (D46). The same code, typed any way, shares a limiter key, and so does an
  // IPv6 /64 as one address, as in the guess limit.
  const canonical = canonicalShareToken(token)
  const key = `${addressKey(request.ip)}:${canonical}`
  const early = app.limits.shareUnlock.waitMs(key)
  if (early > 0) throw tooManyPasswords(early)
  const { share } = await liveShare(app, request, token)
  if (share.password_hash === null) return
  const right = await verifyPassword(share.password_hash, password)
  // A wrong password is counted only after it is tried, and attempts sent at
  // once all pass the first check, so check again in the step that counts it:
  // at most 10 wrong passwords are answered per window, and over the limit the
  // answer is 429 whatever the password was.
  const wait = app.limits.shareUnlock.waitMs(key)
  if (wait > 0) throw tooManyPasswords(wait)
  if (!right) {
    app.limits.shareUnlock.hit(key)
    throw new ApiError(403, 'wrong_password', 'That password isn’t right.')
  }
  const expiresAt = Date.now() + UNLOCK_LIFETIME_MS
  const claim = unlockClaim(share, expiresAt)
  const mac = Buffer.from(await app.keys.sign(claim)).toString('base64url')
  reply.setCookie(UNLOCK_COOKIE, `${String(expiresAt)}.${mac}`, {
    path: `/api/s/${canonical}`,
    httpOnly: true,
    secure: app.config.nodeEnv === 'production',
    sameSite: 'strict',
    expires: new Date(expiresAt),
  })
}

function tooManyPasswords(waitMs: number): ApiError {
  return new ApiError(
    429,
    'rate_limited',
    'Too many wrong passwords. Wait a little, then try again.',
    { 'retry-after': String(Math.ceil(waitMs / 1000)) },
  )
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
    SELECT ${NODE_COLUMNS} FROM nodes n /* tree: not vault */ ${NODE_JOINS}
    WHERE n.id = ${id} AND ${VISIBLE} AND ${NOT_VAULT}`)
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
