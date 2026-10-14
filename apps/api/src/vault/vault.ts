// The vault (DESIGN.md §7.7): one per account, a root folder of its own in
// the tree `vault`, whose key is kept only wrapped, under the lock code and
// under the recovery key. Opening it seals the key into this browser's
// session, under a key from its cookie's token, which the database never
// holds.
import {
  generateRecoveryKey,
  generateVaultKey,
  generateVaultSalt,
  openVaultKeyFromSession,
  sealVaultKeyForSession,
  unwrapVaultKeyByCode,
  wrapVaultKeyByCode,
  wrapVaultKeyByRecovery,
} from '@dfs/crypto'
import { appendJournal, nodeRecords, nodes, sessions, userRecord, users } from '@dfs/db'
import type { CreateVaultInput, UnlockVaultInput, VaultCreated, VaultState } from '@dfs/shared'
import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit, auditAlone } from '../audit.ts'
import { failureWait } from '../auth/accounts.ts'
import type { Auth } from '../auth/sessions.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'
import { Gate } from './gate.ts'

// At most two codes are stretched at once in this process (§7.7): each takes
// 64 MiB and a thread of the pool that staging and password hashing share.
const stretching = new Gate(2)

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
  // The common case answered cheaply; the unique index still guards the race.
  if (auth.user.vaultRootId) throw new ApiError(409, 'vault_exists', 'You already have a vault.')

  // Outside any transaction: stretching the code takes a few hundred
  // milliseconds.
  const vaultKey = generateVaultKey()
  const salt = generateVaultSalt()
  const recoveryKey = generateRecoveryKey()
  const byCode = await stretching.run(() =>
    wrapVaultKeyByCode(app.keys, vaultKey, input.code, salt, auth.user.id),
  )
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

/** What a counted try hands on: the wrapped keys, all present because the account has a vault. */
interface ReservedTry {
  vaultSalt: Uint8Array
  vaultKeyByCode: Uint8Array
  vaultKeyByRecovery: Uint8Array
  vaultResetAt: Date | null
}

/**
 * Counts a try at the lock code and hands back what is needed to check it, or
 * refuses it while a wait is running. The count and the wait are one
 * conditional `UPDATE`, made before the code is stretched, so wrong codes
 * sent at once can't each pass a count that none of them has raised yet
 * (§7.7). `openInSession` resets the count at the right code.
 */
export async function reserveTry(app: FastifyInstance, userId: string): Promise<ReservedTry> {
  // In a `SET`, a column names its old value: the wait comes from the new count.
  const failures = sql`${users.failedVaultUnlocks} + 1`
  const [vault] = await app.db
    .update(users)
    .set({ failedVaultUnlocks: failures, vaultUnlockLockedUntil: failureWait(failures) })
    .where(
      and(
        eq(users.id, userId),
        isNotNull(users.vaultRootId),
        or(isNull(users.vaultUnlockLockedUntil), lte(users.vaultUnlockLockedUntil, sql`now()`)),
      ),
    )
    .returning({
      vaultSalt: users.vaultSalt,
      vaultKeyByCode: users.vaultKeyByCode,
      vaultKeyByRecovery: users.vaultKeyByRecovery,
      vaultResetAt: users.vaultResetAt,
    })

  if (!vault) {
    const [user] = await app.db
      .select({
        vaultRootId: users.vaultRootId,
        vaultUnlockLockedUntil: users.vaultUnlockLockedUntil,
      })
      .from(users)
      .where(eq(users.id, userId))
    if (!user?.vaultRootId) throw new ApiError(404, 'no_vault', 'You have no vault yet.')
    throw tooManyTries(user.vaultUnlockLockedUntil)
  }

  // The salt and both wraps are set whenever the vault is (users_vault_keys_together).
  const { vaultSalt, vaultKeyByCode, vaultKeyByRecovery } = vault
  if (!vaultSalt || !vaultKeyByCode || !vaultKeyByRecovery) {
    throw new Error('The vault has a root but not all of its keys.')
  }
  return { vaultSalt, vaultKeyByCode, vaultKeyByRecovery, vaultResetAt: vault.vaultResetAt }
}

function tooManyTries(lockedUntil: Date | null): ApiError {
  const seconds = lockedUntil ? Math.ceil((lockedUntil.getTime() - Date.now()) / 1000) : 1
  return new ApiError(429, 'rate_limited', 'Too many wrong codes. Wait a little, then try again.', {
    'retry-after': String(Math.max(1, seconds)),
  })
}

