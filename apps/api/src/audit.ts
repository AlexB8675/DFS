import { auditLog, type Executor } from '@dfs/db'

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

export async function audit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    userId: entry.actorId,
    action: entry.action,
    nodeId: entry.nodeId ?? null,
    meta: { target: entry.target, details: entry.details ?? null },
  })
}
