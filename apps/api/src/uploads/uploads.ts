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
  textArray,
  uploadSessions,
  uuidArray,
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
  const outcomes = await app.db.transaction((tx) => startUploads(app, tx, auth, inputs))
  return outcomes.map((outcome) =>
    outcome instanceof ApiError
      ? { ok: false, error: { code: outcome.code, message: outcome.message } }
      : { ok: true, session: outcome },
  )
}

/** `POST /uploads`. */
export async function createUpload(
  app: FastifyInstance,
  auth: Auth,
  input: CreateUploadInput,
): Promise<UploadSession> {
  const [outcome] = await app.db.transaction((tx) => startUploads(app, tx, auth, [input]))
  if (!outcome || outcome instanceof ApiError) throw outcome ?? new Error('No upload started.')
  return outcome
}

/** One upload of a batch, once its name checked out. */
interface Plan {
  index: number
  input: CreateUploadInput
  name: string
  /** Its folder and name key: uploads with the same one go to the same file. */
  key: string
}

/**
 * Starts a batch of uploads with a fixed handful of queries, however many
 * files: each folder is checked once, names are looked up per folder, quota is
 * counted against one lock of the user's row, and new files, versions and
 * sessions are inserted together. A problem with one upload is its own answer.
 */
async function startUploads(
  app: FastifyInstance,
  tx: Executor,
  auth: Auth,
  inputs: CreateUploadInput[],
): Promise<(UploadSession | ApiError)[]> {
  const ownerId = auth.user.id
  const outcomes: (UploadSession | ApiError)[] = []
  const fail = (index: number, error: unknown) => {
    if (!(error instanceof ApiError)) throw error
    outcomes[index] = error
  }

  // Folders, once each.
  const folderProblems = new Map<string, ApiError | null>()
  for (const parentId of new Set(inputs.map((input) => input.parentId))) {
    try {
      await visibleFolder(tx, ownerId, parentId)
      folderProblems.set(parentId, null)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      folderProblems.set(parentId, error)
    }
  }
  const plans: Plan[] = []
  for (const [index, input] of inputs.entries()) {
    const problem = folderProblems.get(input.parentId)
    if (problem) {
      fail(index, problem)
      continue
    }
    try {
      const name = checkedName(input.name)
      plans.push({ index, input, name, key: `${input.parentId}/${nameKey(name)}` })
    } catch (error) {
      fail(index, error)
    }
  }

  // The user's row before the names (see locks.ts): quota is counted against it,
  // and while it's held no other upload can add or number this user's files.
  const { rows: quota } = await tx.execute<{ free: number }>(sql`
    SELECT (quota_bytes - used_bytes - reserved_bytes)::float8 AS free
    FROM users WHERE id = ${ownerId} FOR UPDATE`)
  let free = quota[0]?.free ?? 0
  const existing = await namesInFolders(tx, plans)
  const accepted: Plan[] = []
  for (const plan of plans) {
    if (existing.get(plan.key)?.kind === 'folder') {
      fail(plan.index, nameConflict(plan.name))
    } else if (plan.input.sizeBytes > free) {
      fail(
        plan.index,
        new ApiError(507, 'quota_exceeded', `Not enough storage left for “${plan.name}”.`),
      )
    } else {
      free -= plan.input.sizeBytes
      accepted.push(plan)
    }
  }

  // New files, in one insert. Names repeated in the batch share one file, a version each.
  const firstOfKey = new Map<string, Plan>()
  for (const plan of accepted) {
    if (!existing.has(plan.key) && !firstOfKey.has(plan.key)) firstOfKey.set(plan.key, plan)
  }
  const created =
    firstOfKey.size === 0
      ? []
      : await tx
          .insert(nodes)
          .values(
            [...firstOfKey.values()].map(({ input, name }) => ({
              ownerId,
              parentId: input.parentId,
              kind: 'file' as const,
              name,
              nameKey: nameKey(name),
              mimeType: input.mimeType || null,
              sizeBytes: input.sizeBytes,
            })),
          )
          .onConflictDoNothing({
            target: [nodes.parentId, nodes.nameKey],
            where: sql`deleted_at IS NULL`,
          })
          .returning()
  const fileOf = new Map<string, string>()
  for (const [key, found] of existing) if (found.kind === 'file') fileOf.set(key, found.id)
  for (const node of created) fileOf.set(`${node.parentId ?? ''}/${node.nameKey}`, node.id)
  // A name taken meanwhile (a folder made, a file renamed): become a version of that file, or clash with a folder.
  const raced = [...firstOfKey.values()].filter((plan) => !fileOf.has(plan.key))
  if (raced.length > 0) {
    for (const [key, found] of await namesInFolders(tx, raced)) {
      if (found.kind === 'file') fileOf.set(key, found.id)
    }
  }
  const newFileIds = new Set(created.map((node) => node.id))

  // Versions, numbered per file in turn: only starting an upload makes them.
  const fileIds = [...new Set(accepted.flatMap((plan) => fileOf.get(plan.key) ?? []))]
  const nextNumber = new Map<string, number>()
  if (fileIds.length > 0) {
    const { rows } = await tx.execute<{ node_id: string; last: number }>(sql`
      SELECT node_id, max(version_no) AS last FROM file_versions
      WHERE node_id = ANY(${uuidArray(fileIds)}) GROUP BY node_id`)
    for (const row of rows) nextNumber.set(row.node_id, row.last)
  }

  const chunkSize = app.config.sizes.chunkSize
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS)
  const starting = accepted.flatMap((plan) => {
    const nodeId = fileOf.get(plan.key)
    if (!nodeId) {
      fail(plan.index, nameConflict(plan.name))
      return []
    }
    const versionNo = (nextNumber.get(nodeId) ?? 0) + 1
    nextNumber.set(nodeId, versionNo)
    return [{ plan, nodeId, versionNo, versionId: uuidv7(), uploadId: uuidv7() }]
  })
  if (starting.length > 0) {
    const wrapped = await Promise.all(
      starting.map(({ versionId }) => app.keys.wrapDek(generateDek(), uuidBytes(versionId))),
    )
    await tx.insert(fileVersions).values(
      starting.map(({ plan, nodeId, versionNo, versionId }, i) => ({
        id: versionId,
        nodeId,
        versionNo,
        sizeBytes: plan.input.sizeBytes,
        chunkSize,
        chunkCount: Math.ceil(plan.input.sizeBytes / chunkSize),
        wrappedDek: Buffer.from(wrapped[i] ?? new Uint8Array()),
        keyId: app.keys.currentId,
        createdBy: ownerId,
      })),
    )
    await tx.insert(uploadSessions).values(
      starting.map(({ plan, nodeId, versionId, uploadId }) => ({
        id: uploadId,
        userId: ownerId,
        nodeId,
        versionId,
        reservedBytes: plan.input.sizeBytes,
        expiresAt,
      })),
    )
    const reserved = starting.reduce((total, { plan }) => total + plan.input.sizeBytes, 0)
    await tx.execute(sql`
      UPDATE users SET reserved_bytes = reserved_bytes + ${reserved} WHERE id = ${ownerId}`)
  }
  for (const { plan, nodeId, versionNo, versionId, uploadId } of starting) {
    outcomes[plan.index] = {
      uploadId,
      nodeId,
      versionId,
      isNewVersion: !(newFileIds.has(nodeId) && versionNo === 1),
      chunkSize,
      chunkCount: Math.ceil(plan.input.sizeBytes / chunkSize),
    }
  }

  // New files count toward their folders' sizes.
  await markFoldersDirty(
    tx,
    created.flatMap((node) => node.parentId ?? []),
  )
  await appendJournal(tx, created.map(nodeRecord))
  return outcomes
}

