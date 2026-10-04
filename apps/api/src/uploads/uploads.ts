import { chunkContext, fromSha256Hex, generateDek, sealFrame, sha256, uuidBytes } from '@dfs/crypto'
import {
  abandonUploads,
  appendJournal,
  fileVersions,
  markFoldersDirty,
  nodeRecord,
  nodes,
  purgeVersions,
  QUEUES,
  uploadSessions,
  uuidv7,
  type BlobUploadJob,
  type Executor,
} from '@dfs/db'
import {
  nameKey,
  type CreateUploadInput,
  type UploadBatchResult,
  type UploadSession,
  type UploadSessionStatus,
} from '@dfs/shared'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { fromDrizzle } from 'pg-boss'
import type { Auth } from '../auth/sessions.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'
import { visibleFolder } from '../nodes/read.ts'
import { checkedName, nameConflict } from '../nodes/write.ts'
import { removeStagedVersions } from '../staging.ts'

// Multipart uploads (DESIGN.md §6.1). A session reserves quota and creates a
// file version; each part is encrypted into a frame and written to staging
// durably before it is acknowledged; completing makes the version current
// and hands its frames to the bot. An upload onto a file's name makes a new
// version of it (D20).

const SESSION_LIFETIME_MS = 24 * 60 * 60_000
/** Staging backpressure: clients wait this long before sending again. */
const STAGING_RETRY_AFTER_SECONDS = 5

interface UploadRow extends Record<string, unknown> {
  id: string
  node_id: string
  parent_id: string | null
  version_id: string
  version_no: number
  state: 'receiving' | 'completed'
  reserved_bytes: number
  size_bytes: number
  chunk_size: number
  chunk_count: number
  wrapped_dek: Buffer
  key_id: string
}

/** `POST /uploads/batch`: answers per upload, so one bad name doesn't sink the rest. */
export async function createUploads(
  app: FastifyInstance,
  auth: Auth,
  inputs: CreateUploadInput[],
): Promise<UploadBatchResult['results']> {
  return app.db.transaction(async (tx) => {
    const results: UploadBatchResult['results'] = []
    for (const input of inputs) {
      try {
        // A savepoint per upload: a failed one leaves the others standing.
        const session = await tx.transaction((savepoint) =>
          startUpload(app, savepoint, auth, input),
        )
        results.push({ ok: true, session })
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        results.push({ ok: false, error: { code: error.code, message: error.message } })
      }
    }
    return results
  })
}

/** `POST /uploads`. */
export function createUpload(
  app: FastifyInstance,
  auth: Auth,
  input: CreateUploadInput,
): Promise<UploadSession> {
  return app.db.transaction((tx) => startUpload(app, tx, auth, input))
}

async function startUpload(
  app: FastifyInstance,
  tx: Executor,
  auth: Auth,
  input: CreateUploadInput,
): Promise<UploadSession> {
  const ownerId = auth.user.id
  const name = checkedName(input.name)
  await visibleFolder(tx, ownerId, input.parentId)

  let file = await fileNamed(tx, input.parentId, name)
  const isNewVersion = file !== null
  const { rows: reserved } = await tx.execute(sql`
    UPDATE users SET reserved_bytes = reserved_bytes + ${input.sizeBytes}
    WHERE id = ${ownerId} AND used_bytes + reserved_bytes + ${input.sizeBytes} <= quota_bytes
    RETURNING id`)
  if (reserved.length === 0) {
    throw new ApiError(507, 'quota_exceeded', `Not enough storage left for “${name}”.`)
  }

  if (!file) {
    try {
      // In a savepoint: if another upload just made this name, become a new version of it.
      const [created] = await tx.transaction((savepoint) =>
        savepoint
          .insert(nodes)
          .values({
            ownerId,
            parentId: input.parentId,
            kind: 'file',
            name,
            nameKey: nameKey(name),
            mimeType: input.mimeType || null,
            sizeBytes: input.sizeBytes,
          })
          .returning(),
      )
      if (!created) throw new Error('Inserting a file returned nothing.')
      await markFoldersDirty(tx, [input.parentId])
      await appendJournal(tx, [nodeRecord(created)])
      file = { id: created.id }
    } catch (error) {
      if (!isUniqueViolation(error, 'nodes_unique_name')) throw error
      file = await fileNamed(tx, input.parentId, name)
      if (!file) throw nameConflict(name)
    }
  }

  // Locking the file makes concurrent uploads onto it number their versions in turn.
  await tx.execute(sql`SELECT id FROM nodes WHERE id = ${file.id} FOR UPDATE`)
  const { rows: numbers } = await tx.execute<{ next: number }>(sql`
    SELECT coalesce(max(version_no), 0) + 1 AS next FROM file_versions WHERE node_id = ${file.id}`)
  const versionId = uuidv7()
  const chunkSize = app.config.sizes.chunkSize
  const chunkCount = Math.ceil(input.sizeBytes / chunkSize)
  await tx.insert(fileVersions).values({
    id: versionId,
    nodeId: file.id,
    versionNo: numbers[0]?.next ?? 1,
    sizeBytes: input.sizeBytes,
    chunkSize,
    chunkCount,
    wrappedDek: Buffer.from(await app.keys.wrapDek(generateDek(), uuidBytes(versionId))),
    keyId: app.keys.currentId,
    createdBy: ownerId,
  })
  const uploadId = uuidv7()
  await tx.insert(uploadSessions).values({
    id: uploadId,
    userId: ownerId,
    nodeId: file.id,
    versionId,
    reservedBytes: input.sizeBytes,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  })
  return { uploadId, nodeId: file.id, versionId, isNewVersion, chunkSize, chunkCount }
}

