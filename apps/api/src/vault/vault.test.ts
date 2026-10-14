import { createHash } from 'node:crypto'
import {
  unwrapVaultKeyByCode,
  unwrapVaultKeyByRecovery,
  openVaultKeyFromSession,
} from '@dfs/crypto'
import { auditLog, nodes, sessions, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { sessionCookieName } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Making the vault and asking for its state (DESIGN.md §7.7), against a real
// database.

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
  for (const username of ['alice', 'bob', 'carol', 'limited']) {
    await seedUser(app.db, { username, password: `the-${username}-password` })
  }
  // A session opened with a temporary password may only choose a new one.
  await app.db
    .update(users)
    .set({ passwordExpiresAt: new Date(Date.now() + 24 * 60 * 60_000) })
    .where(eq(users.username, 'limited'))
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

/** What a browser holds after signing in: the cookie and its token, and the CSRF token to send back. */
interface Browser {
  userId: string
  token: string
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
    token: cookie?.value ?? '',
    cookie: `${sessionCookieName(app.config)}=${cookie?.value ?? ''}`,
    csrfToken: body.csrfToken,
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

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

const RECOVERY_KEY = /^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/

describe('making the vault (§7.7)', { timeout: 30_000 }, () => {
  let alice: Browser
  let recoveryKey = ''

  it('says there is no vault until one is made', async () => {
    alice = await signIn('alice')
    const response = await asBrowser(alice, 'GET', '/api/vault')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      exists: false,
      open: false,
      locksAt: null,
      resetAt: null,
      sizeBytes: 0,
      fileCount: 0,
    })
  })

  it('makes the vault, open in the browser that made it', async () => {
    const response = await asBrowser(alice, 'POST', '/api/vault', { payload: { code: '123456' } })
    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json<{
      recoveryKey: string
      vault: {
        exists: boolean
        open: boolean
        locksAt: string | null
        resetAt: string | null
        sizeBytes: number
        fileCount: number
      }
    }>()
    recoveryKey = body.recoveryKey
    expect(recoveryKey).toMatch(RECOVERY_KEY)
    expect(body.vault).toMatchObject({
      exists: true,
      open: true,
      resetAt: null,
      sizeBytes: 0,
      fileCount: 0,
    })
    const locksInMs = new Date(body.vault.locksAt ?? 0).getTime() - Date.now()
    expect(locksInMs).toBeGreaterThan(14 * 60_000)
    expect(locksInMs).toBeLessThan(16 * 60_000)

    const [user] = await app.db.select().from(users).where(eq(users.id, alice.userId))
    expect(user?.vaultRootId).toBeTruthy()
    expect(user?.vaultSalt).not.toBeNull()
    expect(user?.vaultKeyByCode).not.toBeNull()
    expect(user?.vaultKeyByRecovery).not.toBeNull()
    const [root] = await app.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, user?.vaultRootId ?? ''))
    expect(root).toMatchObject({
      parentId: null,
      tree: 'vault',
      ownerId: alice.userId,
      kind: 'folder',
    })
    const [session] = await app.db.select().from(sessions).where(eq(sessions.userId, alice.userId))
    expect(session?.vaultKeySealed).not.toBeNull()
  })

  it('keeps one key that the code, the recovery key and the session each open', async () => {
    const [user] = await app.db.select().from(users).where(eq(users.id, alice.userId))
    const [session] = await app.db.select().from(sessions).where(eq(sessions.userId, alice.userId))
    expect(user?.vaultKeyByCode && user.vaultKeyByRecovery && user.vaultSalt).toBeTruthy()
    expect(session?.vaultKeySealed).toBeTruthy()
    const sessionId = createHash('sha256').update(alice.token).digest('hex')
    expect(session?.id).toBe(sessionId)

    const byCode = await unwrapVaultKeyByCode(
      app.keys,
      user?.vaultKeyByCode ?? new Uint8Array(),
      '123456',
      user?.vaultSalt ?? new Uint8Array(),
      alice.userId,
    )
    const byRecovery = await unwrapVaultKeyByRecovery(
      user?.vaultKeyByRecovery ?? new Uint8Array(),
      recoveryKey,
      alice.userId,
    )
    const bySession = await openVaultKeyFromSession(
      session?.vaultKeySealed ?? new Uint8Array(),
      alice.token,
      sessionId,
    )
    expect(byCode).toHaveLength(32)
    expect(byRecovery).toEqual(byCode)
    expect(bySession).toEqual(byCode)

    const wrong = await unwrapVaultKeyByCode(
      app.keys,
      user?.vaultKeyByCode ?? new Uint8Array(),
      '654321',
      user?.vaultSalt ?? new Uint8Array(),
      alice.userId,
    )
    expect(wrong).toBeNull()
  })

  it('audits the vault being made, without the code', async () => {
    const rows = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, alice.userId), eq(auditLog.action, 'vault.created')))
    expect(rows).toHaveLength(1)
    const everything = await app.db.select().from(auditLog)
    for (const row of everything) {
      expect(JSON.stringify(row.meta)).not.toContain('123456')
    }
  })

  it('makes one vault for an account', async () => {
    const again = await asBrowser(alice, 'POST', '/api/vault', { payload: { code: '123456' } })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { code: 'vault_exists' } })
  })

  it('refuses a code that is too short', async () => {
    const bob = await signIn('bob')
    const response = await asBrowser(bob, 'POST', '/api/vault', { payload: { code: '12345' } })
    expect(response.statusCode).toBe(400)
  })

  it('keeps each account to its own vault', async () => {
    const bob = await signIn('bob')
    const theirs = await asBrowser(bob, 'GET', '/api/vault')
    expect(theirs.json()).toMatchObject({ exists: false })
    const mine = await asBrowser(alice, 'GET', '/api/vault')
    expect(mine.json()).toMatchObject({ exists: true, open: true })
  })

  it('is for a full session only', async () => {
    const limited = await signIn('limited')
    const response = await asBrowser(limited, 'GET', '/api/vault')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'password_change_required' } })
  })

  it('needs a session', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/vault' })
    expect(get.statusCode).toBe(401)
    const post = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { origin },
      payload: { code: '123456' },
    })
    expect(post.statusCode).toBe(401)
  })
})
