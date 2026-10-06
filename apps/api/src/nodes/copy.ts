import { nameKey, type CopyResult } from '@dfs/shared'
import {
  appendJournal,
  markFoldersDirty,
  nodeRecord,
  nodes,
  uuidArray,
  versionRecords,
  type Executor,
} from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { lookupNodes, nodePath, toDriveNode, visibleFolder, type NodeRow } from './read.ts'
import { freeName, guardName, lockDrive, visibleNodes } from './write.ts'

// Copying (D31): a file's copy is a new file whose one version shares the
// original's encrypted frames on Discord, sealed under the original's version
// ID (`sealed_version_id`). So a copy takes no upload and no Discord message:
// each frame counts once more toward its blob's live bytes, which keeps the
// blob until every version using it is purged, and the copy's bytes count
// toward the owner's quota like any file's.

/** Items one copy makes at most; a larger tree is copied a part at a time. */
const COPY_LIMIT = 10_000
/** Rows per insert, well under PostgreSQL's 65,535 parameters. */
const INSERT_BATCH = 1000

/** A node of the trees being copied, with its current version. */
interface TreeRow extends Record<string, unknown> {
  id: string
  parent_id: string
  kind: 'file' | 'folder'
  name: string
  mime_type: string | null
  depth: number
  version_id: string | null
  version_state: string | null
  version_size: number | null
}

/**
 * `POST /nodes/copy`: copies items into a folder, folders with everything
 * they hold. A copy whose name is taken there is named `name (1)`, … Only a
 * file's current version is copied. A file still on its way to Discord can't
 * be copied yet (409 `still_syncing`); lost and failed files, and files whose
 * first upload never finished, are left out and counted.
 */