/** `GET /uploads/:id`: the parts already here, also after completion. */
export async function uploadStatus(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
): Promise<UploadSessionStatus> {
  const upload = await findUpload(app.db, auth, uploadId)
  const { rows } = await app.db.execute<{ idx: number }>(sql`
    SELECT idx FROM chunks WHERE version_id = ${upload.version_id} ORDER BY idx`)
  return {
    ...toSession(upload),
    state: upload.state,
    receivedParts: rows.map((row) => row.idx),
  }
}

/**
 * `PUT /uploads/:id/parts/:index`. The part is checked, encrypted into a frame
 * and written to staging durably before the 204, so an acknowledged part
 * survives a crash. Sending a part again is accepted, also after completion.
 */
export async function receivePart(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
  index: number,
  body: Uint8Array,
  sha256Header: string | undefined,
): Promise<void> {
  const upload = await findUpload(app.db, auth, uploadId)
  if (!Number.isInteger(index) || index < 0 || index >= upload.chunk_count) {
    throw new ApiError(400, 'invalid_part', 'Part index out of range.')
  }
  const lastSize = upload.size_bytes - upload.chunk_size * (upload.chunk_count - 1)
  if (body.length !== (index === upload.chunk_count - 1 ? lastSize : upload.chunk_size)) {
    throw new ApiError(400, 'invalid_part', 'The part has the wrong size.')
  }
  const plainHash = await sha256(body)
  if (sha256Header !== undefined) {
    const expected = fromSha256Hex(sha256Header)
    if (!expected || !Buffer.from(expected).equals(plainHash)) {
      throw new ApiError(400, 'hash_mismatch', 'The part was corrupted in transit.')
    }
  }

  if (upload.state === 'completed') {
    const { rows } = await app.db.execute<{ plain_sha256: Buffer }>(sql`
      SELECT plain_sha256 FROM chunks WHERE version_id = ${upload.version_id} AND idx = ${index}`)
    if (rows[0]?.plain_sha256.equals(plainHash)) return
    throw new ApiError(409, 'upload_completed', 'This upload is already complete.')
  }
  if (await app.stagingLimit.isFull()) {
    throw new ApiError(
      503,
      'staging_full',
      'The server is busy storing files. Try again shortly.',
      {
        'retry-after': String(STAGING_RETRY_AFTER_SECONDS),
      },
    )
  }

  const versionId = upload.version_id
  const key = await app.dataKeys.get(versionId, () =>
    app.keys.unwrapDek(upload.wrapped_dek, upload.key_id, uuidBytes(versionId)),
  )
  const frame = await sealFrame(key, body, chunkContext(versionId, index))
  const stagedPath = app.staging.framePath(versionId, index)
  await app.staging.write(stagedPath, frame)
  await app.db.execute(sql`
    INSERT INTO chunks (version_id, idx, plain_size, frame_size, plain_sha256, frame_sha256, staged_path)
    VALUES (${versionId}, ${index}, ${body.length}, ${frame.length}, ${Buffer.from(plainHash)},
      ${Buffer.from(await sha256(frame))}, ${stagedPath})
    ON CONFLICT (version_id, idx) DO UPDATE SET
      plain_size = excluded.plain_size, frame_size = excluded.frame_size,
      plain_sha256 = excluded.plain_sha256, frame_sha256 = excluded.frame_sha256,
      staged_path = excluded.staged_path
    WHERE chunks.blob_id IS NULL`)

  // A single-part upload completes on its own, saving a request per small file.
  if (upload.chunk_count === 1) await completeUpload(app, auth, uploadId)
}

/**
 * `POST /uploads/:id/complete`. The version becomes the file's current one
 * and its quota reservation turns into used bytes, in one transaction; its
 * frames go to the bot as blobs; versions past `VERSION_RETENTION` are purged.
 * Completing a completed upload changes nothing.
 */