/**
 * `POST /vault/unlock`: opens the vault in this session if the code is right.
 * The code is stretched here and nowhere else, and is never audited or kept.
 */
export async function unlockVault(
  app: FastifyInstance,
  auth: Auth,
  token: string,
  input: UnlockVaultInput,
): Promise<VaultState> {
  const vault = await reserveTry(app, auth.user.id)
  const vaultKey = await stretching.run(() =>
    unwrapVaultKeyByCode(app.keys, vault.vaultKeyByCode, input.code, vault.vaultSalt, auth.user.id),
  )
  if (!vaultKey) {
    await auditAlone(app.db, {
      actorId: auth.user.id,
      action: 'vault.unlock_failed',
      target: auth.user.displayName,
    })
    throw new ApiError(403, 'wrong_code', 'That code isn’t right.')
  }
  await openInSession(app, auth, token, vaultKey, vault.vaultResetAt !== null)
  return vaultState(app, auth)
}

/**
 * Opens the vault in this session once its key is known: seals it into the
 * session, forgets the wrong codes and cancels a pending reset (§7.7). The
 * reset date is journaled; the counters aren't.
 */
export async function openInSession(
  app: FastifyInstance,
  auth: Auth,
  token: string,
  vaultKey: Uint8Array,
  cancelsReset: boolean,
): Promise<void> {
  const sealed = await sealVaultKeyForSession(vaultKey, token, auth.sessionId)
  await app.db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ failedVaultUnlocks: 0, vaultUnlockLockedUntil: null, vaultResetAt: null })
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

    const entries = [
      { actorId: auth.user.id, action: 'vault.unlocked', target: auth.user.displayName },
      ...(cancelsReset
        ? [
            {
              actorId: auth.user.id,
              action: 'vault.reset_cancelled',
              target: auth.user.displayName,
            },
          ]
        : []),
    ]
    await appendJournal(tx, [
      ...(cancelsReset ? [userRecord(user)] : []),
      ...(await audit(tx, entries)),
    ])
  })
}

/** `POST /vault/lock`: locks the vault in this session only; other browsers stay as they are. */
export async function lockVault(app: FastifyInstance, auth: Auth): Promise<void> {
  await app.db
    .update(sessions)
    .set({ vaultKeySealed: null, vaultLocksAt: null })
    .where(eq(sessions.id, auth.sessionId))
}

/**
 * How few seconds may remain before an open vault locks itself, before
 * using it slides that forward (§7.7): a minute's worth less than the whole
 * idle time, so the slide is written at most once a minute, but never more
 * than half of it, so a short idle time slides too.
 */
export function slideBelowSeconds(idleMinutes: number): number {
  return idleMinutes * 60 - Math.min(60, idleMinutes * 30)
}

/**
 * The open vault's key for this session, sliding when it locks forward
 * (§7.7), at most once a minute, as `touchSession` throttles its own
 * writes; `403 vault_locked` if the vault isn't open here.
 */
export async function vaultKeyOf(
  app: FastifyInstance,
  auth: Auth,
  token: string,
): Promise<Uint8Array> {
  const idle = app.config.lockIdleMinutes
  const [row] = await app.db
    .select({
      sealed: sessions.vaultKeySealed,
      expired: sql<boolean>`${sessions.vaultLocksAt} IS NULL OR ${sessions.vaultLocksAt} <= now()`,
      slideDue: sql<boolean>`${sessions.vaultLocksAt} < now() + make_interval(secs => ${slideBelowSeconds(idle)}::int)`,
    })
    .from(sessions)
    .where(eq(sessions.id, auth.sessionId))

  const vaultKey =
    row?.sealed && !row.expired
      ? await openVaultKeyFromSession(row.sealed, token, auth.sessionId)
      : null
  if (!vaultKey) {
    // Locked by the clock, or a copy that this cookie can't open: don't keep it.
    if (row?.sealed) {
      await app.db
        .update(sessions)
        .set({ vaultKeySealed: null, vaultLocksAt: null })
        .where(eq(sessions.id, auth.sessionId))
    }
    throw new ApiError(403, 'vault_locked', 'Open the vault first.')
  }

  if (row?.slideDue) {
    await app.db
      .update(sessions)
      .set({ vaultLocksAt: sql`now() + make_interval(mins => ${idle}::int)` })
      .where(and(eq(sessions.id, auth.sessionId), isNotNull(sessions.vaultKeySealed)))
  }
  return vaultKey
}