export async function copyNodes(
  app: FastifyInstance,
  auth: Auth,
  ids: string[],
  parentId: string,
): Promise<CopyResult> {
  const ownerId = auth.user.id
  const { copies, skipped } = await app.db.transaction(async (tx) => {
    await lockDrive(tx, ownerId)
    const tops = await outermost(tx, await visibleNodes(tx, ownerId, ids), ids)
    await visibleFolder(tx, ownerId, parentId)
    const path = new Set((await nodePath(tx, parentId)).map((node) => node.id))
    if (tops.some((node) => path.has(node.id))) {
      throw new ApiError(400, 'invalid_copy', 'A folder cannot be copied into itself.')
    }

    const tree = await subtrees(
      tx,
      tops.map((node) => node.id),
    )
    if (tree.length > COPY_LIMIT) {
      throw new ApiError(
        400,
        'too_many_items',
        `Copy at most ${COPY_LIMIT.toLocaleString('en')} items at once.`,
      )
    }
    const syncing = tree.filter((row) => row.version_state === 'syncing').length
    if (syncing > 0) {
      throw new ApiError(
        409,
        'still_syncing',
        `${syncing === 1 ? 'A file is' : `${String(syncing)} files are`} still on the way to Discord. Copy again in a moment.`,
      )
    }
    const files = tree.filter((row) => row.kind === 'file' && row.version_state === 'stored')
    // Parents before children, so each insert finds the folders it fills.
    const copying = tree
      .filter((row) => row.kind === 'folder' || row.version_state === 'stored')
      .sort((a, b) => a.depth - b.depth)
    const skipped = tree.length - copying.length
    if (copying.length === 0) return { copies: [], skipped }

    const fresh = await newIds(tx, copying.length + files.length)
    const nodeIds = new Map(copying.map((row, index) => [row.id, fresh[index] ?? '']))
    const copied = files.map((row, index) => ({
      source: row.version_id ?? '',
      version: fresh[copying.length + index] ?? '',
      node: nodeIds.get(row.id) ?? '',
    }))

    // The copies of what was asked for take free names; what is inside keeps its own.
    const names = new Map<string, string>()
    const given = new Set<string>()
    for (const top of tops) {
      if (!nodeIds.has(top.id)) continue
      const name = await freeName(tx, parentId, top.name, given)
      names.set(top.id, name)
      given.add(nameKey(name))
    }
    const rows = copying.map((row) => {
      const name = names.get(row.id) ?? row.name
      return {
        id: nodeIds.get(row.id) ?? '',
        ownerId,
        parentId: row.depth === 0 ? parentId : (nodeIds.get(row.parent_id) ?? ''),
        kind: row.kind,
        name,
        nameKey: nameKey(name),
        mimeType: row.mime_type,
        sizeBytes: row.version_size ?? 0,
      }
    })
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      const batch = rows.slice(start, start + INSERT_BATCH)
      await guardName(batch[0]?.name ?? '', () => tx.insert(nodes).values(batch))
    }
    await copyVersions(tx, ownerId, copied)

    const bytes = files.reduce((total, row) => total + (row.version_size ?? 0), 0)
    const { rows: fits } = await tx.execute(sql`
      UPDATE users SET used_bytes = used_bytes + ${bytes}
      WHERE id = ${ownerId} AND used_bytes + reserved_bytes + ${bytes} <= quota_bytes
      RETURNING id`)
    if (fits.length === 0) {
      throw new ApiError(507, 'quota_exceeded', 'Not enough storage left for the copy.')
    }
    await markFoldersDirty(tx, [
      parentId,
      ...copying.flatMap((row) => (row.kind === 'folder' ? (nodeIds.get(row.id) ?? []) : [])),
    ])
    const copies = tops.flatMap((top) => {
      const id = nodeIds.get(top.id)
      return id ? [{ id, name: names.get(top.id) ?? top.name, from: top.name }] : []
    })
    await audit(
      tx,
      copies.map((copy) => ({
        actorId: ownerId,
        action: 'node.copied',
        target: copy.name,
        details: copy.name === copy.from ? null : `copy of ${copy.from}`,
        nodeId: copy.id,
      })),
    )
    const created = await tx
      .select()
      .from(nodes)
      .where(sql`${nodes.id} = ANY(${uuidArray([...nodeIds.values()])})`)
    await appendJournal(tx, [
      ...created.map(nodeRecord),
      ...(await versionRecords(
        tx,
        copied.map((copy) => copy.version),
      )),
    ])
    return { copies: copies.map((copy) => copy.id), skipped }
  })
  const found = new Map(
    (await lookupNodes(app.db, ownerId, copies)).map((row) => [row.id, toDriveNode(row)]),
  )
  return { items: copies.flatMap((id) => found.get(id) ?? []), skipped }
}

/** The items asked for, in that order, less those inside another one asked for. */
async function outermost(tx: Executor, picked: NodeRow[], order: string[]): Promise<NodeRow[]> {
  const ids = picked.map((node) => node.id)
  const { rows } = await tx.execute<{ origin: string }>(sql`
    WITH RECURSIVE up AS (
      SELECT id AS origin, parent_id FROM nodes WHERE id = ANY(${uuidArray(ids)})
      UNION ALL
      SELECT up.origin, node.parent_id FROM nodes node JOIN up ON node.id = up.parent_id
    )
    SELECT DISTINCT origin FROM up WHERE parent_id = ANY(${uuidArray(ids)})`)
  const inside = new Set(rows.map((row) => row.origin))
  const byId = new Map(picked.map((node) => [node.id, node]))
  return [...new Set(order)].flatMap((id) => {
    const node = byId.get(id)
    return node && !inside.has(id) ? [node] : []
  })
}

