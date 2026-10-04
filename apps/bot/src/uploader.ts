import { appendJournal, notifySynced, uuidArray, type Database, type JournalRecord } from '@dfs/db'
import type { BlobStore, Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'

// Storing staged blobs (DESIGN.md §6.1): read the blob from staging, put it
// in the blob store, then mark it stored, count its frames toward their
// versions, and tell the owners' browsers which files finished syncing.

export interface UploaderDeps {
  db: Database
  staging: Staging
  store: BlobStore
}

interface StagedBlob extends Record<string, unknown> {
  id: number
  kind: 'solo' | 'pack'
  size_bytes: number
  live_bytes: number
  sha256: Buffer | null
  staged_path: string
}

/**
 * Stores these blobs, one after the other, then notifies once per owner for
 * the whole batch. A blob that is no longer staged (stored by an earlier
 * attempt, or purged) is skipped, so retries and duplicates are harmless.
 * Returns the blobs that failed, with why, so only those are retried.
 */
export async function storeBlobs(
  deps: UploaderDeps,
  blobIds: readonly number[],
): Promise<Map<number, Error>> {
  const failures = new Map<number, Error>()
  const synced = new Map<string, { id: string; parentId: string }[]>()
  for (const blobId of blobIds) {
    try {
      for (const file of await storeBlob(deps, blobId)) {
        synced.set(file.userId, [...(synced.get(file.userId) ?? []), file])
      }
    } catch (error) {
      failures.set(
        blobId,
        error instanceof Error ? error : new Error('Storing failed.', { cause: error }),
      )
    }
  }
  if (synced.size > 0) {
    await deps.db.transaction(async (tx) => {
      for (const [userId, files] of synced) {
        await notifySynced(
          tx,
          userId,
          files.map(({ id, parentId }) => ({ id, parentId, syncState: 'stored' })),
        )
      }
    })
  }
  return failures
}

/** Every staged blob, as the queue would deliver them; for tests and catching up. */
export async function storeAllStagedBlobs(deps: UploaderDeps): Promise<void> {
  const { rows } = await deps.db.execute<{ id: number }>(sql`
    SELECT id::float8 AS id FROM blobs WHERE state = 'staged' ORDER BY id`)
  const failures = await storeBlobs(
    deps,
    rows.map((row) => row.id),
  )
  const [first] = failures.values()
  if (first !== undefined) throw first
}

/** Stores one blob; returns the files whose last frame it was. */
async function storeBlob(
  deps: UploaderDeps,
  blobId: number,
): Promise<{ userId: string; id: string; parentId: string }[]> {
  const { db, staging, store } = deps
  const { rows } = await db.execute<StagedBlob>(sql`
    SELECT id::float8 AS id, kind, size_bytes, live_bytes, sha256, staged_path
    FROM blobs WHERE id = ${blobId} AND state IN ('staged', 'uploading') AND staged_path IS NOT NULL`)
  const blob = rows[0]
  if (!blob) return []

  // Everything in it was purged while it waited: nothing to store.
  if (blob.live_bytes <= 0) {
    await db.execute(
      sql`UPDATE blobs SET state = 'deleted', staged_path = NULL WHERE id = ${blobId}`,
    )
    await staging.remove(blob.staged_path)
    return []
  }

  const data = await staging.read(blob.staged_path)
  if (data.length !== blob.size_bytes) {
    throw new Error(
      `Staged blob ${String(blobId)} is ${String(data.length)} bytes, not ${String(blob.size_bytes)}.`,
    )
  }
  const location = await store.put(blobId, data)

  const finished = await db.transaction(async (tx) => {
    const { rows: stored } = await tx.execute<{ id: number }>(sql`
      UPDATE blobs SET state = 'stored', stored_at = now(), staged_path = NULL,
        channel_id = ${location.channelId}, message_id = ${location.messageId},
        attachment_id = ${location.attachmentId}
      WHERE id = ${blobId} AND state IN ('staged', 'uploading')
      RETURNING id`)
    if (stored.length === 0) return []

    await tx.execute(sql`UPDATE chunks SET staged_path = NULL WHERE blob_id = ${blobId}`)
    // Each version this blob holds frames of gets closer to stored.
    const { rows: versions } = await tx.execute<{
      id: string
      node_id: string
      done: boolean
    }>(sql`
      UPDATE file_versions version SET chunks_stored = version.chunks_stored + counted.frames
      FROM (
        SELECT version_id, count(*)::int AS frames FROM chunks
        WHERE blob_id = ${blobId} GROUP BY version_id
      ) counted
      WHERE version.id = counted.version_id
      RETURNING version.id, version.node_id,
        version.chunks_stored = version.chunk_count AND version.state = 'syncing' AS done`)
    const doneIds = versions.filter((version) => version.done).map((version) => version.id)

    const records: JournalRecord[] = [
      {
        kind: 'blob.stored',
        record: {
          id: blobId,
          kind: blob.kind,
          sizeBytes: blob.size_bytes,
          sha256: blob.sha256?.toString('hex') ?? null,
          ...location,
        },
      },
    ]
    let files: { userId: string; id: string; parentId: string }[] = []
    if (doneIds.length > 0) {
      await tx.execute(sql`
        UPDATE file_versions SET state = 'stored' WHERE id = ANY(${uuidArray(doneIds)})`)
      records.push(...(await versionRecords(tx, doneIds)))
      // Only files whose current version this is show the change.
      const { rows: shown } = await tx.execute<{
        user_id: string
        id: string
        parent_id: string
      }>(sql`
        SELECT owner_id AS user_id, id, parent_id FROM nodes
        WHERE current_version_id = ANY(${uuidArray(doneIds)}) AND parent_id IS NOT NULL`)
      files = shown.map((row) => ({ userId: row.user_id, id: row.id, parentId: row.parent_id }))
    }
    await appendJournal(tx, records)
    return files
  })

  await staging.remove(blob.staged_path)
  return finished
}

/** `version.stored` records (§8): what recovery needs to read the version without the database. */
async function versionRecords(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  versionIds: string[],
): Promise<JournalRecord[]> {
  const { rows } = await tx.execute<{ record: Record<string, unknown> }>(sql`
    SELECT json_build_object(
      'id', version.id, 'nodeId', version.node_id, 'versionNo', version.version_no,
      'sizeBytes', version.size_bytes, 'chunkSize', version.chunk_size,
      'chunkCount', version.chunk_count, 'contentHash', encode(version.content_hash, 'hex'),
      'wrappedDek', encode(version.wrapped_dek, 'base64'), 'keyId', version.key_id,
      'chunks', (
        SELECT json_agg(json_build_object(
          'idx', chunk.idx, 'blobId', chunk.blob_id, 'offset', chunk.blob_offset,
          'plainSize', chunk.plain_size, 'frameSize', chunk.frame_size,
          'plainSha256', encode(chunk.plain_sha256, 'hex'),
          'frameSha256', encode(chunk.frame_sha256, 'hex')
        ) ORDER BY chunk.idx)
        FROM chunks chunk WHERE chunk.version_id = version.id
      )
    ) AS record
    FROM file_versions version WHERE version.id = ANY(${uuidArray(versionIds)})`)
  return rows.map((row) => ({ kind: 'version.stored', record: row.record }))
}
