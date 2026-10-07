import { createHash, randomBytes } from 'node:crypto'
import type {
  CreateShareInput,
  Page,
  ShareCount,
  ShareCountInput,
  ShareLink,
  UpdateShareInput,
} from '@dfs/shared'
import { appendJournal, shareLinks, shareRecords, uuidArray, WORKING_LINK } from '@dfs/db'
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
  version_id: string | null
  version: ShareLink['version']
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

/**
 * `POST /shares/count`: the caller's outstanding links to these items or
 * anything inside them, or to anything in the trash, so deleting them can
 * warn first. A file link whose version is gone no longer counts.
 */
export async function countShareLinks(
  app: FastifyInstance,
  auth: Auth,
  input: ShareCountInput,
): Promise<ShareCount> {
  const scope =
    'ids' in input
      ? sql`link.node_id IN (
          WITH RECURSIVE below AS (
            SELECT id FROM nodes WHERE id = ANY(${uuidArray(input.ids)}) AND owner_id = ${auth.user.id}
            UNION ALL
            SELECT child.id FROM nodes child JOIN below ON child.parent_id = below.id
          )
          SELECT id FROM below)`
      : sql`node.owner_id = ${auth.user.id}
          AND (node.deleted_at IS NOT NULL OR node.trashed_via IS NOT NULL)`
  const { rows } = await app.db.execute<{ links: number }>(sql`
    SELECT count(*)::int AS links
    FROM share_links link JOIN nodes node ON node.id = link.node_id
    WHERE ${scope} AND ${WORKING_LINK}
      AND (node.kind = 'folder' OR link.version_id IS NOT NULL)`)
  return { links: rows[0]?.links ?? 0 }
}

/** `POST /shares`: the only time the link itself is shown. */
export async function createShare(
  app: FastifyInstance,
  auth: Auth,
  input: CreateShareInput,
): Promise<ShareLink> {
  const node = await visibleNode(app.db, auth.user.id, input.nodeId)
  const token = randomBytes(16).toString('base64url')
  const passwordHash = input.password === null ? null : await hashPassword(input.password)
  const share = await app.db.transaction(async (tx) => {
    // A file link keeps the version current now. Read under the file's lock,
    // so a completing upload's pruning sees this link, or comes first.
    const { rows } = await tx.execute<{ current_version_id: string | null }>(sql`
      SELECT current_version_id FROM nodes WHERE id = ${node.id} FOR SHARE`)
    const versionId = rows[0]?.current_version_id ?? null
    if (node.kind === 'file' && versionId === null) {
      throw new ApiError(409, 'not_ready', 'This file hasn’t finished uploading.')
    }
    const [created] = await tx
      .insert(shareLinks)
      .values({
        nodeId: node.id,
        versionId: node.kind === 'file' ? versionId : null,
        tokenHash: tokenHash(token),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        passwordHash,
        maxDownloads: input.maxDownloads,
      })
      .returning()
    if (!created) throw new Error('Inserting a share returned nothing.')
    const audited = await audit(tx, {
      actorId: auth.user.id,
      action: 'share.created',
      target: node.name,
      nodeId: node.id,
    })
    await appendJournal(tx, [...shareRecords([created]), ...audited])
    return created
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
  if (current.version === 'deleted') throw versionGone()
  const passwordHash =
    changes.password === undefined || changes.password === null
      ? null
      : await hashPassword(changes.password)
  await app.db.transaction(async (tx) => {
    // A link brought back to life (a later expiry, more downloads) must
    // still have its version: hold it, so the janitor can't take it now.
    if (current.version_id) {
      const { rows } = await tx.execute(sql`
        SELECT 1 FROM file_versions WHERE id = ${current.version_id} FOR KEY SHARE`)
      if (rows.length === 0) throw versionGone()
    }
    const updated = await tx
      .update(shareLinks)
      .set({
        ...(changes.expiresAt !== undefined && {
          expiresAt: changes.expiresAt === null ? null : new Date(changes.expiresAt),
        }),
        ...(changes.maxDownloads !== undefined && { maxDownloads: changes.maxDownloads }),
        ...(changes.password !== undefined && {
          passwordHash,
          passwordVersion: sql`${shareLinks.passwordVersion} + 1`,
        }),
      })
      .where(eq(shareLinks.id, id))
      .returning()
    await appendJournal(tx, shareRecords(updated))
  })
  return toShareLink(await ownShare(app, auth, id), null)
}

/** `DELETE /shares/:id`: turns the link off for good. */
export async function revokeShare(app: FastifyInstance, auth: Auth, id: string): Promise<void> {
  const share = await ownShare(app, auth, id)
  await app.db.transaction(async (tx) => {
    const revoked = await tx
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)))
      .returning()
    const audited = await audit(tx, {
      actorId: auth.user.id,
      action: 'share.revoked',
      target: share.node_name,
      nodeId: share.node_id,
    })
    await appendJournal(tx, [...shareRecords(revoked), ...audited])
  })
}

const SELECT_SHARE = sql`
  SELECT share.id, share.node_id, node.name AS node_name, node.kind AS node_kind,
    share.created_at::text AS created_at, share.expires_at::text AS expires_at,
    share.password_hash IS NOT NULL AS has_password, share.max_downloads, share.download_count,
    share.revoked_at::text AS revoked_at, share.version_id,
    CASE
      WHEN node.kind = 'folder' THEN NULL
      WHEN share.version_id IS NULL THEN 'deleted'
      WHEN share.version_id = node.current_version_id THEN 'current'
      ELSE 'earlier'
    END AS version
  FROM share_links share JOIN nodes node ON node.id = share.node_id`

/** A file link whose version was deleted: it serves nothing, and can't be brought back. */
function versionGone(): ApiError {
  return new ApiError(
    409,
    'share_version_deleted',
    'The version this link shared was deleted. Make a new link to share the file as it is now.',
  )
}

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
    version: row.version,
  }
}