/** These nodes and everything visible below them, each with its depth below its top. */
async function subtrees(tx: Executor, topIds: string[]): Promise<TreeRow[]> {
  const { rows } = await tx.execute<TreeRow>(sql`
    WITH RECURSIVE tree AS (
      SELECT id, parent_id, kind, name, mime_type, current_version_id, 0 AS depth
      FROM nodes WHERE id = ANY(${uuidArray(topIds)})
      UNION ALL
      SELECT child.id, child.parent_id, child.kind, child.name, child.mime_type,
        child.current_version_id, tree.depth + 1
      FROM nodes child JOIN tree ON child.parent_id = tree.id
      WHERE child.deleted_at IS NULL AND child.trashed_via IS NULL
    )
    SELECT tree.id, tree.parent_id, tree.kind::text AS kind, tree.name, tree.mime_type,
      tree.depth, version.id AS version_id, version.state::text AS version_state,
      version.size_bytes::float8 AS version_size
    FROM tree LEFT JOIN file_versions version ON version.id = tree.current_version_id
    LIMIT ${COPY_LIMIT + 1}`)
  return rows
}

/** IDs for new rows: UUIDv7, time-ordered like every node's and version's. */
async function newIds(tx: Executor, count: number): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT uuidv7()::text AS id FROM generate_series(1, ${count})`)
  return rows.map((row) => row.id)
}

/**
 * Each copied version, stored at once: the original's data key, frame
 * locations and hashes, sealed under the version the original was. Their
 * frames count once more toward their blobs, which must still be on Discord.
 */
async function copyVersions(
  tx: Executor,
  ownerId: string,
  copied: { source: string; version: string; node: string }[],
): Promise<void> {
  if (copied.length === 0) return
  const sources = uuidArray(copied.map((copy) => copy.source))
  const versions = uuidArray(copied.map((copy) => copy.version))
  const nodeIds = uuidArray(copied.map((copy) => copy.node))

  // In id order, as purging takes them: a pack holds frames of several owners.
  const { rows: blobs } = await tx.execute(sql`
    SELECT id FROM blobs
    WHERE id IN (SELECT blob_id FROM chunks WHERE version_id = ANY(${sources}))
    ORDER BY id FOR NO KEY UPDATE`)
  const { rows: shared } = await tx.execute(sql`
    UPDATE blobs SET live_bytes = blobs.live_bytes + added.bytes
    FROM (
      SELECT chunk.blob_id, sum(chunk.frame_size) AS bytes
      FROM unnest(${sources}) AS copy(source_id)
      JOIN chunks chunk ON chunk.version_id = copy.source_id
      GROUP BY chunk.blob_id
    ) added
    WHERE blobs.id = added.blob_id AND blobs.state = 'stored'
    RETURNING blobs.id`)
  if (shared.length !== blobs.length) {
    throw new ApiError(409, 'copy_conflict', 'A file changed while it was copied. Try again.')
  }

  await tx.execute(sql`
    INSERT INTO file_versions (id, node_id, version_no, state, size_bytes, chunk_size,
      chunk_count, chunks_stored, content_hash, wrapped_dek, key_id, created_by,
      sealed_version_id)
    SELECT copy.version_id, copy.node_id, 1, 'stored', version.size_bytes, version.chunk_size,
      version.chunk_count, version.chunk_count, version.content_hash, version.wrapped_dek,
      version.key_id, ${ownerId}, coalesce(version.sealed_version_id, version.id)
    FROM unnest(${sources}, ${versions}, ${nodeIds}) AS copy(source_id, version_id, node_id)
    JOIN file_versions version ON version.id = copy.source_id`)
  await tx.execute(sql`
    INSERT INTO chunks (version_id, idx, plain_size, frame_size, plain_sha256, frame_sha256,
      blob_id, blob_offset)
    SELECT copy.version_id, chunk.idx, chunk.plain_size, chunk.frame_size, chunk.plain_sha256,
      chunk.frame_sha256, chunk.blob_id, chunk.blob_offset
    FROM unnest(${sources}, ${versions}) AS copy(source_id, version_id)
    JOIN chunks chunk ON chunk.version_id = copy.source_id`)
  await tx.execute(sql`
    UPDATE nodes SET current_version_id = copy.version_id
    FROM unnest(${nodeIds}, ${versions}) AS copy(node_id, version_id)
    WHERE nodes.id = copy.node_id`)
}
