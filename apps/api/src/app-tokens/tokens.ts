import { randomBytes } from 'node:crypto'
import { appendJournal, appTokens, users, type Executor } from '@dfs/db'
import type { AppToken, MadeAppToken, MakeAppTokenInput } from '@dfs/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import { LAST_SEEN_EVERY_MS, type Auth, type UserRow } from '../auth/sessions.ts'
import { hashSecret } from '../devices/devices.ts'
import { ApiError } from '../errors.ts'
import { folderLocations, VISIBLE } from '../nodes/read.ts'
import { lockDrive } from '../nodes/write.ts'

// App tokens (DESIGN.md §7.8): a credential for a script or an AI agent, with
// one folder of My drive to read or write. Found by its SHA-256 and never
// kept, as a device's is; its audit entries are journaled, the token is not.

/** `dfs_app_` and 32 random bytes in base64url. It never matches a device token's pattern, nor the reverse. */
export const APP_TOKEN_PATTERN = /^dfs_app_[A-Za-z0-9_-]{43}$/
/** At most this many tokens per user. */
const MAX_TOKENS = 50
/** Enough to tell programs apart, as for devices. */
const MAX_AGENT = 200

export function newAppToken(): string {
  return `dfs_app_${randomBytes(32).toString('base64url')}`
}

/** An app that signed in with its token: whose it is, and what it may reach. */
export interface AppTokenAuth {
  tokenId: string
  tokenName: string
  folderId: string
  canWrite: boolean
  user: UserRow
  /** When the token was last noted as used, before this request. */
  lastUsedAt: Date | null
}

/** The token's record and its user; `null` for a bad pattern, an unknown hash or a disabled user. */
export async function findAppToken(db: Executor, token: string): Promise<AppTokenAuth | null> {
  if (!APP_TOKEN_PATTERN.test(token)) return null
  const [row] = await db
    .select({ token: appTokens, user: users })
    .from(appTokens)
    .innerJoin(users, eq(users.id, appTokens.userId))
    .where(and(eq(appTokens.tokenHash, hashSecret(token)), sql`${users.disabledAt} IS NULL`))
  if (!row) return null
  return {
    tokenId: row.token.id,
    tokenName: row.token.name,
    folderId: row.token.folderId,
    canWrite: row.token.canWrite,
    user: row.user,
    lastUsedAt: row.token.lastUsedAt,
  }
}

/** Notes when and from where a token was used, at most once in a while, as for devices. */
export async function touchAppToken(
  db: Executor,
  token: AppTokenAuth,
  from: { ip: string; agent: string | null },
): Promise<void> {
  const now = Date.now()
  if (token.lastUsedAt && now - token.lastUsedAt.getTime() <= LAST_SEEN_EVERY_MS) return
  await db
    .update(appTokens)
    .set({
      lastUsedAt: new Date(now),
      lastAddress: from.ip,
      lastAgent: from.agent?.slice(0, MAX_AGENT) ?? null,
    })
    .where(eq(appTokens.id, token.tokenId))
}

/** A token as the list queries select it: with `TOKEN_COLUMNS`. */
export interface TokenRow extends Record<string, unknown> {
  id: string
  name: string
  folder_id: string
  folder_available: boolean
  can_write: boolean
  created_at: string
  last_used_at: string | null
  last_address: string | null
  last_agent: string | null
}

/** The folder is visible and in My drive: all a token needs of it to work. Assumes the alias `token`. */
const FOLDER_AVAILABLE = sql`EXISTS (
  SELECT 1 FROM nodes n /* tree: drive only, the token's reach (§7.8) */
  WHERE n.id = token.folder_id AND n.kind = 'folder' AND ${VISIBLE} AND n.tree = 'drive')`

/** Columns of `app_tokens token` that `toAppToken` reads. */
export const TOKEN_COLUMNS = sql`token.id, token.name, token.folder_id,
  ${FOLDER_AVAILABLE} AS folder_available, token.can_write,
  token.created_at::text AS created_at, token.last_used_at::text AS last_used_at,
  token.last_address, token.last_agent`

/** A token's answer; `paths` is `folderLocations` of the rows' folders. */
export function toAppToken(row: TokenRow, paths: Map<string, string>): AppToken {
  return {
    id: row.id,
    name: row.name,
    folderId: row.folder_id,
    folderPath: paths.get(row.folder_id) ?? '',
    folderAvailable: row.folder_available,
    canWrite: row.can_write,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    lastAddress: row.last_address,
    lastAgent: row.last_agent,
  }
}

