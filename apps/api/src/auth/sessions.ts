import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from '@dfs/config'
import { sessions, users, type Executor } from '@dfs/db'
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'

// Server-side sessions (DESIGN.md §7.1). The cookie holds a random token; the
// table holds only its SHA-256, so a copy of the table can't sign anyone in.

const DAY_MS = 24 * 60 * 60_000
const FULL_SESSION_MS = 30 * DAY_MS
/** A session opened with a temporary password: long enough to choose a new one. */
const LIMITED_SESSION_MS = 15 * 60_000
/** Sliding expiry, written at most daily rather than on every request. */
const EXTEND_AFTER_MS = DAY_MS
const LAST_SEEN_EVERY_MS = 5 * 60_000

export type UserRow = typeof users.$inferSelect

export interface Auth {
  sessionId: string
  csrfToken: string
  expiresAt: Date
  user: UserRow
  /** Signed in with a temporary password: may only choose a new one. */
  limited: boolean
}

export interface OpenedSession {
  token: string
  csrfToken: string
  expiresAt: Date
}

export async function openSession(db: Executor, user: UserRow): Promise<OpenedSession> {
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  const lifetime = user.passwordExpiresAt ? LIMITED_SESSION_MS : FULL_SESSION_MS
  const expiresAt = new Date(Date.now() + lifetime)
  await db.insert(sessions).values({ id: tokenId(token), userId: user.id, csrfToken, expiresAt })
  return { token, csrfToken, expiresAt }
}

/** The live session behind a cookie token, with its user; `null` if it ended. */
export async function findSession(db: Executor, token: string): Promise<Auth | null> {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, tokenId(token)),
        gt(sessions.expiresAt, sql`now()`),
        isNull(users.disabledAt),
      ),
    )
  if (!row) return null
  return {
    sessionId: row.session.id,
    csrfToken: row.session.csrfToken,
    expiresAt: row.session.expiresAt,
    user: row.user,
    limited: row.user.passwordExpiresAt !== null,
  }
}

/**
 * Slides a full session's expiry forward and notes when the user was last
 * seen, each at most once in a while. Returns the new expiry, if it moved.
 */
export async function touchSession(db: Executor, auth: Auth): Promise<Date | null> {
  const now = Date.now()
  const lastSeen = auth.user.lastSeenAt?.getTime() ?? 0
  if (now - lastSeen > LAST_SEEN_EVERY_MS) {
    await db
      .update(users)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(users.id, auth.user.id))
  }
  if (auth.limited || auth.expiresAt.getTime() - now > FULL_SESSION_MS - EXTEND_AFTER_MS)
    return null
  const expiresAt = new Date(now + FULL_SESSION_MS)
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, auth.sessionId))
  return expiresAt
}

export async function endSession(db: Executor, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

/** Signs a user out everywhere, except perhaps the session making the change. */
export async function endUserSessions(
  db: Executor,
  userId: string,
  except?: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), except ? ne(sessions.id, except) : undefined))
}

export function csrfMatches(auth: Auth, header: string | undefined): boolean {
  if (!header) return false
  const expected = Buffer.from(auth.csrfToken)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// ── The cookie ───────────────────────────────────────────────────────────────

/** In production, `__Host-` makes the browser insist on Secure, Path=/ and no Domain. */
export function sessionCookieName(config: Config): string {
  return config.nodeEnv === 'production' ? '__Host-dfs_session' : 'dfs_session'
}

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(sessionCookieName(config), {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
  })
}

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
