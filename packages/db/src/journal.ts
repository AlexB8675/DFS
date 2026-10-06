import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { uuidArray } from './folder-stats.ts'
import { LOCK_NAMESPACE, LOCKS } from './locks.ts'
import { journal, type nodes, type users } from './schema.ts'

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

/**
 * A user's state for recovery. Usage, reservations and sign-in counters are
 * derived or transient, so they are left out (§8).
 */
export function userRecord(user: UserRow): JournalRecord {
  const {
    usedBytes: _used,
    reservedBytes: _reserved,
    failedSignIns: _failed,
    signInLockedUntil: _locked,
    lastSeenAt: _seen,
    ...state
  } = user
  return { kind: 'user.upsert', record: state }
}

/** A node's state for recovery. `trashed_via` is derived from the trashed ancestors, so it is left out. */
export function nodeRecord(node: NodeRow): JournalRecord {
  const { trashedVia: _trashedVia, ...state } = node
  return { kind: 'node.upsert', record: state }
}

/**
 * `version.stored` records: what recovery needs to read each version without
 * the database. A copy (D31) names the version its key and frames were
 * sealed under (`sealedVersionId`).
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
      'wrappedDek', encode(version.wrapped_dek, 'base64'), 'keyId', version.key_id,
      'sealedVersionId', version.sealed_version_id,
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
