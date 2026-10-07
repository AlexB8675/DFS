import { randomUUID } from 'node:crypto'
import { chunkContext, fromSha256Hex, generateDek, sha256, uuidBytes } from '@dfs/crypto'
import {
  abandonUploads,
  appendJournal,
  bigintArray,
  fileVersions,
  markFoldersDirty,
  nodeRecords,
  nodes,
  purgeVersions,
  unneededVersions,
  versionRecords,
  WORKING_LINK,
  QUEUES,
  textArray,
  uploadSessions,
  uuidArray,
  uuidv7,
  type BlobUploadJob,
  type Executor,
} from '@dfs/db'
import {
  formatBytes,
  nameKey,
  type CreateUploadInput,
  type ExistingFile,
  type UploadBatchResult,
  type UploadSession,
  type UploadSessionStatus,
} from '@dfs/shared'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { fromDrizzle, type PgBoss } from 'pg-boss'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { notFound, VISIBLE } from '../nodes/read.ts'
import { checkedName, lockDrive, nameConflict } from '../nodes/write.ts'
import { removeStagedVersions } from '../staging.ts'
import { stageFrame } from './stage-frame.ts'

// Multipart uploads (DESIGN.md §6.1). A session reserves quota and creates a
// file version; each part is encrypted into a frame and written to staging
// durably before it is acknowledged; completing makes the version current
// and hands its frames to the bot. An upload onto a file's name makes a new
// version of it (D20).

/**
 * A session lasts this long past its last sign of life: its creation, a part
 * stored, or its page saying it is open (§6.1). An upload under way never
 * expires, however long the file takes.
 */
const SESSION_LIFETIME_MS = 24 * 60 * 60_000
/** `expires_at` pushed to a lifetime from now. */
const extendedExpiry = sql`now() + ${SESSION_LIFETIME_MS} * interval '1 millisecond'`
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
  /** The file's own modification date, if its browser said. */
  modified_at: string | null
  received_hash: Buffer | null
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
      ? {
          ok: false,
          error: { code: outcome.code, message: outcome.message },
          ...(outcome instanceof FileExists && { existing: outcome.existing }),
        }
      : { ok: true, session: outcome },
  )
}

/** An upload that asked first (`ifExists: 'ask'`) found its name taken by a file. */
class FileExists extends ApiError {
  readonly existing: ExistingFile

  constructor(name: string, existing: ExistingFile) {
    super(409, 'file_exists', `“${name}” already exists here.`)
    this.existing = existing
  }
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
  await lockDrive(tx, ownerId, 'shared')
  const outcomes: (UploadSession | ApiError)[] = []
  const fail = (index: number, error: unknown) => {
    if (!(error instanceof ApiError)) throw error
    outcomes[index] = error
  }

