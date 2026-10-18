import { openObject, sealObject, shareTokenContext, type MasterKeys } from '@dfs/crypto'
import {
  newShortCode,
  type CreateShareInput,
  type Page,
  type ShareCount,
  type ShareCountInput,
  type ShareLink,
  type UpdateShareInput,
} from '@dfs/shared'
import {
  appendJournal,
  shareDeletedRecords,
  shareLinks,
  shareRecords,
  uuidArray,
  uuidv7,
  WORKING_LINK,
  type Executor,
} from '@dfs/db'
import { eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import { hashPassword } from '../auth/passwords.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { visibleNode } from '../nodes/read.ts'
import { lookupTokenHashes, newLongToken, storedTokenHash } from './tokens.ts'

// Share links, as their owner manages them (DESIGN.md §7.5, D46): a 128-bit
// token, or on request a six-character code, found by its hash (tokens.ts) and
// kept sealed, so the owner can copy the link again; an optional argon2id
// password, expiry and download limit, all editable later.

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
  token_sealed: Buffer | null
}

/** `GET /shares`: the user's links, newest first, each to copy again. */
export async function listShares(app: FastifyInstance, auth: Auth): Promise<Page<ShareLink>> {
  const { rows } = await app.db.execute<ShareRow>(sql`
    ${SELECT_SHARE}
    WHERE node.owner_id = ${auth.user.id} AND node.tree <> 'vault'
    ORDER BY share.created_at DESC, share.id DESC`)
  return {
    items: await Promise.all(rows.map((row) => toShareLink(app, row))),
    nextCursor: null,
  }
}

