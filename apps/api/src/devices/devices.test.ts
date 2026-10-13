import { createHash, randomBytes } from 'node:crypto'
import { auditLog, deviceTokens, devicePairings, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { endUserSessions, sessionCookieName } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Pairing a backup app through the browser, and signing it in with a device
// token (DESIGN.md §7.6), against a real database.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let origin: string

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  origin = setup.config.publicBaseUrl
  app = await buildApp({ config: setup.config, logger: false })
  for (const username of [
    'alice',
    'bob',
    'carol',
    'dave',
    'erin',
    'frank',
    'gina',
    'hana',
    'ivan',
    'judy',
  ]) {
    await seedUser(app.db, { username, password: `the-${username}-password` })
  }
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

/** What a browser holds after signing in: the cookie, and the CSRF token to send back. */
interface Browser {
  userId: string
  cookie: string
  csrfToken: string
}

async function signIn(username: string): Promise<Browser> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username, password: `the-${username}-password` },
  })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies.find((c) => c.name === sessionCookieName(app.config))
  const body = response.json<{ csrfToken: string; user: { id: string } }>()
  return {
    userId: body.user.id,
    cookie: `${sessionCookieName(app.config)}=${cookie?.value ?? ''}`,
    csrfToken: body.csrfToken,
  }
}

type Method = 'GET' | 'POST' | 'DELETE'

/** A request the web app would make: the cookie, and the CSRF token unless left out. */
function asBrowser(
  browser: Browser,
  method: Method,
  url: string,
  options: { payload?: object; withoutCsrf?: boolean } = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: browser.cookie,
      ...(options.withoutCsrf ? {} : { 'x-csrf-token': browser.csrfToken }),
    },
    payload: options.payload,
  })
}

/** A request the backup app would make: a Bearer token and nothing else. */
function asDevice(
  token: string,
  method: Method,
  url: string,
  options: { agent?: string; remoteAddress?: string } = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.agent ? { 'user-agent': options.agent } : {}),
    },
    remoteAddress: options.remoteAddress,
  })
}

/** A PKCE pair (RFC 7636, S256), as the backup app makes one. */
function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** The app's trade of a code for a token: no cookie, and no Origin, as a native app sends none. */
function redeem(code: string, verifier: string, remoteAddress?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/devices/token',
    payload: { code, verifier },
    remoteAddress,
  })
}

async function approve(browser: Browser, name: string) {
  const pair = pkce()
  const response = await asBrowser(browser, 'POST', '/api/devices/pair', {
    payload: { name, challenge: pair.challenge },
  })
  expect(response.statusCode).toBe(201)
  return { ...pair, code: response.json<{ code: string }>().code }
}

/** Pairs a device end to end. */
async function pairDevice(browser: Browser, name: string) {
  const approved = await approve(browser, name)
  const response = await redeem(approved.code, approved.verifier)
  expect(response.statusCode).toBe(201)
  return response.json<{ token: string; device: { id: string; name: string } }>()
}

const neverIssued = () => `dfs_${randomBytes(32).toString('base64url')}`

