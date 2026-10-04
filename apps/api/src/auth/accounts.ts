import type { ChangePasswordInput, LoginInput } from '@dfs/shared'
import { appendJournal, userRecord, users } from '@dfs/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import { ApiError } from '../errors.ts'
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './passwords.ts'
import {
  endUserSessions,
  openSession,
  type Auth,
  type OpenedSession,
  type UserRow,
} from './sessions.ts'

// Signing in and changing passwords (DESIGN.md §7.1).

/** After this many failures in a row, an account waits before the next try. */
const FREE_FAILURES = 10
const FIRST_LOCK_MS = 60_000
const MAX_LOCK_MS = 60 * 60_000

export interface SignedIn {
  user: UserRow
  session: OpenedSession
}

export async function signIn(
  app: FastifyInstance,
  input: LoginInput,
  ip: string,
): Promise<SignedIn> {
  const perIp = app.limits.signIn.hit(ip)
  if (!perIp.allowed) throw tooManyTries(perIp.retryAfterMs)

  const [user] = await app.db.select().from(users).where(eq(users.username, input.username))
  const lockedFor = user?.signInLockedUntil ? user.signInLockedUntil.getTime() - Date.now() : 0
  if (lockedFor > 0) throw tooManyTries(lockedFor)

  // An unknown username costs the same hash, so timing doesn't reveal accounts.
  const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash()), input.password)
  if (!user || !valid) {
    if (user) await recordFailure(app, user)
    await audit(app.db, {
      actorId: null,
      action: 'auth.login_failed',
      target: `@${input.username}`,
      details: ip,
    })
    throw new ApiError(401, 'invalid_credentials', 'Wrong username or password.')
  }

  // Only someone with the right password learns these.
  if (user.disabledAt) {
    throw new ApiError(
      403,
      'account_disabled',
      'This account is disabled. Ask an admin if you need it back.',
    )
  }
  if (user.passwordExpiresAt && user.passwordExpiresAt.getTime() <= Date.now()) {
    throw new ApiError(
      403,
      'password_expired',
      'This temporary password has expired. Ask an admin for a new one.',
    )
  }

  return app.db.transaction(async (tx) => {
    const [current] = await tx
      .update(users)
      .set({ failedSignIns: 0, signInLockedUntil: null, lastSeenAt: new Date() })
      .where(eq(users.id, user.id))
      .returning()
    if (!current) throw new ApiError(401, 'invalid_credentials', 'Wrong username or password.')
    const session = await openSession(tx, current)
    await audit(tx, {
      actorId: current.id,
      action: 'auth.login',
      target: current.displayName,
      details: ip,
    })
    return { user: current, session }
  })
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
        activatedAt: sql`coalesce(${users.activatedAt}, now())`,
      })
      .where(eq(users.id, user.id))
      .returning()
    if (!updated) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.')
    await endUserSessions(tx, user.id)
    const session = await openSession(tx, updated)
    await audit(tx, {
      actorId: user.id,
      action: 'auth.password_changed',
      target: updated.displayName,
    })
    await appendJournal(tx, [userRecord(updated)])
    return { user: updated, session }
  })
}

async function recordFailure(app: FastifyInstance, user: UserRow): Promise<void> {
  const failures = user.failedSignIns + 1
  const lockMs =
    failures >= FREE_FAILURES
      ? Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (failures - FREE_FAILURES))
      : 0
  await app.db
    .update(users)
    .set({
      failedSignIns: failures,
      signInLockedUntil: lockMs > 0 ? new Date(Date.now() + lockMs) : null,
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
