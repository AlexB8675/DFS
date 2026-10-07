import {
  appendJournal,
  notifySynced,
  uuidArray,
  versionRecords,
  type Database,
  type JournalRecord,
  type Metrics,
} from '@dfs/db'
import type { BlobStore, Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

// Storing staged blobs (DESIGN.md §6.1): read the blob from staging, put it
// in the blob store, then mark it stored, count its frames toward their
// versions, and tell the owners' browsers which files finished syncing.

export interface UploaderDeps {
  db: Database
  staging: Staging
  store: BlobStore
  log?: Pick<FastifyBaseLogger, 'warn'>
  metrics?: Metrics
}

interface StagedBlob extends Record<string, unknown> {
  id: number
  kind: 'solo' | 'pack'
  size_bytes: number
  live_bytes: number
  frame_count: number
  sha256: Buffer | null
  staged_path: string
}

/**
 * Stores these blobs with bounded concurrency, then notifies once per owner for
 * the whole batch. A blob that is no longer staged (stored by an earlier
 * attempt, or purged) is skipped, so retries and duplicates are harmless.
 * Returns the blobs that failed, with why, so only those are retried.
 */
export async function storeBlobs(
  deps: UploaderDeps,
  blobIds: readonly number[],
  concurrency = 2,
): Promise<Map<number, Error>> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Blob upload concurrency must be a positive integer.')
  }
  // Duplicate jobs must not race to read or replace the same staged blob.
  const ids = [...new Set(blobIds)]
  const results = new Array<Awaited<ReturnType<typeof storeBlob>> | Error>(ids.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      for (let index = next++; index < ids.length; index = next++) {
        const blobId = ids[index]
        if (blobId === undefined) continue
        try {
          results[index] = await storeBlob(deps, blobId)
        } catch (error) {
          results[index] =
            error instanceof Error ? error : new Error('Storing failed.', { cause: error })
        }
      }
    }),
  )
  const failures = new Map<number, Error>()
  const synced = new Map<string, { id: string; parentId: string }[]>()
  for (const [index, blobId] of ids.entries()) {
    const result = results[index]
    if (result === undefined) continue
    if (result instanceof Error) {
      failures.set(blobId, result)
      continue
    }
    for (const file of result) {
      const files = synced.get(file.userId)
      if (files) files.push(file)
      else synced.set(file.userId, [file])
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
    SELECT id::float8 AS id, kind, size_bytes, live_bytes, frame_count, sha256, staged_path
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

  // Read and checked only when the store has a turn for it (see BlobStore.put).
  const read = async () => {
    const data = await staging.read(blob.staged_path)
    if (data.length !== blob.size_bytes) {
      throw new Error(
        `Staged blob ${String(blobId)} is ${String(data.length)} bytes, not ${String(blob.size_bytes)}.`,
      )
    }
    if (blob.sha256) {
      // Hash on the thread pool, keeping the bot responsive for other jobs.
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', data))
      if (!hash.equals(blob.sha256)) throw new Error(`Staged blob ${String(blobId)} is corrupt.`)
    }
    return data
  }
  const { location, url } = await store.put(
    { id: blobId, kind: blob.kind, frameCount: blob.frame_count },
    read,
  )
  deps.metrics?.record('discord.posted', blob.size_bytes)

  /** Versions this blob finished: nothing of theirs is left in staging. */
  const storedVersions: string[] = []
  const finished = await db.transaction(async (tx) => {
    // Everything in it may have been purged while it was being posted: then
    // it goes straight to the GC, which deletes the message.
    const { rows: stored } = await tx.execute<{
      id: number
      discord_channel_id: string | null
    }>(sql`
      UPDATE blobs SET stored_at = now(), staged_path = NULL,
        state = CASE WHEN live_bytes <= 0 THEN 'deleting'::blob_state ELSE 'stored' END,
        channel_id = ${location.channelId}, message_id = ${location.messageId},
        attachment_id = ${location.attachmentId},
        cdn_url = ${url?.url ?? null}, cdn_url_expires_at = ${url?.expiresAt ?? null}
      WHERE id = ${blobId} AND state IN ('staged', 'uploading')
      RETURNING id, (SELECT discord_channel_id FROM storage_channels
        WHERE storage_channels.id = blobs.channel_id) AS discord_channel_id`)
    const [record] = stored
    if (!record) return []

    await tx.execute(sql`UPDATE chunks SET staged_path = NULL WHERE blob_id = ${blobId}`)
    // Versions in id order: once packs hold frames of several files (M1), two
    // blobs stored at once must not lock their versions in opposite orders.
    await tx.execute(sql`
      SELECT id FROM file_versions
      WHERE id IN (SELECT version_id FROM chunks WHERE blob_id = ${blobId})
      ORDER BY id FOR NO KEY UPDATE`)
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
          // Where it is for good, by Discord's IDs, which mean something
          // without this database (§8). The signed URL expires, so it stays out.
          discordChannelId: record.discord_channel_id,
          messageId: location.messageId,
          attachmentId: location.attachmentId,
        },
      },
    ]
    let files: { userId: string; id: string; parentId: string }[] = []
    storedVersions.push(...doneIds)
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

  // Storage and the version's completion have committed. A cleanup failure
  // must not hide that completion from the batch's notifications.
  await staging.remove(blob.staged_path).catch((error: unknown) => {
    deps.log?.warn(
      { err: error, blobId, stagedPath: blob.staged_path },
      'could not remove a staged file after storing its blob',
    )
  })
  // Their folders go too, with any file an interrupted upload attempt left.
  for (const versionId of storedVersions) {
    await staging.removeVersion(versionId).catch((error: unknown) => {
      deps.log?.warn({ err: error, versionId }, 'could not remove a stored version from staging')
    })
  }
  return finished
}
