// Managing a vault once made (DESIGN.md §7.7): a new code, with the current
// one or the recovery key; a new recovery key; asking for a reset.
import {
  generateRecoveryKey,
  generateVaultSalt,
  unwrapVaultKeyByCode,
  unwrapVaultKeyByRecovery,
  wrapVaultKeyByCode,
  wrapVaultKeyByRecovery,
} from '@dfs/crypto'
import { appendJournal, userRecord, users } from '@dfs/db'
import type { ChangeVaultCodeInput, RecoveryKey, ResetVaultInput, VaultState } from '@dfs/shared'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit, auditAlone } from '../audit.ts'
import { verifyPassword } from '../auth/passwords.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { openInSession, reserveTry, stretching, vaultKeyOf, vaultState } from './vault.ts'

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

/**
 * `POST /vault/recovery-key`: a new recovery key, while the vault is open
 * here; the old one stops working. Shown this once.
 */
export async function replaceRecoveryKey(
  app: FastifyInstance,
  auth: Auth,
  token: string,
): Promise<RecoveryKey> {
  const userId = auth.user.id
  const vaultKey = await vaultKeyOf(app, auth, token)
  const recoveryKey = generateRecoveryKey()
  const wrapped = await wrapVaultKeyByRecovery(vaultKey, recoveryKey, userId)

  await app.db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ vaultKeyByRecovery: Buffer.from(wrapped) })
      .where(and(eq(users.id, userId), isNotNull(users.vaultRootId)))
      .returning()
    if (!user) throw new ApiError(404, 'no_vault', 'You have no vault yet.')

    await appendJournal(tx, [
      userRecord(user),
      ...(await audit(tx, {
        actorId: userId,
        action: 'vault.recovery_key_replaced',
        target: auth.user.displayName,
      })),
    ])
  })

  return { recoveryKey }
}

/**
 * `POST /vault/reset`: asks for the vault to be emptied after
 * `VAULT_RESET_DAYS`, with the account's password (§7.7). Asking again keeps
 * the first date; opening the vault cancels it.
 */
export async function requestVaultReset(
  app: FastifyInstance,
  auth: Auth,
  input: ResetVaultInput,
): Promise<VaultState> {
  if (!(await verifyPassword(auth.user.passwordHash, input.password))) {
    throw new ApiError(403, 'wrong_password', 'Your password isn’t right.')
  }

  const userId = auth.user.id
  await app.db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({
        vaultResetAt: sql`now() + make_interval(days => ${app.config.vaultResetDays}::int)`,
      })
      .where(and(eq(users.id, userId), isNotNull(users.vaultRootId), isNull(users.vaultResetAt)))
      .returning()
    if (user?.vaultResetAt) {
      await appendJournal(tx, [
        userRecord(user),
        ...(await audit(tx, {
          actorId: userId,
          action: 'vault.reset_requested',
          target: auth.user.displayName,
          details: user.vaultResetAt.toISOString(),
        })),
      ])
      return
    }

    // Nothing changed: either there is no vault, or a reset is already pending.
    const [existing] = await tx
      .select({ vaultRootId: users.vaultRootId })
      .from(users)
      .where(eq(users.id, userId))
    if (!existing?.vaultRootId) throw new ApiError(404, 'no_vault', 'You have no vault yet.')
  })

  return vaultState(app, auth)
}
