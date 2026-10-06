import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
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
