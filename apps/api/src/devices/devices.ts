import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendJournal, devicePairings, deviceTokens, users, type Executor } from '@dfs/db'
import type {
  Device,
  DeviceToken,
  DeviceTokenRequest,
  PairDeviceInput,
  PairingCode,
} from '@dfs/shared'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit.ts'
import { LAST_SEEN_EVERY_MS, type Auth, type UserRow } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'

// Device tokens (DESIGN.md §7.6): a credential for one computer's backup app.
// A token is found by its SHA-256 and never kept, so a copy of the table can't
// sign a device in.

/** `dfs_` and 32 random bytes in base64url (§7.6). */
export const DEVICE_TOKEN_PATTERN = /^dfs_[A-Za-z0-9_-]{43}$/
/** A pairing code is good for a minute (§7.6). */
const PAIRING_LIFETIME_MS = 60_000
/** Enough to tell programs apart, as for sessions. */
const MAX_AGENT = 200

export function newDeviceToken(): string {
  return `dfs_${randomBytes(32).toString('base64url')}`
}

/** Tokens and pairing codes are found by their SHA-256, never kept in clear. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/** RFC 7636 S256: whether `verifier` hashes to `challenge`. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A device that signed in with its token, and whose it is. */
export interface DeviceAuth {
  deviceId: string
  deviceName: string
  user: UserRow
  /** When the token was last noted as used, before this request. */
  lastUsedAt: Date | null
}

/** Where a request comes from, as the device list shows it. */
export interface DeviceClient {
  ip: string
  agent: string | null
}

/** `POST /devices/pair`: the signed-in user approves a backup app; the code goes to the app via the browser. */
export async function createPairing(
  app: FastifyInstance,
  auth: Auth,
  input: PairDeviceInput,
): Promise<PairingCode> {
  const code = randomBytes(32).toString('base64url')
  await app.db.insert(devicePairings).values({
    codeHash: hashSecret(code),
    userId: auth.user.id,
    name: input.name,
    challenge: input.challenge,
    expiresAt: new Date(Date.now() + PAIRING_LIFETIME_MS),
  })
  return { code }
}

/**
 * `POST /devices/token`: trades a pairing code and the verifier of its
 * challenge for a device token. The code is gone whatever the answer, so a
 * wrong verifier gets no second guess; every failure counts against the
 * address, as a wrong password does (§7.6).
 */
export async function redeemPairing(
  app: FastifyInstance,
  input: DeviceTokenRequest,
  from: DeviceClient,
): Promise<DeviceToken> {
  const wait = app.limits.deviceTokens.waitMs(from.ip)
  if (wait > 0) throw tooManyDeviceTries(wait)

  const token = newDeviceToken()
  // The transaction ends normally when the verifier is wrong, so that the
  // code's deletion is committed; the refusal follows it. Deleting the code
  // and making the device in one transaction also keeps `endUserSessions`
  // from missing a device made as it ends the user's devices: it deletes
  // their pairings first, which waits for this transaction's lock on the
  // code, and the delete of their tokens that follows then sees the new one.
  const device = await app.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ user_id: string; name: string; challenge: string }>(sql`
      DELETE FROM device_pairings pairing
      USING users
      WHERE pairing.code_hash = ${hashSecret(input.code)} AND pairing.expires_at > now()
        AND users.id = pairing.user_id AND users.disabled_at IS NULL
      RETURNING pairing.user_id, pairing.name, pairing.challenge`)
    const [row] = rows
    if (!row || !verifierMatches(input.verifier, row.challenge)) return null

    const [made] = await tx
      .insert(deviceTokens)
      .values({
        userId: row.user_id,
        name: row.name,
        tokenHash: hashSecret(token),
        lastUsedAt: null,
      })
      .returning({ id: deviceTokens.id, name: deviceTokens.name })
    if (!made) throw new Error('The device was not made.')
    const audited = await audit(tx, {
      actorId: row.user_id,
      action: 'device.paired',
      target: row.name,
      details: from.ip,
    })
    await appendJournal(tx, audited)
    return made
  })
  if (!device) {
    app.limits.deviceTokens.hit(from.ip)
    throw new ApiError(
      400,
      'invalid_pairing',
      'This pairing code is wrong or has expired. Pair the device again.',
    )
  }
  return { token, device }
}

/** The device behind a token, with its user; `null` if the token was never made, was removed, or its user is disabled. */
export async function findDevice(db: Executor, token: string): Promise<DeviceAuth | null> {
  if (!DEVICE_TOKEN_PATTERN.test(token)) return null
  const [row] = await db
    .select({ device: deviceTokens, user: users })
    .from(deviceTokens)
    .innerJoin(users, eq(users.id, deviceTokens.userId))
    .where(and(eq(deviceTokens.tokenHash, hashSecret(token)), isNull(users.disabledAt)))
  if (!row) return null
  return {
    deviceId: row.device.id,
    deviceName: row.device.name,
    user: row.user,
    lastUsedAt: row.device.lastUsedAt,
  }
}

/** Notes when and from where a token was used, at most once in a while, as for sessions. */
export async function touchDevice(
  db: Executor,
  device: DeviceAuth,
  from: DeviceClient,
): Promise<void> {
  const now = Date.now()
  if (device.lastUsedAt && now - device.lastUsedAt.getTime() <= LAST_SEEN_EVERY_MS) return
  await db
    .update(deviceTokens)
    .set({
      lastUsedAt: new Date(now),
      lastAddress: from.ip,
      lastAgent: from.agent?.slice(0, MAX_AGENT) ?? null,
    })
    .where(eq(deviceTokens.id, device.deviceId))
}

/** `GET /devices`: the user's devices, newest first. */
export async function listDevices(app: FastifyInstance, auth: Auth): Promise<Device[]> {
  const rows = await app.db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, auth.user.id))
    .orderBy(desc(deviceTokens.createdAt), desc(deviceTokens.id))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastAddress: row.lastAddress,
    lastAgent: row.lastAgent,
  }))
}

/** `DELETE /devices/:id`: ends one of the user's own devices. */
export async function removeDevice(app: FastifyInstance, auth: Auth, id: string): Promise<void> {
  await app.db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(deviceTokens)
      .where(and(eq(deviceTokens.id, id), eq(deviceTokens.userId, auth.user.id)))
      .returning({ name: deviceTokens.name })
    if (!removed) throw new ApiError(404, 'not_found', 'No such device.')
    await appendJournal(
      tx,
      await audit(tx, { actorId: auth.user.id, action: 'device.removed', target: removed.name }),
    )
  })
}

/** The 429 for too many failures from one address, with when to try again. */
export function tooManyDeviceTries(retryAfterMs: number): ApiError {
  const seconds = Math.ceil(retryAfterMs / 1000)
  return new ApiError(
    429,
    'rate_limited',
    'Too many failed attempts to use a device token. Wait a little, then try again.',
    { 'retry-after': String(seconds) },
  )
}