/** What these uploads' names already are in their folders: a file, or a folder in the way. */
async function namesInFolders(
  tx: Executor,
  plans: Plan[],
): Promise<Map<string, { id: string; kind: 'file' | 'folder' }>> {
  const found = new Map<string, { id: string; kind: 'file' | 'folder' }>()
  const keysByFolder = new Map<string, string[]>()
  for (const plan of plans) {
    const keys = keysByFolder.get(plan.input.parentId) ?? []
    keys.push(nameKey(plan.name))
    keysByFolder.set(plan.input.parentId, keys)
  }
  for (const [parentId, keys] of keysByFolder) {
    const { rows } = await tx.execute<{
      id: string
      kind: 'file' | 'folder'
      name_key: string
    }>(sql`
      SELECT id, kind, name_key FROM nodes
      WHERE parent_id = ${parentId} AND name_key = ANY(${textArray(keys)}) AND deleted_at IS NULL`)
    for (const row of rows) found.set(`${parentId}/${row.name_key}`, { id: row.id, kind: row.kind })
  }
  return found
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
    const pruneRecords = await purgeVersions(tx, auth.user.id, prunedIds)

    if (blobs.length > 0) {
      const jobs = blobs.map((blob) => ({ data: { blobId: blob.id } satisfies BlobUploadJob }))
      await queue.insert(QUEUES.blobUpload, jobs, { db: fromDrizzle(tx, sql) })
    }
    // The user's row as late as the order of locks.ts allows: completions for
    // one user queue on it until they commit, and this keeps that short.
    await tx.execute(sql`
      UPDATE users SET
        used_bytes = used_bytes + ${upload.size_bytes},
        reserved_bytes = greatest(0, reserved_bytes - ${upload.reserved_bytes})
      WHERE id = ${auth.user.id}`)
    if (upload.parent_id) await markFoldersDirty(tx, [upload.parent_id])
    await appendJournal(tx, [...pruneRecords, nodeRecord(node)])
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
