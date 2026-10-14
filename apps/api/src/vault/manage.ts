// Managing a vault once made (DESIGN.md §7.7): a new code, with the current
// one or the recovery key.
import {
  generateVaultSalt,
  unwrapVaultKeyByCode,
  unwrapVaultKeyByRecovery,
  wrapVaultKeyByCode,
} from '@dfs/crypto'
import { appendJournal, userRecord, users } from '@dfs/db'
import type { ChangeVaultCodeInput, VaultState } from '@dfs/shared'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit, auditAlone } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { openInSession, reserveTry, stretching, vaultState } from './vault.ts'

/**
 * `PUT /vault/code`: a new code, given the current one or the recovery key.
 * The new code gets a fresh salt and its own wrap of the same vault key; the
 * recovery key's wrap stays, so that key keeps working. Opens the vault in
 * this session, which cancels a pending reset, and counts a wrong try as
 * unlocking does.
 */
export async function changeVaultCode(
  app: FastifyInstance,
  auth: Auth,
  token: string,
  input: ChangeVaultCodeInput,
): Promise<VaultState> {
  const userId = auth.user.id
  const vault = await reserveTry(app, userId)

  // The recovery key is checked without the gate: it isn't stretched.
  const withCode = 'currentCode' in input
  const vaultKey = withCode
    ? await stretching.run(() =>
        unwrapVaultKeyByCode(
          app.keys,
          vault.vaultKeyByCode,
          input.currentCode,
          vault.vaultSalt,
          userId,
        ),
      )
    : await unwrapVaultKeyByRecovery(vault.vaultKeyByRecovery, input.recoveryKey, userId)
  if (!vaultKey) {
    await auditAlone(app.db, {
      actorId: userId,
      action: 'vault.unlock_failed',
      target: auth.user.displayName,
    })
    throw withCode
      ? new ApiError(403, 'wrong_code', 'That code isn’t right.')
      : new ApiError(403, 'wrong_recovery_key', 'That recovery key isn’t right.')
  }

  // Outside any transaction: stretching the new code takes a few hundred
  // milliseconds.
  const salt = generateVaultSalt()
  const byCode = await stretching.run(() =>
    wrapVaultKeyByCode(app.keys, vaultKey, input.newCode, salt, userId),
  )

  await app.db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ vaultSalt: Buffer.from(salt), vaultKeyByCode: Buffer.from(byCode) })
      // A reset may have emptied the vault since the try was counted.
      .where(and(eq(users.id, userId), isNotNull(users.vaultRootId)))
      .returning()
    if (!user) throw new ApiError(404, 'no_vault', 'You have no vault yet.')

    await appendJournal(tx, [
      userRecord(user),
      ...(await audit(tx, {
        actorId: userId,
        action: 'vault.code_changed',
        target: auth.user.displayName,
      })),
    ])
  })

  await openInSession(app, auth, token, vaultKey, vault.vaultResetAt !== null)
  return vaultState(app, auth)
}
