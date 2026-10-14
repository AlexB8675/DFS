// The vault (DESIGN.md §7.7): one per account, a root folder of its own in
// the tree `vault`, whose key is kept only wrapped, under the lock code and
// under the recovery key. Opening it seals the key into this browser's
// session, under a key from its cookie's token, which the database never
// holds.
import {
  generateRecoveryKey,
  generateVaultKey,
  generateVaultSalt,
  sealVaultKeyForSession,
  wrapVaultKeyByCode,
  wrapVaultKeyByRecovery,
} from '@dfs/crypto'
import { appendJournal, nodeRecords, nodes, sessions, userRecord, users } from '@dfs/db'
import type { CreateVaultInput, VaultCreated, VaultState } from '@dfs/shared'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'

/** Whether the account has a vault, and whether it is open in the caller's session, read fresh from the database. */
export async function vaultState(app: FastifyInstance, auth: Auth): Promise<VaultState> {
  const { rows } = await app.db.execute<{
    vault_root_id: string | null
    vault_reset_at: string | Date | null
    open: boolean
    vault_locks_at: string | Date | null
    total_bytes: string | number
    file_count: string | number
  }>(sql`
    SELECT users.vault_root_id, users.vault_reset_at,
           coalesce(sessions.vault_key_sealed IS NOT NULL AND sessions.vault_locks_at > now(), false) AS open,
           sessions.vault_locks_at,
           coalesce(folder_stats.total_bytes, 0) AS total_bytes,
           coalesce(folder_stats.file_count, 0) AS file_count
    FROM users
    LEFT JOIN sessions ON sessions.id = ${auth.sessionId} AND sessions.user_id = users.id
    LEFT JOIN folder_stats ON folder_stats.node_id = users.vault_root_id
    WHERE users.id = ${auth.user.id}`)
  const [row] = rows
  if (!row) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.')
  return {
    exists: row.vault_root_id !== null,
    open: row.open,
    locksAt: row.open && row.vault_locks_at ? new Date(row.vault_locks_at).toISOString() : null,
    resetAt: row.vault_reset_at ? new Date(row.vault_reset_at).toISOString() : null,
    sizeBytes: Number(row.total_bytes),
    fileCount: Number(row.file_count),
  }
}

/**
 * `POST /vault`: makes the account's vault, open in the session that made it.
 * The code is stretched and used here and nowhere else: it is not kept,
 * audited or returned.
 */
export async function createVault(
  app: FastifyInstance,
  auth: Auth,
  token: string,
  input: CreateVaultInput,
): Promise<VaultCreated> {
  // Outside any transaction: stretching the code takes a few hundred
  // milliseconds.
  const vaultKey = generateVaultKey()
  const salt = generateVaultSalt()
  const recoveryKey = generateRecoveryKey()
  const byCode = await wrapVaultKeyByCode(app.keys, vaultKey, input.code, salt, auth.user.id)
  const byRecovery = await wrapVaultKeyByRecovery(vaultKey, recoveryKey, auth.user.id)
  const sealed = await sealVaultKeyForSession(vaultKey, token, auth.sessionId)

  try {
    await app.db.transaction(async (tx) => {
      const [root] = await tx
        // tree: vault, the vault's own root
        .insert(nodes)
        .values({
          ownerId: auth.user.id,
          kind: 'folder',
          name: 'Vault',
          nameKey: 'vault',
          tree: 'vault',
        })
        .returning()
      if (!root) throw new Error('The vault was not made.')

      const [user] = await tx
        .update(users)
        .set({
          vaultRootId: root.id,
          vaultSalt: Buffer.from(salt),
          vaultKeyByCode: Buffer.from(byCode),
          vaultKeyByRecovery: Buffer.from(byRecovery),
          failedVaultUnlocks: 0,
          vaultUnlockLockedUntil: null,
          vaultResetAt: null,
        })
        .where(eq(users.id, auth.user.id))
        .returning()
      if (!user) throw new Error('The account is gone.')

      await tx
        .update(sessions)
        .set({
          vaultKeySealed: Buffer.from(sealed),
          vaultLocksAt: sql`now() + make_interval(mins => ${app.config.lockIdleMinutes}::int)`,
        })
        .where(eq(sessions.id, auth.sessionId))

      await appendJournal(tx, [
        userRecord(user),
        ...nodeRecords([root]),
        ...(await audit(tx, {
          actorId: auth.user.id,
          action: 'vault.created',
          target: auth.user.displayName,
        })),
      ])
    })
  } catch (error) {
    if (isUniqueViolation(error, 'nodes_one_root_per_owner')) {
      throw new ApiError(409, 'vault_exists', 'You already have a vault.')
    }
    throw error
  }

  return { recoveryKey, vault: await vaultState(app, auth) }
}
