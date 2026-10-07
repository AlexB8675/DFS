import type { ChangePasswordInput, LoginInput, PasswordResetRequest } from '@dfs/shared'
import { appendJournal, userRecord, users } from '@dfs/db'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit, auditAlone } from '../audit.ts'
import { ApiError } from '../errors.ts'
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './passwords.ts'
import {
  endUserSessions,
  openSession,
  type Auth,
  type OpenedSession,
  type SessionClient,
  type UserRow,
} from './sessions.ts'

// Signing in and changing passwords (DESIGN.md §7.1).

/** After this many failures in a row, an account waits before the next try. */
const FREE_FAILURES = 10
const FIRST_LOCK_MS = 60_000
const MAX_LOCK_MS = 60 * 60_000
const MAX_LOCK_EXPONENT = Math.ceil(Math.log2(MAX_LOCK_MS / FIRST_LOCK_MS))
/** An account's request for a new password is recorded once in this long. */
const RESET_REQUEST_EVERY_MS = 15 * 60_000

export interface SignedIn {
  user: UserRow
  session: OpenedSession
}

export async function signIn(
  app: FastifyInstance,
  input: LoginInput,
  client: SessionClient,
): Promise<SignedIn> {
  const { ip } = client
  // Only failures count, so a household behind one address can sign in freely.
  const ipWait = app.limits.signIn.waitMs(ip)
  if (ipWait > 0) throw tooManyTries(ipWait)

  const [user] = await app.db.select().from(users).where(eq(users.username, input.username))
  const lockedFor = user?.signInLockedUntil ? user.signInLockedUntil.getTime() - Date.now() : 0
  if (lockedFor > 0) throw tooManyTries(lockedFor)

  // An unknown username costs the same hash, so timing doesn't reveal accounts.
  const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash()), input.password)
  if (!user || !valid) {
    app.limits.signIn.hit(ip)
    app.metrics.record('auth.failed_sign_ins')
    if (user) await recordFailure(app, user)
    await auditAlone(app.db, {
      actorId: null,
      action: 'auth.login_failed',
      target: `@${input.username}`,
      details: ip,
    })
    throw new ApiError(401, 'invalid_credentials', 'Wrong username or password.')
  }

  const signedIn = await app.db.transaction(async (tx) => {
    // Hashing takes time. Lock and recheck before opening the session, so a
    // password reset or account change cannot be bypassed by an older check.
    const [checked] = await tx.select().from(users).where(eq(users.id, user.id)).for('update')
    if (checked?.passwordHash !== user.passwordHash) {
      throw new ApiError(401, 'invalid_credentials', 'Wrong username or password.')
    }
    const wait = checked.signInLockedUntil ? checked.signInLockedUntil.getTime() - Date.now() : 0
    if (wait > 0) throw tooManyTries(wait)
    // Only someone with the right password learns these.
    if (checked.disabledAt) {
      throw new ApiError(
        403,
        'account_disabled',
        'This account is disabled. Ask an admin if you need it back.',
      )
    }
    if (checked.passwordExpiresAt && checked.passwordExpiresAt.getTime() <= Date.now()) {
      throw new ApiError(
        403,
        'password_expired',
        'This temporary password has expired. Ask an admin for a new one.',
      )
    }
    // Back in: a request for a new password is moot.
    const [current] = await tx
      .update(users)
      .set({
        failedSignIns: 0,
        signInLockedUntil: null,
        passwordResetRequestedAt: null,
        lastSeenAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning()
    if (!current) throw new ApiError(401, 'invalid_credentials', 'Wrong username or password.')
    const session = await openSession(tx, current, client)
    await appendJournal(
      tx,
      await audit(tx, {
        actorId: current.id,
        action: 'auth.login',
        target: current.displayName,
        details: ip,
      }),
    )
    return { user: current, session }
  })
  app.metrics.record('auth.sign_ins')
  return signedIn
}

/**
 * `POST /auth/password`. Needs the current password, except in a session
 * opened with a temporary one; choosing a password activates a new account.
 * Ends every session of the user and opens a fresh one.
 */
export async function changePassword(
  app: FastifyInstance,
  auth: Auth,
  input: ChangePasswordInput,
  client: SessionClient,
): Promise<SignedIn> {
  const { user } = auth
  if (!auth.limited) {
    const current = input.currentPassword ?? ''
    if (!(await verifyPassword(user.passwordHash, current))) {
      throw new ApiError(403, 'wrong_password', 'Your current password isn’t right.')
    }
  }
  const problem = await passwordProblem(input.newPassword, user.username, user.passwordHash)
  if (problem) throw new ApiError(400, 'password_rejected', problem)
  const passwordHash = await hashPassword(input.newPassword)

  return app.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({
        passwordHash,
        passwordExpiresAt: null,
        passwordResetRequestedAt: null,
        activatedAt: sql`coalesce(${users.activatedAt}, now())`,
      })
      // The account may have changed while the password checks and hash ran.
      .where(
        and(
          eq(users.id, user.id),
          eq(users.passwordHash, user.passwordHash),
          isNull(users.disabledAt),
        ),
      )
      .returning()
    if (!updated) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.')
    await endUserSessions(tx, user.id)
    const session = await openSession(tx, updated, client)
    const audited = await audit(tx, {
      actorId: user.id,
      action: 'auth.password_changed',
      target: updated.displayName,
    })
    await appendJournal(tx, [userRecord(updated), ...audited])
    return { user: updated, session }
  })
}

