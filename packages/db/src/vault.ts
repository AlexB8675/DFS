import { eq, sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { appendJournal, auditRecords, userRecord } from './journal.ts'
import { TREE_LOCK_NAMESPACE } from './locks.ts'
import { purgeSubtrees } from './purge.ts'
import { auditLog, sessions, users } from './schema.ts'

// Emptying a vault once its reset is due (DESIGN.md §7.7): everything inside
// is purged as emptying the trash purges, which needs no key, and the
// vault's keys go with it, so its owner can make a new one.

/** Thrown inside the transaction to roll the purge back when the vault was opened meanwhile. */
class ResetCancelled extends Error {}

/**
 * Empties the vaults whose reset is due, `limit` at most, one per
 * transaction, each logged as done by the system. Returns how many went, and
 * the purged versions, whose staged frames the caller removes.
 */
export async function resetDueVaults(
  db: Database,
  limit = 20,
): Promise<{ vaults: number; versionIds: string[] }> {
  const { rows: due } = await db.execute<{ id: string }>(sql`
    SELECT id FROM users
    WHERE vault_reset_at <= now() AND vault_root_id IS NOT NULL
    ORDER BY vault_reset_at LIMIT ${limit}`)
  let vaults = 0
  const versionIds: string[] = []
  for (const { id: userId } of due) {
    let purged: string[] | null
    try {
      purged = await db.transaction(async (tx) => {
        // The drive's tree lock, as the API's trash and restore take it.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${TREE_LOCK_NAMESPACE}, hashtext(${userId}))`,
        )
        // Not locked yet: the user's row comes after the nodes, the order of locks.ts.
        const { rows: still } = await tx.execute<{ root: string; owner: string }>(sql`
          SELECT vault_root_id AS root, display_name AS owner FROM users
          WHERE id = ${userId} AND vault_reset_at <= now() AND vault_root_id IS NOT NULL`)
        const vault = still[0]
        if (!vault) return null
        const { versionIds: versions, records } = await purgeSubtrees(tx, userId, [vault.root])
        // Its owner may have opened the vault since, which cancels the reset:
        // then nothing is updated, and the purge above is rolled back.
        const [user] = await tx
          .update(users)
          .set({
            vaultSalt: null,
            vaultKeyByCode: null,
            vaultKeyByRecovery: null,
            failedVaultUnlocks: 0,
            vaultUnlockLockedUntil: null,
            vaultResetAt: null,
          })
          .where(sql`${users.id} = ${userId} AND ${users.vaultResetAt} <= now()`)
          .returning()
        if (!user) throw new ResetCancelled()
        // No session keeps the key of a vault that is gone.
        await tx
          .update(sessions)
          .set({ vaultKeySealed: null, vaultLocksAt: null })
          .where(eq(sessions.userId, userId))
        const entries = await tx
          .insert(auditLog)
          .values({
            userId: null,
            action: 'vault.reset',
            meta: { target: vault.owner, details: 'everything inside deleted, as asked' },
          })
          .returning()
        await appendJournal(tx, [...records, userRecord(user), ...auditRecords(entries)])
        return versions
      })
    } catch (error) {
      if (error instanceof ResetCancelled) continue
      throw error
    }
    // Counted once committed: staged frames of a purge rolled back must stay.
    if (!purged) continue
    vaults += 1
    versionIds.push(...purged)
  }
  return { vaults, versionIds }
}