/**
 * `POST /shares/count`: the caller's outstanding links to these items or
 * anything inside them, or to anything in the trash, so deleting them can
 * warn first.
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
            SELECT id FROM nodes /* tree: not vault, the outer query filters */
            WHERE id = ANY(${uuidArray(input.ids)}) AND owner_id = ${auth.user.id}
            UNION ALL
            SELECT child.id FROM nodes child /* tree: by parent */ JOIN below ON child.parent_id = below.id
          )
          SELECT id FROM below)`
      : sql`node.owner_id = ${auth.user.id}
          AND (node.deleted_at IS NOT NULL OR node.trashed_via IS NOT NULL)`
  const { rows } = await app.db.execute<{ links: number }>(sql`
    SELECT count(*)::int AS links
    FROM share_links link JOIN nodes node /* tree: not vault */ ON node.id = link.node_id
    WHERE ${scope} AND node.tree <> 'vault' AND ${WORKING_LINK}
      AND (node.kind = 'folder' OR link.version_id = node.current_version_id)`)
  return { links: rows[0]?.links ?? 0 }
}

/** How many codes `createShare` draws before it gives up on finding one not taken. */
const CODE_TRIES = 5

/** Whether a link already holds this code, stored under any master key in the key file. */
async function codeTaken(tx: Executor, keys: MasterKeys, code: string): Promise<boolean> {
  const hashes = await lookupTokenHashes(keys, code)
  const [held] = await tx
    .select({ id: shareLinks.id })
    .from(shareLinks)
    .where(inArray(shareLinks.tokenHash, hashes))
    .limit(1)
  return held !== undefined
}

/**
 * `POST /shares`: a new link, its token kept sealed to be shown again. A short
 * link's code is drawn by `newCode`, a test seam, again if it is taken (D46).
 */
export async function createShare(
  app: FastifyInstance,
  auth: Auth,
  input: CreateShareInput,
  newCode: () => string = newShortCode,
): Promise<ShareLink> {
  const node = await visibleNode(app.db, auth.user.id, input.nodeId)
  const id = uuidv7()
  const passwordHash = input.password === null ? null : await hashPassword(input.password)
  const short = input.short === true
  const share = await app.db.transaction(async (tx) => {
    // A file link is made for the file as it is now, its current version. Read
    // under the file's lock, so an upload replacing it completes before, or
    // after, and deletes this link then (D42).
    const { rows } = await tx.execute<{ current_version_id: string | null }>(sql`
      SELECT current_version_id FROM nodes /* tree: by id, gated */ WHERE id = ${node.id} FOR SHARE`)
    const versionId = rows[0]?.current_version_id ?? null
    if (node.kind === 'file' && versionId === null) {
      throw new ApiError(409, 'not_ready', 'This file hasn’t finished uploading.')
    }
    // A code is one of about 1.45 billion, so another link may hold it. A link
    // made under a master key since retired holds it under a hash the unique
    // index can't match to the current key's, so look for it under every key
    // first; the unique index is still the answer for two links made at once,
    // and leaves the insert empty. Either way another code is drawn. A long
    // token is 128 random bits, which never meets one.
    let created: typeof shareLinks.$inferSelect | undefined
    for (let tries = 0; !created && tries < (short ? CODE_TRIES : 1); tries++) {
      const token = short ? newCode() : newLongToken()
      if (short && (await codeTaken(tx, app.keys, token))) continue
      const tokenSealed = Buffer.from(
        await sealObject(app.keys, new TextEncoder().encode(token), shareTokenContext(id)),
      )
      const inserted = await tx
        .insert(shareLinks)
        .values({
          id,
          nodeId: node.id,
          versionId: node.kind === 'file' ? versionId : null,
          tokenHash: await storedTokenHash(app.keys, token),
          tokenSealed,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          passwordHash,
          maxDownloads: input.maxDownloads,
        })
        .onConflictDoNothing({ target: shareLinks.tokenHash })
        .returning()
      created = inserted[0]
    }
    if (!created) {
      throw new Error(
        short
          ? `Every one of ${String(CODE_TRIES)} short codes drawn was taken.`
          : 'Inserting a share returned nothing.',
      )
    }
    const audited = await audit(tx, {
      actorId: auth.user.id,
      action: 'share.created',
      target: node.name,
      nodeId: node.id,
    })
    await appendJournal(tx, [...shareRecords([created]), ...audited])
    return created
  })
  return toShareLink(app, await ownShare(app, auth, share.id))
}

/** `PATCH /shares/:id`: fields left out stay; a new password locks out who unlocked the old one. */
export async function updateShare(
  app: FastifyInstance,
  auth: Auth,
  id: string,
  changes: UpdateShareInput,
): Promise<ShareLink> {
  await ownShare(app, auth, id)
  const passwordHash =
    changes.password === undefined || changes.password === null
      ? null
      : await hashPassword(changes.password)
  await app.db.transaction(async (tx) => {
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
  return toShareLink(app, await ownShare(app, auth, id))
}

/** `DELETE /shares/:id`: turns the link off, which deletes it; it stops working at once. */
export async function deleteShare(app: FastifyInstance, auth: Auth, id: string): Promise<void> {
  const share = await ownShare(app, auth, id)
  await app.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(shareLinks)
      .where(eq(shareLinks.id, id))
      .returning({ id: shareLinks.id })
    if (deleted.length === 0) return
    const audited = await audit(tx, {
      actorId: auth.user.id,
      action: 'share.revoked',
      target: share.node_name,
      nodeId: share.node_id,
    })
    await appendJournal(tx, [...shareDeletedRecords([id]), ...audited])
  })
}

const SELECT_SHARE = sql`
  SELECT share.id, share.node_id, node.name AS node_name, node.kind AS node_kind,
    share.created_at::text AS created_at, share.expires_at::text AS expires_at,
    share.password_hash IS NOT NULL AS has_password, share.max_downloads, share.download_count,
    share.token_sealed
  FROM share_links share JOIN nodes node /* tree: not vault, each use filters */ ON node.id = share.node_id`

async function ownShare(app: FastifyInstance, auth: Auth, id: string): Promise<ShareRow> {
  const { rows } = await app.db.execute<ShareRow>(sql`
    ${SELECT_SHARE} WHERE share.id = ${id} AND node.owner_id = ${auth.user.id} AND node.tree <> 'vault'`)
  const [share] = rows
  if (!share) throw new ApiError(404, 'not_found', 'This link no longer exists.')
  return share
}

/** The link's address, from its kept token; `null` for one made before tokens were kept. */
async function linkUrl(app: FastifyInstance, row: ShareRow): Promise<string | null> {
  if (!row.token_sealed) return null
  const { plaintext } = await openObject(app.keys, row.token_sealed, shareTokenContext(row.id))
  return `${app.config.publicBaseUrl}/s/${new TextDecoder().decode(plaintext)}`
}

async function toShareLink(app: FastifyInstance, row: ShareRow): Promise<ShareLink> {
  const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString())
  return {
    id: row.id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    nodeKind: row.node_kind,
    url: await linkUrl(app, row),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: iso(row.expires_at),
    hasPassword: row.has_password,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
  }
}