describe('device tokens (§7.6)', () => {
  it('pairs a device through a signed-in session, and its token reaches /devices/me', async () => {
    const alice = await signIn('alice')
    const approved = await approve(alice, 'Studio PC')
    expect(approved.code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const response = await redeem(approved.code, approved.verifier)
    expect(response.statusCode).toBe(201)
    const paired = response.json<{ token: string; device: { id: string; name: string } }>()
    expect(paired.token).toMatch(/^dfs_[A-Za-z0-9_-]{43}$/)
    expect(paired.device.name).toBe('Studio PC')

    const me = await asDevice(paired.token, 'GET', '/api/devices/me')
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({
      device: { id: paired.device.id, name: 'Studio PC' },
      user: { id: alice.userId, username: 'alice', displayName: 'alice' },
    })

    const audited = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, alice.userId), eq(auditLog.action, 'device.paired')))
    expect(audited).toHaveLength(1)
    expect(audited[0]?.meta).toMatchObject({ target: 'Studio PC' })
  })

  it('works once per code', async () => {
    const bob = await signIn('bob')
    const approved = await approve(bob, 'Laptop')
    expect((await redeem(approved.code, approved.verifier)).statusCode).toBe(201)
    const again = await redeem(approved.code, approved.verifier)
    expect(again.statusCode).toBe(400)
    expect(again.json()).toMatchObject({ error: { code: 'invalid_pairing' } })
  })

  it('uses a code up when the verifier is wrong', async () => {
    const carol = await signIn('carol')
    const approved = await approve(carol, 'Office PC')
    const wrong = await redeem(approved.code, pkce().verifier)
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json()).toMatchObject({ error: { code: 'invalid_pairing' } })

    const right = await redeem(approved.code, approved.verifier)
    expect(right.statusCode).toBe(400)
    expect(right.json()).toMatchObject({ error: { code: 'invalid_pairing' } })
    const made = await app.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, carol.userId))
    expect(made).toHaveLength(0)
  })

  it('refuses an expired code', async () => {
    const dave = await signIn('dave')
    const approved = await approve(dave, 'Old PC')
    await app.db.execute(
      sql`UPDATE device_pairings SET expires_at = now() - interval '1 second' WHERE user_id = ${dave.userId}`,
    )
    const response = await redeem(approved.code, approved.verifier)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_pairing' } })
  })

  it('needs a full session and its CSRF token to pair', async () => {
    const { challenge } = pkce()
    const payload = { name: 'Studio PC', challenge }

    const anonymous = await app.inject({ method: 'POST', url: '/api/devices/pair', payload })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json()).toMatchObject({ error: { code: 'unauthenticated' } })

    const erin = await signIn('erin')
    const noCsrf = await asBrowser(erin, 'POST', '/api/devices/pair', {
      payload,
      withoutCsrf: true,
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json()).toMatchObject({ error: { code: 'csrf_failed' } })

    // A session opened with a temporary password may only choose a new one.
    await app.db
      .update(users)
      .set({ passwordExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(users.username, 'frank'))
    const frank = await signIn('frank')
    const limited = await asBrowser(frank, 'POST', '/api/devices/pair', { payload })
    expect(limited.statusCode).toBe(403)
    expect(limited.json()).toMatchObject({ error: { code: 'password_change_required' } })

    const tooLong = await asBrowser(erin, 'POST', '/api/devices/pair', {
      payload: { name: 'x'.repeat(81), challenge },
    })
    expect(tooLong.statusCode).toBe(400)
    const none = await app.db
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.userId, erin.userId))
    expect(none).toHaveLength(0)
  })

  it('keeps device tokens and sessions apart', async () => {
    const gina = await signIn('gina')
    const { token } = await pairDevice(gina, 'Desk')

    const list = await asDevice(token, 'GET', '/api/devices')
    expect(list.statusCode).toBe(401)
    expect(list.json()).toMatchObject({ error: { code: 'unauthenticated' } })
    expect((await asDevice(token, 'GET', '/api/auth/me')).statusCode).toBe(401)
    expect((await asDevice(token, 'POST', '/api/devices/pair')).statusCode).toBe(401)

    const me = await app.inject({
      method: 'GET',
      url: '/api/devices/me',
      headers: { cookie: gina.cookie },
    })
    expect(me.statusCode).toBe(401)
    expect(me.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  })

  it('refuses missing, malformed and unknown tokens, and audits the unknown', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/devices/me' })
    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toMatchObject({ error: { code: 'unauthenticated' } })

    const malformed = await asDevice('abc', 'GET', '/api/devices/me')
    expect(malformed.statusCode).toBe(401)
    expect(malformed.json()).toMatchObject({ error: { code: 'unauthenticated' } })

    const before = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.device_failed'), isNull(auditLog.userId)))
    const unknown = await asDevice(neverIssued(), 'GET', '/api/devices/me')
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json()).toMatchObject({ error: { code: 'invalid_token' } })
    const after = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.device_failed'), isNull(auditLog.userId)))
    expect(after.length).toBe(before.length + 1)
    expect(after.at(-1)?.meta).toMatchObject({ target: 'a device token' })
  })

  it('ends a user’s devices wherever their sessions end', async () => {
    const hana = await signIn('hana')
    const { token } = await pairDevice(hana, 'Hana PC')
    // A code not yet traded goes too.
    const pending = await approve(hana, 'Hana laptop')
    expect((await asDevice(token, 'GET', '/api/devices/me')).statusCode).toBe(200)

    await endUserSessions(app.db, hana.userId)
    const ended = await asDevice(token, 'GET', '/api/devices/me')
    expect(ended.statusCode).toBe(401)
    expect(ended.json()).toMatchObject({ error: { code: 'invalid_token' } })
    expect(
      await app.db.select().from(deviceTokens).where(eq(deviceTokens.userId, hana.userId)),
    ).toHaveLength(0)
    expect(
      await app.db.select().from(devicePairings).where(eq(devicePairings.userId, hana.userId)),
    ).toHaveLength(0)
    expect((await redeem(pending.code, pending.verifier)).statusCode).toBe(400)

    // A disabled account's token is dead even if nothing deleted it.
    const ivan = await signIn('ivan')
    const kept = await pairDevice(ivan, 'Ivan PC')
    await app.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, ivan.userId))
    const disabled = await asDevice(kept.token, 'GET', '/api/devices/me')
    expect(disabled.statusCode).toBe(401)
    expect(disabled.json()).toMatchObject({ error: { code: 'invalid_token' } })
  })

  it('lists a user’s devices and removes one', async () => {
    const judy = await signIn('judy')
    const alice = await signIn('alice')
    const { token, device } = await pairDevice(judy, 'Judy PC')

    const fresh = await asBrowser(judy, 'GET', '/api/devices')
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json()).toEqual([
      expect.objectContaining({
        id: device.id,
        name: 'Judy PC',
        lastUsedAt: null,
        lastAddress: null,
        lastAgent: null,
      }),
    ])

    await asDevice(token, 'GET', '/api/devices/me', { agent: 'DFS Backup/1.0' })
    const used = await asBrowser(judy, 'GET', '/api/devices')
    const [listed] = used.json<{ lastUsedAt: string | null }[]>()
    expect(listed).toMatchObject({
      id: device.id,
      lastAddress: '127.0.0.1',
      lastAgent: 'DFS Backup/1.0',
    })
    expect(Date.parse(listed?.lastUsedAt ?? '')).toBeGreaterThan(Date.now() - 60_000)

    // Another user's device is not found, rather than forbidden.
    const foreign = await asBrowser(alice, 'DELETE', `/api/devices/${device.id}`)
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json()).toMatchObject({ error: { code: 'not_found' } })
    expect((await asDevice(token, 'GET', '/api/devices/me')).statusCode).toBe(200)

    const removed = await asBrowser(judy, 'DELETE', `/api/devices/${device.id}`)
    expect(removed.statusCode).toBe(204)
    expect((await asDevice(token, 'GET', '/api/devices/me')).statusCode).toBe(401)
    expect((await asBrowser(judy, 'GET', '/api/devices')).json()).toEqual([])
    const audited = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, judy.userId), eq(auditLog.action, 'device.removed')))
    expect(audited).toHaveLength(1)
    expect(audited[0]?.meta).toMatchObject({ target: 'Judy PC' })
  })

  it('answers the token in the body alone', async () => {
    const alice = await signIn('alice')
    const approved = await approve(alice, 'Body only')
    const response = await redeem(approved.code, approved.verifier)
    expect(response.statusCode).toBe(201)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers.location).toBeUndefined()
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json<{ token: string; device: { id: string; name: string } }>()
    expect(Object.keys(body).sort()).toEqual(['device', 'token'])
    expect(body).toEqual({
      token: expect.stringMatching(/^dfs_/) as string,
      device: { id: expect.any(String) as string, name: 'Body only' },
    })
  })

  // Last in the file: the limiter is in memory, and counts from the first failure.
  it('limits failures per address', async () => {
    const address = '198.51.100.7'
    let refused: Awaited<ReturnType<typeof asDevice>> | null = null
    let tries = 0
    while (!refused && tries < 40) {
      tries += 1
      const response = await asDevice(neverIssued(), 'GET', '/api/devices/me', {
        remoteAddress: address,
      })
      if (response.statusCode === 429) refused = response
      else expect(response.statusCode).toBe(401)
    }
    expect(refused).not.toBeNull()
    expect(tries).toBeLessThanOrEqual(31)
    expect(refused?.json()).toMatchObject({ error: { code: 'rate_limited' } })
    expect(Number(refused?.headers['retry-after'])).toBeGreaterThan(0)

    const { verifier } = pkce()
    const trade = await redeem(randomBytes(32).toString('base64url'), verifier, address)
    expect(trade.statusCode).toBe(429)
    expect(Number(trade.headers['retry-after'])).toBeGreaterThan(0)
    // Another address is not held up.
    const elsewhere = await redeem(randomBytes(32).toString('base64url'), verifier, '198.51.100.8')
    expect(elsewhere.statusCode).toBe(400)
  })
})