export async function completeUpload(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
): Promise<void> {
  const queue = await app.queue.get()
  const pruned = await app.db.transaction(async (tx) => {
    const upload = await findUpload(tx, auth, uploadId, { lock: true })
    if (upload.state === 'completed') return []

    const { rows: parts } = await tx.execute<{ plain_sha256: Buffer }>(sql`
      SELECT plain_sha256 FROM chunks WHERE version_id = ${upload.version_id} ORDER BY idx`)
    if (parts.length !== upload.chunk_count) {
      throw new ApiError(409, 'incomplete_upload', 'Some parts have not been uploaded yet.')
    }
    const contentHash = await sha256(Buffer.concat(parts.map((part) => part.plain_sha256)))

    // Every frame becomes its own blob until packing arrives (M1).
    const { rows: blobs } = await tx.execute<{ id: number }>(sql`
      WITH created AS (
        INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, sha256, staged_path)
        SELECT 'solo', 'staged', frame_size, frame_size, 1, frame_sha256, staged_path
        FROM chunks WHERE version_id = ${upload.version_id}
        RETURNING id, staged_path
      )
      UPDATE chunks SET blob_id = created.id, blob_offset = 0
      FROM created
      WHERE chunks.version_id = ${upload.version_id} AND chunks.staged_path = created.staged_path
      RETURNING chunks.blob_id::float8 AS id`)

    await tx
      .update(fileVersions)
      .set({
        state: upload.chunk_count === 0 ? 'stored' : 'syncing',
        contentHash: Buffer.from(contentHash),
      })
      .where(eq(fileVersions.id, upload.version_id))
    const [node] = await tx
      .update(nodes)
      .set({
        currentVersionId: upload.version_id,
        sizeBytes: upload.size_bytes,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, upload.node_id))
      .returning()
    if (!node) throw new ApiError(404, 'upload_not_found', 'This upload has expired.')
    await tx.execute(sql`
      UPDATE users SET
        used_bytes = used_bytes + ${upload.size_bytes},
        reserved_bytes = greatest(0, reserved_bytes - ${upload.reserved_bytes})
      WHERE id = ${auth.user.id}`)
    await tx
      .update(uploadSessions)
      .set({ state: 'completed' })
      .where(eq(uploadSessions.id, uploadId))

    // Old versions beyond retention go (D20), which frees their quota (D24).
    const { rows: old } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM file_versions
      WHERE node_id = ${upload.node_id} AND id <> ${upload.version_id}
        AND state IN ('syncing', 'stored', 'failed')
      ORDER BY version_no DESC
      OFFSET ${app.config.versionRetention}`)
    const prunedIds = old.map((row) => row.id)
    await purgeVersions(tx, auth.user.id, prunedIds)

    if (upload.parent_id) await markFoldersDirty(tx, [upload.parent_id])
    if (blobs.length > 0) {
      const jobs = blobs.map((blob) => ({ data: { blobId: blob.id } satisfies BlobUploadJob }))
      await queue.insert(QUEUES.blobUpload, jobs, { db: fromDrizzle(tx, sql) })
    }
    await appendJournal(tx, [nodeRecord(node)])
    return prunedIds
  })
  await removeStagedVersions(app, pruned)
}

/** `DELETE /uploads/:id`. A completed upload stays: its file is in the drive now. */
export async function cancelUpload(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
): Promise<void> {
  const staged = await app.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM upload_sessions WHERE id = ${uploadId} AND user_id = ${auth.user.id}`)
    return rows[0] ? abandonUploads(tx, [uploadId]) : []
  })
  await removeStagedVersions(app, staged)
}

async function findUpload(
  db: Executor,
  auth: Auth,
  uploadId: string,
  { lock = false } = {},
): Promise<UploadRow> {
  const { rows } = await db.execute<UploadRow>(sql`
    SELECT session.id, session.node_id, node.parent_id, session.version_id, version.version_no,
      session.state, session.reserved_bytes::float8 AS reserved_bytes,
      version.size_bytes::float8 AS size_bytes, version.chunk_size, version.chunk_count,
      version.wrapped_dek, version.key_id
    FROM upload_sessions session
    JOIN file_versions version ON version.id = session.version_id
    JOIN nodes node ON node.id = session.node_id
    WHERE session.id = ${uploadId} AND session.user_id = ${auth.user.id}
      AND session.expires_at > now()
    ${lock ? sql`FOR UPDATE OF session` : sql``}`)
  const [upload] = rows
  if (!upload) throw new ApiError(404, 'upload_not_found', 'This upload has expired.')
  return upload
}

function toSession(upload: UploadRow): UploadSession {
  return {
    uploadId: upload.id,
    nodeId: upload.node_id,
    versionId: upload.version_id,
    isNewVersion: upload.version_no > 1,
    chunkSize: upload.chunk_size,
    chunkCount: upload.chunk_count,
  }
}

/** The file in a folder with this name, if any; a folder there is a conflict. */
async function fileNamed(
  tx: Executor,
  parentId: string,
  name: string,
): Promise<{ id: string } | null> {
  const [existing] = await tx
    .select({ id: nodes.id, kind: nodes.kind })
    .from(nodes)
    .where(
      sql`${nodes.parentId} = ${parentId} AND ${nodes.nameKey} = ${nameKey(name)} AND ${nodes.deletedAt} IS NULL`,
    )
  if (!existing) return null
  if (existing.kind === 'folder') throw nameConflict(name)
  return { id: existing.id }
}
