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

/** Deletes up to `limit` released blobs, oldest first, and returns how many went. */
export async function collectGarbage(deps: CollectorDeps, limit: number): Promise<number> {
  const { db, store, staging, log } = deps
  const { rows } = await db.execute<{
    id: number
    channel_id: string | null
    message_id: string | null
    attachment_id: string | null
    staged_path: string | null
  }>(sql`
    SELECT id::float8 AS id, channel_id, message_id, attachment_id, staged_path FROM blobs
    WHERE state = 'deleting' ORDER BY id LIMIT ${limit}`)
  let deleted = 0
  for (const blob of rows) {
    try {
      await store.delete({
        id: blob.id,
        channelId: blob.channel_id,
        messageId: blob.message_id,
        attachmentId: blob.attachment_id,
      })
    } catch (error) {
      log?.warn({ err: error, blobId: blob.id }, 'deleting a blob failed; it will be tried again')
      continue
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
    deleted += 1
  }
  return deleted
}

/** Whether blobs are waiting to be stored: then deleting yields to them. */
export async function uploadsWaiting(db: Database): Promise<boolean> {
  const { rows } = await db.execute<{ waiting: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM blobs WHERE state IN ('staged', 'uploading')) AS waiting`)
  return rows[0]?.waiting ?? false
}