  // Validate every destination together, without fetching its stats or version.
  const parentIds = [...new Set(inputs.map((input) => input.parentId))]
  const { rows: destinations } = await tx.execute<{ id: string; kind: 'file' | 'folder' }>(sql`
    SELECT n.id, n.kind FROM nodes n
    WHERE n.id = ANY(${uuidArray(parentIds)}) AND n.owner_id = ${ownerId} AND ${VISIBLE}`)
  const destinationKinds = new Map(destinations.map((folder) => [folder.id, folder.kind]))
  const folderProblems = new Map<string, ApiError | null>()
  for (const parentId of parentIds) {
    const kind = destinationKinds.get(parentId)
    let problem: ApiError | null = null
    if (kind === undefined) problem = notFound()
    else if (kind !== 'folder')
      problem = new ApiError(400, 'not_a_folder', 'The target is not a folder.')
    folderProblems.set(parentId, problem)
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
  // Uploads that asked first and found their name taken, by a file here or
  // earlier in this batch: they get that file back, not a version of it.
  const asked: { plan: Plan; fileId: string | null }[] = []
  const taken = new Set<string>()
  for (const plan of plans) {
    const found = existing.get(plan.key)
    if (found?.kind === 'folder') {
      fail(plan.index, nameConflict(plan.name))
    } else if (plan.input.ifExists === 'ask' && (found || taken.has(plan.key))) {
      asked.push({ plan, fileId: found?.id ?? null })
    } else if (plan.input.sizeBytes > free) {
      fail(
        plan.index,
        new ApiError(507, 'quota_exceeded', `Not enough storage left for “${plan.name}”.`),
      )
    } else {
      free -= plan.input.sizeBytes
      accepted.push(plan)
      taken.add(plan.key)
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
              // Its "Modified" from the start, while it uploads.
              ...(input.modifiedAt && { updatedAt: new Date(input.modifiedAt) }),
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
  // One that asked first doesn't become a version of a file named so meanwhile.
  for (const plan of raced) {
    const fileId = fileOf.get(plan.key)
    if (plan.input.ifExists === 'ask' && fileId) {
      asked.push({ plan, fileId })
      accepted.splice(accepted.indexOf(plan), 1)
    }
  }
  await answerAsked(tx, asked, fileOf, fail)
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
        modifiedAt: plan.input.modifiedAt ? new Date(plan.input.modifiedAt) : null,
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

  // New files count toward their folders' sizes. They join the journal when
  // their upload completes (§8).
  await markFoldersDirty(
    tx,
    created.flatMap((node) => node.parentId ?? []),
  )
  return outcomes
}

/**
 * Answers each upload that asked first with the file its name matched: how
 * many versions it has had, and how many working links serve its current one.
 */
async function answerAsked(
  tx: Executor,
  asked: { plan: Plan; fileId: string | null }[],
  fileOf: ReadonlyMap<string, string>,
  fail: (index: number, error: unknown) => void,
): Promise<void> {
  if (asked.length === 0) return
  const fileIdOf = ({ plan, fileId }: (typeof asked)[number]) => fileId ?? fileOf.get(plan.key)
  const ids = [...new Set(asked.flatMap((upload) => fileIdOf(upload) ?? []))]
  const { rows } = await tx.execute<{ id: string; versions: number; links: number }>(sql`
    SELECT node.id,
      coalesce((SELECT max(version_no) FROM file_versions WHERE node_id = node.id), 0) AS versions,
      (SELECT count(*) FROM share_links link
        WHERE link.version_id = node.current_version_id AND ${WORKING_LINK})::int AS links
    FROM nodes node WHERE node.id = ANY(${uuidArray(ids)})`)
  const files = new Map(rows.map((row) => [row.id, row]))
  for (const upload of asked) {
    const file = files.get(fileIdOf(upload) ?? '')
    fail(
      upload.plan.index,
      file
        ? new FileExists(upload.plan.name, {
            nodeId: file.id,
            versions: file.versions,
            links: file.links,
          })
        : nameConflict(upload.plan.name),
    )
  }
}

/** What these uploads' names already are in their folders: a file, or a folder in the way. */
async function namesInFolders(
  tx: Executor,
  plans: Plan[],
): Promise<Map<string, { id: string; kind: 'file' | 'folder' }>> {
  const found = new Map<string, { id: string; kind: 'file' | 'folder' }>()
  if (plans.length === 0) return found
  const distinct = [...new Map(plans.map((plan) => [plan.key, plan])).values()]
  const { rows } = await tx.execute<{
    id: string
    kind: 'file' | 'folder'
    parent_id: string
    name_key: string
  }>(sql`
    SELECT n.id, n.kind, n.parent_id, n.name_key
    FROM unnest(
      ${uuidArray(distinct.map((plan) => plan.input.parentId))},
      ${textArray(distinct.map((plan) => nameKey(plan.name)))}
    ) AS requested(parent_id, name_key)
    JOIN nodes n ON n.parent_id = requested.parent_id AND n.name_key = requested.name_key
    WHERE n.deleted_at IS NULL`)
  for (const row of rows)
    found.set(`${row.parent_id}/${row.name_key}`, { id: row.id, kind: row.kind })
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
 * `POST /uploads/alive`: the caller's page still holds these uploads (§6.1),
 * which keeps them from being given up or expiring. Sessions being completed
 * or purged right now are skipped, not waited for.
 */
export async function keepUploadsAlive(
  app: FastifyInstance,
  auth: Auth,
  ids: readonly string[],
): Promise<void> {
  await app.db.execute(sql`
    UPDATE upload_sessions SET alive_at = now(), expires_at = ${extendedExpiry}
    WHERE id IN (
      SELECT id FROM upload_sessions
      WHERE id = ANY(${uuidArray(ids)}) AND user_id = ${auth.user.id} AND state = 'receiving'
        AND expires_at > now()
      ORDER BY id FOR UPDATE SKIP LOCKED)`)
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
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new ApiError(400, 'invalid_part', 'Part index out of range.')
  }
  const upload = await findUpload(app.db, auth, uploadId, { partIndex: index })
  checkPart(upload, index, body)
  const plainHash = await sha256(body)
  if (sha256Header !== undefined) {
    const expected = fromSha256Hex(sha256Header)
    if (!expected || !Buffer.from(expected).equals(plainHash)) {
      throw new ApiError(400, 'hash_mismatch', 'The part was corrupted in transit.')
    }
  }
  await storePart(app, auth, upload, index, body, plainHash)
}

/**
 * Where a streamed upload may start (`PUT /uploads/:id/content?from=`), and
 * how many bytes must follow: every part from `from` to the end of the file.
 */
export async function streamStart(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
  from: number,
): Promise<{ chunkSize: number; chunkCount: number; bytes: number; completed: boolean }> {
  const upload = await findUpload(app.db, auth, uploadId)
  if (!Number.isInteger(from) || from < 0 || from >= upload.chunk_count) {
    throw new ApiError(400, 'invalid_part', 'The stream starts past the end of the file.')
  }
  return {
    chunkSize: upload.chunk_size,
    chunkCount: upload.chunk_count,
    bytes: upload.size_bytes - from * upload.chunk_size,
    completed: upload.state === 'completed',
  }
}

/**
 * A part cut from a streamed upload, stored as `PUT /uploads/:id/parts/:index`
 * stores one. The stream carries no hashes: completing the upload checks
 * them all (`completeUpload`).
 */
export async function receiveStreamedPart(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
  index: number,
  body: Uint8Array,
): Promise<void> {
  const upload = await findUpload(app.db, auth, uploadId, { partIndex: index })
  checkPart(upload, index, body)
  await storePart(app, auth, upload, index, body, await sha256(body))
}

/** Staging backpressure (§6.1): a `503` the client waits out. */
export function stagingFull(): ApiError {
  return new ApiError(503, 'staging_full', 'The server is busy storing files. Try again shortly.', {
    'retry-after': String(STAGING_RETRY_AFTER_SECONDS),
  })
}

/** A part has an index of the upload, and exactly the size of that part. */
function checkPart(upload: UploadRow, index: number, body: Uint8Array): void {
  if (index >= upload.chunk_count)
    throw new ApiError(400, 'invalid_part', 'Part index out of range.')
  const lastSize = upload.size_bytes - upload.chunk_size * (upload.chunk_count - 1)
  if (body.length !== (index === upload.chunk_count - 1 ? lastSize : upload.chunk_size)) {
    throw new ApiError(400, 'invalid_part', 'The part has the wrong size.')
  }
}

/**
 * Encrypts a checked part into a frame and stages it durably before its
 * chunk row commits. `upload` was read with this part's `received_hash`.
 */
async function storePart(
  app: FastifyInstance,
  auth: Auth,
  upload: UploadRow,
  index: number,
  body: Uint8Array,
  plainHash: Uint8Array,
): Promise<void> {
  const uploadId = upload.id
  // A retry of an acknowledged part needs no encryption, fsync or staging space.
  if (receivedPartMatches(upload.received_hash, plainHash)) {
    if (upload.chunk_count === 1 && upload.state !== 'completed') {
      await completeUpload(app, auth, uploadId)
    }
    return
  }
  if (upload.state === 'completed') throw uploadCompleted()
  if (await app.stagingLimit.isFull()) throw stagingFull()

  const versionId = upload.version_id
  const key = await app.dataKeys.get(versionId, () =>
    app.keys.unwrapDek(upload.wrapped_dek, upload.key_id, uuidBytes(versionId)),
  )
  // A single-part upload completes on its own, saving a request per small file.
  const queue = upload.chunk_count === 1 ? await app.queue.get() : null
  // Each attempt owns its file; a late or duplicate PUT cannot overwrite an
  // accepted frame. Only publishing the chunk takes the session's row lock,
  // so different parts can still encrypt and write in parallel.
  const stagedPath = `${app.staging.framePath(versionId, index)}.${randomUUID()}`
  // The frame stays if its chunk row may have committed: once the transaction
  // reached COMMIT, whose answer can be lost. A throw before that rolls back.
  const attempt = { published: false, committing: false }
  let pruned: string[] = []
  try {
    const { frame, hash: frameHash } = await stageFrame(
      app.staging,
      stagedPath,
      key,
      body,
      chunkContext(versionId, index),
    )
    await app.db.transaction(async (tx) => {
      const current = await findUpload(tx, auth, uploadId, { lock: true })
      if (current.state === 'receiving') {
        const inserted = await tx.execute<{ idx: number }>(sql`
          INSERT INTO chunks (version_id, idx, plain_size, frame_size, plain_sha256, frame_sha256, staged_path)
          VALUES (${versionId}, ${index}, ${body.length}, ${frame.length}, ${Buffer.from(plainHash)},
            ${Buffer.from(frameHash)}, ${stagedPath})
          ON CONFLICT (version_id, idx) DO NOTHING RETURNING idx`)
        attempt.published = inserted.rows.length > 0
        // A part arriving is as good as its page saying it is open.
        if (attempt.published) {
          await tx.execute(sql`
            UPDATE upload_sessions SET alive_at = now(), expires_at = ${extendedExpiry}
            WHERE id = ${uploadId}`)
        }
      }
      if (!attempt.published) {
        // Only racing retries need another lookup. Read after taking the lock:
        // a receipt or completion may have committed while this attempt waited.
        const { rows } = await tx.execute<{ plain_sha256: Buffer }>(sql`
          SELECT plain_sha256 FROM chunks WHERE version_id = ${versionId} AND idx = ${index}`)
        if (!receivedPartMatches(rows[0]?.plain_sha256 ?? null, plainHash)) throw uploadCompleted()
      }
      // In the same transaction as the part: one lock of the session and one
      // commit per small file.
      if (queue) pruned = await finishUpload(app, tx, queue, auth, current)
      attempt.committing = true
    })
  } finally {
    if (!(attempt.published && attempt.committing)) {
      await app.staging.remove(stagedPath).catch((error: unknown) => {
        app.log.warn({ err: error, stagedPath }, 'could not remove an unaccepted staged frame')
      })
    }
  }
  await removeStagedVersions(app, pruned)
}

/** Whether this part already arrived with these bytes; other bytes are a conflict. */
function receivedPartMatches(received: Buffer | null, hash: Uint8Array): boolean {
  if (!received) return false
  if (!received.equals(hash)) {
    throw new ApiError(409, 'part_conflict', 'This part was already received with other bytes.')
  }
  return true
}

function uploadCompleted(): ApiError {
  return new ApiError(409, 'upload_completed', 'This upload is already complete.')
}

/**
 * `POST /uploads/:id/complete`. The version becomes the file's current one
 * and its quota reservation turns into used bytes, in one transaction; its
 * frames go to the bot as blobs; earlier versions no share link serves are purged.
 * Completing a completed upload changes nothing.
 *
 * With `partSha256`, every part's SHA-256 as the client read it, the parts
 * are checked first: a streamed upload's only check of what arrived.
 */
export async function completeUpload(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
  partSha256?: readonly string[],
): Promise<void> {
  if (partSha256) await checkParts(app, auth, uploadId, partSha256)
  const queue = await app.queue.get()
  const pruned = await app.db.transaction(async (tx) => {
    const upload = await findUpload(tx, auth, uploadId, { lock: true })
    return finishUpload(app, tx, queue, auth, upload)
  })
  await removeStagedVersions(app, pruned)
}

/**
 * Compares the parts received with the client's hashes of them. Parts that
 * differ are dropped, and that commits before the `400 hash_mismatch`, so
 * the client sends them again; a completed upload can't drop any.
 */
async function checkParts(
  app: FastifyInstance,
  auth: Auth,
  uploadId: string,
  partSha256: readonly string[],
): Promise<void> {
  const dropped = await app.db.transaction(async (tx) => {
    const upload = await findUpload(tx, auth, uploadId, { lock: true })
    if (partSha256.length !== upload.chunk_count) {
      throw new ApiError(400, 'invalid_request', 'There must be a hash for every part.')
    }
    const { rows } = await tx.execute<{ idx: number; plain_sha256: Buffer }>(sql`
      SELECT idx, plain_sha256 FROM chunks WHERE version_id = ${upload.version_id}`)
    const corrupted = rows
      .filter((row) => {
        const expected = fromSha256Hex(partSha256[row.idx] ?? '')
        return !expected || !row.plain_sha256.equals(expected)
      })
      .map((row) => row.idx)
    if (corrupted.length === 0) return []
    if (upload.state === 'completed') {
      throw new ApiError(409, 'part_conflict', 'This upload was completed with other bytes.')
    }
    const { rows: staged } = await tx.execute<{ staged_path: string | null }>(sql`
      DELETE FROM chunks WHERE version_id = ${upload.version_id} AND idx = ANY(${bigintArray(corrupted)})
      RETURNING staged_path`)
    return staged.flatMap((row) => row.staged_path ?? [])
  })
  if (dropped.length === 0) return
  await Promise.all(
    dropped.map((path) =>
      app.staging.remove(path).catch((error: unknown) => {
        app.log.warn({ err: error, path }, 'could not remove a corrupted staged frame')
      }),
    ),
  )
  throw new ApiError(400, 'hash_mismatch', 'Some parts were corrupted in transit.')
}

/**
 * Completes an upload whose session the caller's transaction has locked.
 * Returns the pruned versions, whose staged frames go once it commits.
 */
async function finishUpload(
  app: FastifyInstance,
  tx: Executor,
  queue: PgBoss,
  auth: Auth,
  upload: UploadRow,
): Promise<string[]> {
  if (upload.state === 'completed') return []

  const { rows: parts } = await tx.execute<{ plain_sha256: Buffer }>(sql`
    SELECT plain_sha256 FROM chunks WHERE version_id = ${upload.version_id} ORDER BY idx`)
  if (parts.length !== upload.chunk_count) {
    throw new ApiError(409, 'incomplete_upload', 'Some parts have not been uploaded yet.')
  }
  const contentHash = await sha256(Buffer.concat(parts.map((part) => part.plain_sha256)))

  // A large frame is a blob of its own. Smaller ones, small files and the
  // ends of large files, wait for the bot to pack them (§6.6).
  const { rows: blobs } = await tx.execute<{ id: number }>(sql`
    WITH created AS (
      INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, sha256, staged_path)
      SELECT 'solo', 'staged', frame_size, frame_size, 1, frame_sha256, staged_path
      FROM chunks
      WHERE version_id = ${upload.version_id}
        AND plain_size >= ${app.config.sizes.packThresholdBytes}
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
      // "Modified" is the file's own date, so a version uploaded today of a
      // file last changed last year says last year.
      updatedAt: upload.modified_at ? new Date(upload.modified_at) : new Date(),
    })
    .where(eq(nodes.id, upload.node_id))
    .returning()
  if (!node) throw new ApiError(404, 'upload_not_found', 'This upload has expired.')
  await tx
    .update(uploadSessions)
    .set({ state: 'completed' })
    .where(eq(uploadSessions.id, upload.id))

  // Earlier versions go, freeing their quota (D20, D24), but for those an
  // active share link serves: the janitor takes those when their links end.
  const { rows: earlier } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM file_versions
    WHERE node_id = ${upload.node_id} AND id <> ${upload.version_id}
      AND state IN ('syncing', 'stored', 'failed', 'lost')`)
  const prunedIds = await unneededVersions(
    tx,
    earlier.map((row) => row.id),
  )
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
  const size = formatBytes(upload.size_bytes)
  const audited = await audit(tx, {
    actorId: auth.user.id,
    action: 'upload.completed',
    target: node.name,
    details: upload.version_no > 1 ? `${size}, new version` : size,
    nodeId: node.id,
  })
  // An empty file is stored now, with no blob for the bot to journal it after.
  const stored = upload.chunk_count === 0 ? await versionRecords(tx, [upload.version_id]) : []
  await appendJournal(tx, [...pruneRecords, ...nodeRecords([node]), ...stored, ...audited])
  return prunedIds
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
  { lock = false, partIndex }: { lock?: boolean; partIndex?: number } = {},
): Promise<UploadRow> {
  const { rows } = await db.execute<UploadRow>(sql`
    SELECT session.id, session.node_id, node.parent_id, session.version_id, version.version_no,
      session.state, session.reserved_bytes::float8 AS reserved_bytes,
      version.size_bytes::float8 AS size_bytes, version.chunk_size, version.chunk_count,
      version.wrapped_dek, version.key_id, version.modified_at,
      ${
        partIndex === undefined
          ? sql`NULL::bytea`
          : sql`(
        SELECT plain_sha256 FROM chunks WHERE version_id = session.version_id AND idx = ${partIndex}
      )`
      } AS received_hash
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
