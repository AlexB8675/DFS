import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { uuidArray } from './folder-stats.ts'
import { LOCK_NAMESPACE, LOCKS } from './locks.ts'
import { journal, type auditLog, type nodes, type shareLinks, type users } from './schema.ts'

/** A transaction, or the database outside one. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/** A change recovery needs (DESIGN.md §8), with the entity's full state after it. */
export interface JournalRecord {
  kind:
    | 'user.upsert'
    | 'node.upsert'
    | 'node.purge'
    | 'blob.stored'
    | 'blob.deleted'
    | 'version.stored'
    | 'version.purged'
    | 'blob.relocated'
    | 'share.upsert'
    | 'share.deleted'
    | 'audit.added'
  record: Record<string, unknown>
}

/**
 * Appends records to the journal. Call it last in the transaction: it takes
 * the journal's advisory lock, so records get IDs in commit order, and
 * everything journaled waits on that lock until the transaction ends.
 */
export async function appendJournal(tx: Executor, records: JournalRecord[]): Promise<void> {
  if (records.length === 0) return
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCKS.journal})`)
  await tx.insert(journal).values(records)
}

type UserRow = typeof users.$inferSelect
type NodeRow = typeof nodes.$inferSelect
type ShareRow = typeof shareLinks.$inferSelect
type AuditRow = typeof auditLog.$inferSelect

/**
 * A user's state for recovery. Usage, reservations, sign-in counters and a
 * request for a new password are derived or transient, so they are left out (§8).
 */
export function userRecord(user: UserRow): JournalRecord {
  const {
    usedBytes: _used,
    reservedBytes: _reserved,
    failedSignIns: _failed,
    signInLockedUntil: _locked,
    lastSeenAt: _seen,
    passwordResetRequestedAt: _resetRequested,
    ...state
  } = user
  return { kind: 'user.upsert', record: state }
}

/**
 * Nodes' states for recovery. `trashed_via` is derived from the trashed
 * ancestors, so it is left out. A file joins the journal with its first
 * completed version: until then it is an upload, which lives in its page and
 * can't be recovered (§8), so nothing that happens to it is journaled.
 */
export function nodeRecords(nodes: readonly NodeRow[]): JournalRecord[] {
  return nodes.flatMap(({ trashedVia: _trashedVia, ...state }): JournalRecord[] =>
    state.kind === 'file' && state.currentVersionId === null
      ? []
      : [{ kind: 'node.upsert', record: state }],
  )
}

/**
 * Share links' states for recovery, the token's hash in hex. The download
 * count is a usage counter, like a user's used bytes, so it is left out: a
 * rebuilt link counts afresh. A link goes with its item's `node.purge`.
 */
export function shareRecords(shares: readonly ShareRow[]): JournalRecord[] {
  return shares.map(({ downloadCount: _count, tokenHash, ...state }) => ({
    kind: 'share.upsert',
    record: { ...state, tokenHash: tokenHash.toString('hex') },
  }))
}

/**
 * `version.stored` records (§8): what recovery needs to read a version
 * without the database, its chunks with where each is. Written once a
 * version is stored: by the bot when its last blob reaches Discord, and
 * at completion for an empty file, which has no blob to wait for.
 */
export async function versionRecords(
  tx: Executor,
  versionIds: readonly string[],
): Promise<JournalRecord[]> {
  if (versionIds.length === 0) return []
  const { rows } = await tx.execute<{ record: Record<string, unknown> }>(sql`
    SELECT json_build_object(
      'id', version.id, 'nodeId', version.node_id, 'versionNo', version.version_no,
      'sizeBytes', version.size_bytes, 'chunkSize', version.chunk_size,
      'chunkCount', version.chunk_count, 'contentHash', encode(version.content_hash, 'hex'),
      'modifiedAt', version.modified_at,
      'createdBy', version.created_by, 'createdAt', version.created_at,
      'wrappedDek', encode(version.wrapped_dek, 'base64'), 'keyId', version.key_id,
      'chunks', coalesce((
        SELECT json_agg(json_build_object(
          'idx', chunk.idx, 'blobId', chunk.blob_id, 'offset', chunk.blob_offset,
          'plainSize', chunk.plain_size, 'frameSize', chunk.frame_size,
          'plainSha256', encode(chunk.plain_sha256, 'hex'),
          'frameSha256', encode(chunk.frame_sha256, 'hex')
        ) ORDER BY chunk.idx)
        FROM chunks chunk WHERE chunk.version_id = version.id
      ), '[]'::json)
    ) AS record
    FROM file_versions version WHERE version.id = ANY(${uuidArray(versionIds)})`)
  return rows.map((row) => ({ kind: 'version.stored', record: row.record }))
}

/** Share links turned off, which are deleted (§7.5): `{id}` each. */
export function shareDeletedRecords(ids: readonly string[]): JournalRecord[] {
  return ids.map((id) => ({ kind: 'share.deleted', record: { id } }))
}

/** Audit entries for recovery, as written (§7.5): the janitor drops them after a year. */
export function auditRecords(entries: readonly AuditRow[]): JournalRecord[] {
  return entries.map((entry) => ({ kind: 'audit.added', record: entry }))
}

/**
 * Deletes the records of batches on Discord for `days` or more, and of every
 * batch before them: #dfs-journal holds them now (§8). Stops below the first
 * batch not yet posted. Returns how many records went.
 */
export async function pruneJournal(db: Executor, days = 7): Promise<number> {
  const { rows } = await db.execute<{ count: number }>(sql`
    WITH posted AS (
      SELECT max(batch.last_id) AS through FROM journal_batches batch
      WHERE batch.state = 'stored' AND batch.stored_at < now() - make_interval(days => ${days}::int)
        AND NOT EXISTS (
          SELECT 1 FROM journal_batches earlier
          WHERE earlier.state = 'staged' AND earlier.batch_no < batch.batch_no)
    ), deleted AS (
      DELETE FROM journal
      WHERE id <= (SELECT through FROM posted) AND batch_no IS NOT NULL
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM deleted`)
  return rows[0]?.count ?? 0
}
