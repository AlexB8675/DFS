import {
  appendJournal,
  auditLog,
  auditRecords,
  type Database,
  type Executor,
  type JournalRecord,
} from '@dfs/db'

/** One line in the admin audit log (DESIGN.md §7.5). */
export interface AuditEntry {
  /** Who did it; `null` for the system or an unknown caller. */
  actorId: string | null
  action: string
  /** What it is about, as the log shows it: a user's name, a file name, `@username`. */
  target: string
  details?: string | null
  nodeId?: string | null
}

/**
 * Writes one entry, or several in one statement, in the caller's transaction.
 * Returns their journal records (§8), which the caller appends with the rest
 * of what it journals, last.
 */
export async function audit(
  tx: Executor,
  entries: AuditEntry | readonly AuditEntry[],
): Promise<JournalRecord[]> {
  const list = 'action' in entries ? [entries] : entries
  if (list.length === 0) return []
  const rows = await tx
    .insert(auditLog)
    .values(
      list.map((entry) => ({
        userId: entry.actorId,
        action: entry.action,
        nodeId: entry.nodeId ?? null,
        meta: { target: entry.target, details: entry.details ?? null },
      })),
    )
    .returning()
  return auditRecords(rows)
}

/** Writes entries, journaled, in a transaction of their own: for an action that changes nothing else journaled. */
export async function auditAlone(
  db: Database,
  entries: AuditEntry | readonly AuditEntry[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await appendJournal(tx, await audit(tx, entries))
  })
}
