import type { AdminUser, CreateUserInput, ResetPasswordInput, UpdateUserInput } from '@dfs/shared'
import { formatBytes } from '@dfs/shared'
import { appendJournal, folderStats, userRecord, users } from '@dfs/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit, type AuditEntry } from '../audit.ts'
import { hashPassword, passwordProblem } from '../auth/passwords.ts'
import { endUserSessions, type Auth, type UserRow } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { createUser, toUserDto } from './users.ts'

// Accounts as admins manage them (DESIGN.md §7.1, §9, D27, D28).

const DAY_MS = 24 * 60 * 60_000

export async function listUsers(app: FastifyInstance): Promise<AdminUser[]> {
  // File counts come from the root folders' stats: eventually consistent, and one row per user.
  const rows = await app.db
    .select({ user: users, fileCount: folderStats.fileCount })
    .from(users)
    .leftJoin(folderStats, eq(folderStats.nodeId, users.rootNodeId))
    .orderBy(sql`lower(${users.displayName})`, users.username)
  return rows.map((row) => toAdminUser(row.user, row.fileCount ?? 0))
}

export async function createUserAsAdmin(
  app: FastifyInstance,
  admin: Auth,
  input: CreateUserInput,
): Promise<AdminUser> {
  const problem = await passwordProblem(input.temporaryPassword, input.username, null)
  if (problem) throw new ApiError(400, 'password_rejected', problem)
  const passwordHash = await hashPassword(input.temporaryPassword)
  const user = await app.db.transaction(async (tx) => {
    const created = await createUser(tx, {
      username: input.username,
      displayName: input.displayName ?? input.username,
      passwordHash,
      passwordExpiresAt: temporaryPasswordExpiry(app),
      role: input.role ?? 'user',
      quotaBytes: input.quotaBytes ?? app.config.defaultQuotaBytes,
    })
    await appendJournal(
      tx,
      await audit(tx, {
        actorId: admin.user.id,
        action: 'user.created',
        target: created.displayName,
        details: `@${created.username} · ${formatBytes(created.quotaBytes)} · ${created.role === 'admin' ? 'Admin' : 'User'}`,
      }),
    )
    return created
  })
  return toAdminUser(user, 0)
}

export async function updateUserAsAdmin(
  app: FastifyInstance,
  admin: Auth,
  id: string,
  changes: UpdateUserInput,
): Promise<AdminUser> {
  return app.db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, id)).for('update')
    if (!user) throw notFound()
    const demotes = changes.role === 'user' || changes.disabled === true
    if (user.isOwner && demotes) {
      throw new ApiError(
        409,
        'owner_protected',
        'The owner is always an admin and can’t be disabled.',
      )
    }
    if (user.id === admin.user.id && demotes) {
      throw new ApiError(409, 'self_change', 'You can’t demote or disable your own account.')
    }

    const details: string[] = []
    const set: Partial<UserRow> = {}
    if (changes.displayName !== undefined && changes.displayName !== user.displayName) {
      details.push(`Name ${user.displayName} → ${changes.displayName}`)
      set.displayName = changes.displayName
    }
    if (changes.quotaBytes !== undefined && changes.quotaBytes !== user.quotaBytes) {
      details.push(`Quota ${formatBytes(user.quotaBytes)} → ${formatBytes(changes.quotaBytes)}`)
      set.quotaBytes = changes.quotaBytes
    }
    if (changes.role !== undefined && changes.role !== user.role) {
      details.push(`Role ${user.role} → ${changes.role}`)
      set.role = changes.role
    }
    const disabling = changes.disabled === true && !user.disabledAt
    const enabling = changes.disabled === false && user.disabledAt !== null
    if (disabling) set.disabledAt = new Date()
    if (enabling) set.disabledAt = null

    if (Object.keys(set).length === 0) return toAdminUser(user, await fileCount(app, user))
    const [updated] = await tx.update(users).set(set).where(eq(users.id, id)).returning()
    if (!updated) throw notFound()

    const actor = admin.user.id
    const entries: AuditEntry[] = []
    if (details.length > 0) {
      entries.push({
        actorId: actor,
        action: 'user.updated',
        target: updated.displayName,
        details: details.join(', '),
      })
    }
    if (disabling) {
      await endUserSessions(tx, id)
      entries.push({ actorId: actor, action: 'user.disabled', target: updated.displayName })
    }
    if (enabling) {
      entries.push({ actorId: actor, action: 'user.enabled', target: updated.displayName })
    }
    const audited = await audit(tx, entries)
    await appendJournal(tx, [userRecord(updated), ...audited])
    return toAdminUser(updated, await fileCount(app, updated))
  })
}

/**
 * Gives a user a new temporary password and signs them out everywhere. Never
 * the owner, whose way back is `dfs owner` on the server (D28), and never
 * yourself, which is what Settings is for.
 */
export async function resetPassword(
  app: FastifyInstance,
  admin: Auth,
  id: string,
  input: ResetPasswordInput,
): Promise<AdminUser> {
  const [user] = await app.db.select().from(users).where(eq(users.id, id))
  if (!user) throw notFound()
  if (user.isOwner) {
    throw new ApiError(
      409,
      'owner_protected',
      'The owner’s password can only be reset on the server, with dfs owner.',
    )
  }
  if (user.id === admin.user.id) {
    throw new ApiError(409, 'self_change', 'Change your own password in Settings.')
  }
  const problem = await passwordProblem(input.temporaryPassword, user.username, user.passwordHash)
  if (problem) throw new ApiError(400, 'password_rejected', problem)
  const passwordHash = await hashPassword(input.temporaryPassword)

  const updated = await app.db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({
        passwordHash,
        passwordExpiresAt: temporaryPasswordExpiry(app),
        failedSignIns: 0,
        signInLockedUntil: null,
        passwordResetRequestedAt: null,
      })
      .where(eq(users.id, id))
      .returning()
    if (!row) throw notFound()
    await endUserSessions(tx, id)
    const audited = await audit(tx, {
      actorId: admin.user.id,
      action: 'user.password_reset',
      target: row.displayName,
    })
    await appendJournal(tx, [userRecord(row), ...audited])
    return row
  })
  return toAdminUser(updated, await fileCount(app, updated))
}

export function toAdminUser(user: UserRow, files: number): AdminUser {
  return {
    ...toUserDto(user),
    isOwner: user.isOwner,
    disabled: user.disabledAt !== null,
    activatedAt: user.activatedAt?.toISOString() ?? null,
    temporaryPasswordExpiresAt: user.passwordExpiresAt?.toISOString() ?? null,
    passwordResetRequestedAt: user.passwordResetRequestedAt?.toISOString() ?? null,
    fileCount: files,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
  }
}

async function fileCount(app: FastifyInstance, user: UserRow): Promise<number> {
  if (!user.rootNodeId) return 0
  const [stats] = await app.db
    .select({ fileCount: folderStats.fileCount })
    .from(folderStats)
    .where(eq(folderStats.nodeId, user.rootNodeId))
  return stats?.fileCount ?? 0
}

function temporaryPasswordExpiry(app: FastifyInstance): Date {
  return new Date(Date.now() + app.config.tempPasswordDays * DAY_MS)
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'No such user.')
}
