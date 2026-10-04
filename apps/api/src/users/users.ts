import type { Role, User } from '@dfs/shared'
import { appendJournal, nodeRecord, nodes, userRecord, users, type Executor } from '@dfs/db'
import { eq } from 'drizzle-orm'
import type { UserRow } from '../auth/sessions.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'

export interface NewUser {
  username: string
  displayName: string
  passwordHash: string
  /** When the temporary password stops working; every new account starts with one (§7.1). */
  passwordExpiresAt: Date
  role: Role
  quotaBytes: number
  isOwner?: boolean
}

const ROOT_NAME = 'My Drive'

/**
 * Creates an account with its root folder, in the caller's transaction. The
 * account is pending until its user chooses a password.
 */
export async function createUser(tx: Executor, input: NewUser): Promise<UserRow> {
  let user: UserRow | undefined
  try {
    ;[user] = await tx.insert(users).values(input).returning()
  } catch (error) {
    if (isUniqueViolation(error, 'users_username_key')) {
      throw new ApiError(409, 'username_taken', `The username “${input.username}” is taken.`)
    }
    throw error
  }
  if (!user) throw new Error('Inserting a user returned nothing.')

  const [root] = await tx
    .insert(nodes)
    .values({ ownerId: user.id, kind: 'folder', name: ROOT_NAME, nameKey: ROOT_NAME.toLowerCase() })
    .returning()
  if (!root) throw new Error('Inserting a root folder returned nothing.')
  const [withRoot] = await tx
    .update(users)
    .set({ rootNodeId: root.id })
    .where(eq(users.id, user.id))
    .returning()
  if (!withRoot) throw new Error('The new user disappeared.')

  await appendJournal(tx, [userRecord(withRoot), nodeRecord(root)])
  return withRoot
}

export function toUserDto(user: UserRow): User {
  if (!user.rootNodeId) throw new Error(`User ${user.id} has no root folder.`)
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    rootFolderId: user.rootNodeId,
    quotaBytes: user.quotaBytes,
    usedBytes: user.usedBytes,
  }
}

/** Why a session must choose a password first: a first sign-in or a reset; `null` if it needn't. */
export function pendingPasswordChange(user: UserRow): 'activate' | 'reset' | null {
  if (!user.passwordExpiresAt) return null
  return user.activatedAt ? 'reset' : 'activate'
}