/** `POST /app-tokens`: makes a token for one of the user's folders in My drive. Shown once. */
export async function makeAppToken(
  app: FastifyInstance,
  auth: Auth,
  input: MakeAppTokenInput,
): Promise<MadeAppToken> {
  const token = newAppToken()
  const appToken = await app.db.transaction(async (tx) => {
    // The drive's shared tree lock first, as starting an upload takes it: a
    // purge or a trash of the folder waits, so it stays as checked until commit.
    await lockDrive(tx, auth.user.id, 'shared')
    // The user's row serializes two requests at once, so they can't both make
    // the 50th. It also settles the race with a password change: its
    // `endUserSessions` either committed first, and the session is gone, or
    // comes after and deletes this token too.
    await tx.execute(sql`SELECT id FROM users WHERE id = ${auth.user.id} FOR UPDATE`)
    const { rows: live } = await tx.execute(
      sql`SELECT 1 FROM sessions WHERE id = ${auth.sessionId} AND expires_at > now()`,
    )
    if (live.length === 0) {
      throw new ApiError(401, 'unauthenticated', 'Sign in again to make an app token.')
    }

    const { rows: found } = await tx.execute<{ kind: 'file' | 'folder' }>(sql`
      SELECT n.kind FROM nodes n /* tree: drive only, the token's reach (§7.8) */
      WHERE n.id = ${input.folderId} AND n.owner_id = ${auth.user.id} AND ${VISIBLE}
        AND n.tree = 'drive'`)
    const [folder] = found
    if (!folder) throw new ApiError(404, 'not_found', 'No such folder.')
    if (folder.kind !== 'folder') {
      throw new ApiError(400, 'not_a_folder', 'An app token needs a folder, not a file.')
    }

    const { rows: counted } = await tx.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM app_tokens WHERE user_id = ${auth.user.id}`,
    )
    if ((counted[0]?.count ?? 0) >= MAX_TOKENS) {
      throw new ApiError(
        409,
        'too_many_tokens',
        `You can have at most ${String(MAX_TOKENS)} app tokens. Remove one first.`,
      )
    }

    const [made] = await tx
      .insert(appTokens)
      .values({
        userId: auth.user.id,
        name: input.name,
        tokenHash: hashSecret(token),
        folderId: input.folderId,
        canWrite: input.canWrite,
      })
      .returning()
    if (!made) throw new Error('The app token was not made.')
    const path = (await folderLocations(tx, [made.folderId])).get(made.folderId) ?? ''
    await appendJournal(
      tx,
      await audit(tx, {
        actorId: auth.user.id,
        action: 'app_token.made',
        target: input.name,
        details: `${path}, ${input.canWrite ? 'read and write' : 'read only'}`,
        nodeId: made.folderId,
      }),
    )
    return {
      id: made.id,
      name: made.name,
      folderId: made.folderId,
      folderPath: path,
      folderAvailable: true,
      canWrite: made.canWrite,
      createdAt: made.createdAt.toISOString(),
      lastUsedAt: null,
      lastAddress: null,
      lastAgent: null,
    }
  })
  return { token, appToken }
}

async function queryTokens(
  app: FastifyInstance,
  where: ReturnType<typeof sql>,
): Promise<AppToken[]> {
  const { rows } = await app.db.execute<TokenRow>(sql`
    SELECT ${TOKEN_COLUMNS} FROM app_tokens token WHERE ${where}
    ORDER BY token.created_at DESC, token.id DESC`)
  const paths = await folderLocations(
    app.db,
    rows.map((row) => row.folder_id),
  )
  return rows.map((row) => toAppToken(row, paths))
}

/** `GET /app-tokens`: the user's tokens, newest first. */
export function listAppTokens(app: FastifyInstance, auth: Auth): Promise<AppToken[]> {
  return queryTokens(app, sql`token.user_id = ${auth.user.id}`)
}

/** `DELETE /app-tokens/:id`: ends one of the user's own tokens. */
export async function removeAppToken(app: FastifyInstance, auth: Auth, id: string): Promise<void> {
  await app.db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(appTokens)
      .where(and(eq(appTokens.id, id), eq(appTokens.userId, auth.user.id)))
      .returning({ name: appTokens.name, folderId: appTokens.folderId })
    if (!removed) throw new ApiError(404, 'not_found', 'No such app token.')
    await appendJournal(
      tx,
      await audit(tx, {
        actorId: auth.user.id,
        action: 'app_token.removed',
        target: removed.name,
        nodeId: removed.folderId,
      }),
    )
  })
}
