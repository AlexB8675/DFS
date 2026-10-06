import { appendJournal, type Database } from '@dfs/db'
import type { BlobStore, Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

// Deleting blobs nothing uses any more (DESIGN.md §6.4): purges move a blob
// with no live frames left to `deleting`, and the leading bot deletes its
// message, one at a time and a few per round, so uploads keep most of
// Discord's rate limits.

export interface CollectorDeps {
  db: Database
  store: BlobStore
  staging: Staging
  log?: Pick<FastifyBaseLogger, 'warn'>
}

interface ReleasedBlob extends Record<string, unknown> {
  id: number
  channel_id: string | null
  message_id: string | null
  attachment_id: string | null
  staged_path: string | null
}

/** Deletes up to `limit` released blobs, oldest first and those that kept failing last; returns how many went. */
export async function collectGarbage(deps: CollectorDeps, limit: number): Promise<number> {
  const { rows } = await deps.db.execute<ReleasedBlob>(sql`
    SELECT id::float8 AS id, channel_id, message_id, attachment_id, staged_path FROM blobs
    WHERE state = 'deleting' ORDER BY attempts, id LIMIT ${limit}`)
  let deleted = 0
  for (const blob of rows) if ((await deleteBlob(deps, blob)) === null) deleted += 1
  return deleted
}

/**
 * Admin → Storage: tries the released blobs that failed to delete again now,
 * rather than after the others. Returns how many went, and why the rest still fail.
 */
export async function retryFailedDeletions(
  deps: CollectorDeps,
): Promise<{ deleted: number; failures: string[] }> {
  const { rows } = await deps.db.execute<ReleasedBlob>(sql`
    SELECT id::float8 AS id, channel_id, message_id, attachment_id, staged_path FROM blobs
    WHERE state = 'deleting' AND attempts > 0 ORDER BY id LIMIT 100`)
  let deleted = 0
  const failures: string[] = []
  for (const blob of rows) {
    const failure = await deleteBlob(deps, blob)
    if (failure === null) deleted += 1
    else failures.push(failure)
  }
  return { deleted, failures }
}

/** Deletes one released blob's message; returns `null`, or why it failed (counted on the blob). */
async function deleteBlob(deps: CollectorDeps, blob: ReleasedBlob): Promise<string | null> {
  const { db, store, staging, log } = deps
  try {
    await store.delete({
      id: blob.id,
      channelId: blob.channel_id,
      messageId: blob.message_id,
      attachmentId: blob.attachment_id,
    })
  } catch (error) {
    // Counted, so a blob that keeps failing goes after the others rather
    // than in front of them every round.
    const reason = error instanceof Error ? error.message : String(error)
    await db.execute(sql`
      UPDATE blobs SET attempts = attempts + 1, last_error = ${reason} WHERE id = ${blob.id}`)
    log?.warn({ err: error, blobId: blob.id }, 'deleting a blob failed; it will be tried again')
    return reason
  }
  await db.transaction(async (tx) => {
    const { rows: done } = await tx.execute(sql`
      UPDATE blobs SET state = 'deleted', staged_path = NULL, cdn_url = NULL,
        cdn_url_expires_at = NULL
      WHERE id = ${blob.id} AND state = 'deleting'
      RETURNING id`)
    if (done.length > 0)
      await appendJournal(tx, [{ kind: 'blob.deleted', record: { id: blob.id } }])
  })
  if (blob.staged_path) await staging.remove(blob.staged_path).catch(() => undefined)
  return null
}

/** Whether blobs are waiting to be stored: then deleting yields to them. */
export async function uploadsWaiting(db: Database): Promise<boolean> {
  const { rows } = await db.execute<{ waiting: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM blobs WHERE state IN ('staged', 'uploading')) AS waiting`)
  return rows[0]?.waiting ?? false
}
