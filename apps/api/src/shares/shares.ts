import { createHash, randomBytes } from 'node:crypto'
import type { CreateShareInput, Page, ShareLink, UpdateShareInput } from '@dfs/shared'
import { shareLinks } from '@dfs/db'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import { hashPassword } from '../auth/passwords.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { visibleNode } from '../nodes/read.ts'

// Share links, as their owner manages them (DESIGN.md §7.5): a 128-bit
// token shown once, only its SHA-256 stored; an optional argon2id password,
// expiry and download limit, all editable later.

interface ShareRow extends Record<string, unknown> {
  id: string
  node_id: string
  node_name: string
  node_kind: 'folder' | 'file'
  created_at: string
  expires_at: string | null
  has_password: boolean
  max_downloads: number | null
  download_count: number
  revoked_at: string | null
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/** `GET /shares`: the user's links, newest first. */
export async function listShares(app: FastifyInstance, auth: Auth): Promise<Page<ShareLink>> {
  const { rows } = await app.db.execute<ShareRow>(sql`
    ${SELECT_SHARE}
    WHERE node.owner_id = ${auth.user.id}
    ORDER BY share.created_at DESC, share.id DESC`)
  return { items: rows.map((row) => toShareLink(row, null)), nextCursor: null }
}

/** `POST /shares`: the only time the link itself is shown. */
export async function createShare(
  app: FastifyInstance,
  auth: Auth,
  input: CreateShareInput,
): Promise<ShareLink> {
  const node = await visibleNode(app.db, auth.user.id, input.nodeId)
  const token = randomBytes(16).toString('base64url')
  const [share] = await app.db
    .insert(shareLinks)
    .values({
      nodeId: node.id,
      tokenHash: tokenHash(token),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      passwordHash: input.password === null ? null : await hashPassword(input.password),
      maxDownloads: input.maxDownloads,
    })
    .returning({ id: shareLinks.id })
  if (!share) throw new Error('Inserting a share returned nothing.')
  await audit(app.db, {
    actorId: auth.user.id,
    action: 'share.created',
    target: node.name,
    nodeId: node.id,
  })
  return toShareLink(await ownShare(app, auth, share.id), `${app.config.publicBaseUrl}/s/${token}`)
}

/** `PATCH /shares/:id`: fields left out stay; a new password locks out who unlocked the old one. */
export async function updateShare(
  app: FastifyInstance,
  auth: Auth,
  id: string,
  changes: UpdateShareInput,
): Promise<ShareLink> {
  const current = await ownShare(app, auth, id)
  if (current.revoked_at)
    throw new ApiError(409, 'share_revoked', 'A revoked link can’t be changed.')
  await app.db
    .update(shareLinks)
    .set({
      ...(changes.expiresAt !== undefined && {
        expiresAt: changes.expiresAt === null ? null : new Date(changes.expiresAt),
      }),
      ...(changes.maxDownloads !== undefined && { maxDownloads: changes.maxDownloads }),
      ...(changes.password !== undefined && {
        passwordHash: changes.password === null ? null : await hashPassword(changes.password),
        passwordVersion: sql`${shareLinks.passwordVersion} + 1`,
      }),
    })
    .where(eq(shareLinks.id, id))
  return toShareLink(await ownShare(app, auth, id), null)
}

/** `DELETE /shares/:id`: turns the link off for good. */
export async function revokeShare(app: FastifyInstance, auth: Auth, id: string): Promise<void> {
  const share = await ownShare(app, auth, id)
  await app.db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
  await audit(app.db, {
    actorId: auth.user.id,
    action: 'share.revoked',
    target: share.node_name,
    nodeId: share.node_id,
  })
}

const SELECT_SHARE = sql`
  SELECT share.id, share.node_id, node.name AS node_name, node.kind AS node_kind,
    share.created_at::text AS created_at, share.expires_at::text AS expires_at,
    share.password_hash IS NOT NULL AS has_password, share.max_downloads, share.download_count,
    share.revoked_at::text AS revoked_at
  FROM share_links share JOIN nodes node ON node.id = share.node_id`

async function ownShare(app: FastifyInstance, auth: Auth, id: string): Promise<ShareRow> {
  const { rows } = await app.db.execute<ShareRow>(sql`
    ${SELECT_SHARE} WHERE share.id = ${id} AND node.owner_id = ${auth.user.id}`)
  const [share] = rows
  if (!share) throw new ApiError(404, 'not_found', 'This link no longer exists.')
  return share
}

function toShareLink(row: ShareRow, url: string | null): ShareLink {
  const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString())
  return {
    id: row.id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    nodeKind: row.node_kind,
    url,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: iso(row.expires_at),
    hasPassword: row.has_password,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    revokedAt: iso(row.revoked_at),
  }
}