/**
 * `POST /auth/password-reset`: someone who forgot their password asks for a
 * new one by username (§7.1). Nothing but an admin can tell it's really
 * them, so the request goes to the admins, who set a temporary password as
 * for any reset; an email link will replace that. The answer is the same
 * whether or not the account exists, an account's request is recorded once
 * a quarter hour, and an address may ask a few times in that long.
 */
export async function requestPasswordReset(
  app: FastifyInstance,
  input: PasswordResetRequest,
  client: SessionClient,
): Promise<void> {
  const wait = app.limits.passwordResets.waitMs(client.ip)
  if (wait > 0) {
    throw new ApiError(
      429,
      'rate_limited',
      'Too many requests for a new password. Wait a little, then try again.',
      { 'retry-after': String(Math.ceil(wait / 1000)) },
    )
  }
  app.limits.passwordResets.hit(client.ip)
  await app.db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ passwordResetRequestedAt: new Date() })
      .where(
        and(
          eq(users.username, input.username),
          isNull(users.disabledAt),
          or(
            isNull(users.passwordResetRequestedAt),
            lt(users.passwordResetRequestedAt, new Date(Date.now() - RESET_REQUEST_EVERY_MS)),
          ),
        ),
      )
      .returning()
    if (!user) return
    await appendJournal(
      tx,
      await audit(tx, {
        actorId: null,
        action: 'auth.password_reset_requested',
        target: user.displayName,
        details: client.ip,
      }),
    )
  })
}

async function recordFailure(app: FastifyInstance, user: UserRow): Promise<void> {
  // Derive both fields from the row being updated: simultaneous checks can
  // have read the same old count before password verification finished.
  const failures = sql`${users.failedSignIns} + 1`
  await app.db
    .update(users)
    .set({
      failedSignIns: failures,
      signInLockedUntil: sql`CASE WHEN ${failures} >= ${FREE_FAILURES}
        THEN now() + least(${MAX_LOCK_MS}, ${FIRST_LOCK_MS} *
          power(2, least(${failures} - ${FREE_FAILURES}, ${MAX_LOCK_EXPONENT}))) * interval '1 millisecond'
        ELSE NULL END`,
    })
    .where(eq(users.id, user.id))
}

function tooManyTries(retryAfterMs: number): ApiError {
  const seconds = Math.ceil(retryAfterMs / 1000)
  return new ApiError(
    429,
    'rate_limited',
    'Too many sign-in attempts. Wait a little, then try again.',
    {
      'retry-after': String(seconds),
    },
  )
}
