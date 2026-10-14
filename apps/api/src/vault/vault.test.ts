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
import { findSession, sessionCookieName } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { slideBelowSeconds, vaultKeyOf } from './vault.ts'

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
    'limited',
  ]) {
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
  /** What the sign-in's answer said about a pending reset (§7.7). */
  vaultResetAt: string | null
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
  const body = response.json<{
    csrfToken: string
    user: { id: string }
    vaultResetAt: string | null
  }>()
  return {
    userId: body.user.id,
    token: cookie?.value ?? '',
    cookie: `${sessionCookieName(app.config)}=${cookie?.value ?? ''}`,
    csrfToken: body.csrfToken,
    vaultResetAt: body.vaultResetAt,
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

// Alice's browser, whose vault the first tests make and the later ones open and lock.
let alice: Browser

describe('making the vault (§7.7)', { timeout: 30_000 }, () => {
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

/** Makes the browser's vault, open in its session, and gives back the recovery key. */
async function makeVault(browser: Browser, code = '123456'): Promise<string> {
  const response = await asBrowser(browser, 'POST', '/api/vault', { payload: { code } })
  expect(response.statusCode).toBe(201)
  return response.json<{ recoveryKey: string }>().recoveryKey
}

function unlock(browser: Browser, code: string) {
  return asBrowser(browser, 'POST', '/api/vault/unlock', { payload: { code } })
}

interface VaultBody {
  exists: boolean
  open: boolean
  locksAt: string | null
  resetAt: string | null
}

async function vaultOf(browser: Browser): Promise<VaultBody> {
  const response = await asBrowser(browser, 'GET', '/api/vault')
  expect(response.statusCode).toBe(200)
  return response.json<VaultBody>()
}

async function sessionOf(browser: Browser) {
  const [session] = await app.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, createHash('sha256').update(browser.token).digest('hex')))
  return session
}

async function userOf(userId: string) {
  const [user] = await app.db.select().from(users).where(eq(users.id, userId))
  if (!user) throw new Error('No such user.')
  return user
}

async function auditRows(userId: string, action: string) {
  return app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)))
}

const MINUTE = 60_000

describe('opening and locking the vault (§7.7)', { timeout: 60_000 }, () => {
  it('locks the vault in this browser and opens it again with the code', async () => {
    const lock = await asBrowser(alice, 'POST', '/api/vault/lock')
    expect(lock.statusCode).toBe(204)
    expect(await vaultOf(alice)).toMatchObject({ exists: true, open: false, locksAt: null })
    const locked = await sessionOf(alice)
    expect(locked?.vaultKeySealed).toBeNull()
    expect(locked?.vaultLocksAt).toBeNull()

    const response = await unlock(alice, '123456')
    expect(response.statusCode).toBe(200)
    const body = response.json<VaultBody>()
    expect(body.open).toBe(true)
    const locksInMs = new Date(body.locksAt ?? 0).getTime() - Date.now()
    expect(locksInMs).toBeGreaterThan(14 * MINUTE)
    expect(locksInMs).toBeLessThan(16 * MINUTE)
    expect(await auditRows(alice.userId, 'vault.unlocked')).toHaveLength(1)
    expect((await sessionOf(alice))?.vaultKeySealed).not.toBeNull()
  })

  it('refuses a wrong code, counts it, and forgets the count at the right one', async () => {
    const wrong = await unlock(alice, '654321')
    expect(wrong.statusCode).toBe(403)
    expect(wrong.json()).toMatchObject({ error: { code: 'wrong_code' } })
    expect(await auditRows(alice.userId, 'vault.unlock_failed')).toHaveLength(1)
    expect((await userOf(alice.userId)).failedVaultUnlocks).toBe(1)

    const right = await unlock(alice, '123456')
    expect(right.statusCode).toBe(200)
    expect((await userOf(alice.userId)).failedVaultUnlocks).toBe(0)
    for (const row of await app.db.select().from(auditLog)) {
      expect(JSON.stringify(row.meta)).not.toContain('654321')
    }
  })

  it('says there is no vault to open when none was made', async () => {
    const bob = await signIn('bob')
    const response = await unlock(bob, '123456')
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'no_vault' } })
  })

  it('makes a wait after ten wrong codes in a row, even for the right one', async () => {
    const carol = await signIn('carol')
    await makeVault(carol)
    for (let i = 0; i < 10; i += 1) {
      const wrong = await unlock(carol, '000000')
      expect(wrong.statusCode).toBe(403)
    }
    const eleventh = await unlock(carol, '000000')
    expect(eleventh.statusCode).toBe(429)
    expect(eleventh.json()).toMatchObject({ error: { code: 'rate_limited' } })
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThanOrEqual(59)

    expect((await unlock(carol, '123456')).statusCode).toBe(429)

    await app.db
      .update(users)
      .set({ vaultUnlockLockedUntil: new Date(Date.now() - MINUTE) })
      .where(eq(users.id, carol.userId))
    expect((await unlock(carol, '123456')).statusCode).toBe(200)
    expect((await userOf(carol.userId)).failedVaultUnlocks).toBe(0)
  })

  it('counts wrong codes sent at once before checking them', async () => {
    const dave = await signIn('dave')
    await makeVault(dave)
    const responses = await Promise.all(Array.from({ length: 15 }, () => unlock(dave, '000000')))
    const statuses = responses.map((response) => response.statusCode)
    expect(statuses.filter((status) => status !== 429).length).toBeLessThanOrEqual(10)
    expect(statuses).toContain(429)
  })

  describe('in more than one browser', () => {
    let a: Browser
    let b: Browser

    it('is open in the browser that opened it and no other', async () => {
      a = await signIn('erin')
      await makeVault(a)
      b = await signIn('erin')
      expect((await vaultOf(b)).open).toBe(false)
      expect((await unlock(b, '123456')).statusCode).toBe(200)
      expect((await asBrowser(b, 'POST', '/api/vault/lock')).statusCode).toBe(204)
      expect((await vaultOf(a)).open).toBe(true)
      expect((await vaultOf(b)).open).toBe(false)
    })

    it('locks by itself after the idle time', async () => {
      await app.db
        .update(sessions)
        .set({ vaultLocksAt: new Date(Date.now() - MINUTE) })
        .where(eq(sessions.id, (await sessionOf(a))?.id ?? ''))
      expect((await vaultOf(a)).open).toBe(false)

      const auth = await findSession(app.db, a.token)
      if (!auth) throw new Error('The session is gone.')
      await expect(vaultKeyOf(app, auth, a.token)).rejects.toMatchObject({
        status: 403,
        code: 'vault_locked',
      })
      expect((await sessionOf(a))?.vaultKeySealed).toBeNull()
    })

    it('gives the key while open, and slides the lock forward at most once a minute', async () => {
      expect((await unlock(a, '123456')).statusCode).toBe(200)
      const auth = await findSession(app.db, a.token)
      if (!auth) throw new Error('The session is gone.')

      const user = await userOf(a.userId)
      const expected = await unwrapVaultKeyByCode(
        app.keys,
        user.vaultKeyByCode ?? new Uint8Array(),
        '123456',
        user.vaultSalt ?? new Uint8Array(),
        a.userId,
      )
      const key = await vaultKeyOf(app, auth, a.token)
      expect(key).toHaveLength(32)
      expect(key).toEqual(expected)

      const before = (await sessionOf(a))?.vaultLocksAt
      await vaultKeyOf(app, auth, a.token)
      expect((await sessionOf(a))?.vaultLocksAt).toEqual(before)

      await app.db
        .update(sessions)
        .set({ vaultLocksAt: new Date(Date.now() + 5 * MINUTE) })
        .where(eq(sessions.id, auth.sessionId))
      await vaultKeyOf(app, auth, a.token)
      const locksInMs = ((await sessionOf(a))?.vaultLocksAt?.getTime() ?? 0) - Date.now()
      expect(locksInMs).toBeGreaterThan(14 * MINUTE)
      expect(locksInMs).toBeLessThan(16 * MINUTE)
    })
  })

  describe('with a reset asked for', () => {
    let frank: Browser

    it('is cancelled by opening the vault', async () => {
      frank = await signIn('frank')
      await makeVault(frank)
      expect((await asBrowser(frank, 'POST', '/api/vault/lock')).statusCode).toBe(204)
      await app.db
        .update(users)
        .set({ vaultResetAt: new Date(Date.now() + 7 * 24 * 60 * MINUTE) })
        .where(eq(users.id, frank.userId))

      const response = await unlock(frank, '123456')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ open: true, resetAt: null })
      expect(await auditRows(frank.userId, 'vault.reset_cancelled')).toHaveLength(1)
      expect((await userOf(frank.userId)).vaultResetAt).toBeNull()
    })

    it('ends with the session, and the key sealed into it', async () => {
      expect((await sessionOf(frank))?.vaultKeySealed).not.toBeNull()
      const response = await asBrowser(frank, 'POST', '/api/auth/logout')
      expect(response.statusCode).toBe(204)
      expect(await sessionOf(frank)).toBeUndefined()
    })
  })

  it('makes one vault for an account, before stretching a second code', async () => {
    const again = await asBrowser(alice, 'POST', '/api/vault', { payload: { code: '123456' } })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { code: 'vault_exists' } })
  })
})

describe('sliding the idle lock (§7.7)', () => {
  it('slides once less than the idle time minus a minute, or minus half of it, remains', () => {
    expect(slideBelowSeconds(15)).toBe(840)
    expect(slideBelowSeconds(2)).toBe(60)
    expect(slideBelowSeconds(1)).toBe(30)
  })
})

function changeCode(browser: Browser, payload: object) {
  return asBrowser(browser, 'PUT', '/api/vault/code', { payload })
}

describe('changing the code (§7.7)', { timeout: 60_000 }, () => {
  let gina: Browser
  let hana: Browser
  let hanaRecoveryKey = ''

  it('changes it with the current code, keeping the recovery key', async () => {
    gina = await signIn('gina')
    await makeVault(gina)
    const before = await userOf(gina.userId)

    const response = await changeCode(gina, { currentCode: '123456', newCode: 'abcdef' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ exists: true, open: true, resetAt: null })
    expect(await auditRows(gina.userId, 'vault.code_changed')).toHaveLength(1)

    const after = await userOf(gina.userId)
    expect(after.vaultSalt).not.toEqual(before.vaultSalt)
    expect(after.vaultKeyByCode).not.toEqual(before.vaultKeyByCode)
    expect(after.vaultKeyByRecovery).toEqual(before.vaultKeyByRecovery)

    expect((await asBrowser(gina, 'POST', '/api/vault/lock')).statusCode).toBe(204)
    const old = await unlock(gina, '123456')
    expect(old.statusCode).toBe(403)
    expect(old.json()).toMatchObject({ error: { code: 'wrong_code' } })
    expect((await unlock(gina, 'abcdef')).statusCode).toBe(200)
  })

  it('changes it with the recovery key, however it is typed, and the key keeps working', async () => {
    hana = await signIn('hana')
    hanaRecoveryKey = await makeVault(hana)
    expect((await asBrowser(hana, 'POST', '/api/vault/lock')).statusCode).toBe(204)

    const response = await changeCode(hana, {
      recoveryKey: hanaRecoveryKey.toLowerCase().replaceAll('-', ' '),
      newCode: 'zzzzzz',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ open: true })
    expect((await sessionOf(hana))?.vaultKeySealed).not.toBeNull()

    expect((await asBrowser(hana, 'POST', '/api/vault/lock')).statusCode).toBe(204)
    expect((await unlock(hana, 'zzzzzz')).statusCode).toBe(200)
    expect((await unlock(hana, '123456')).statusCode).toBe(403)

    const row = await userOf(hana.userId)
    const byRecovery = await unwrapVaultKeyByRecovery(
      row.vaultKeyByRecovery ?? new Uint8Array(),
      hanaRecoveryKey,
      hana.userId,
    )
    expect(byRecovery).toHaveLength(32)
    const byCode = await unwrapVaultKeyByCode(
      app.keys,
      row.vaultKeyByCode ?? new Uint8Array(),
      'zzzzzz',
      row.vaultSalt ?? new Uint8Array(),
      hana.userId,
    )
    expect(byCode).toEqual(byRecovery)
  })

  it('counts a wrong code or recovery key as a wrong try, and changes nothing', async () => {
    const before = await userOf(gina.userId)

    const wrongCode = await changeCode(gina, { currentCode: 'nope-nope', newCode: '999999' })
    expect(wrongCode.statusCode).toBe(403)
    expect(wrongCode.json()).toMatchObject({ error: { code: 'wrong_code' } })
    expect((await userOf(gina.userId)).failedVaultUnlocks).toBe(1)

    const wrongKey = await changeCode(gina, {
      recoveryKey: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA',
      newCode: '999999',
    })
    expect(wrongKey.statusCode).toBe(403)
    expect(wrongKey.json()).toMatchObject({ error: { code: 'wrong_recovery_key' } })
    expect((await userOf(gina.userId)).failedVaultUnlocks).toBe(2)

    const malformed = await changeCode(gina, { recoveryKey: 'nope', newCode: '999999' })
    expect(malformed.statusCode).toBe(403)
    expect(malformed.json()).toMatchObject({ error: { code: 'wrong_recovery_key' } })

    const after = await userOf(gina.userId)
    expect(after.vaultSalt).toEqual(before.vaultSalt)
    expect(after.vaultKeyByCode).toEqual(before.vaultKeyByCode)
    expect((await unlock(gina, 'abcdef')).statusCode).toBe(200)
    expect((await userOf(gina.userId)).failedVaultUnlocks).toBe(0)
  })

  it('refuses a new code that is too short', async () => {
    const response = await changeCode(gina, { currentCode: 'abcdef', newCode: '12345' })
    expect(response.statusCode).toBe(400)
  })

  it('cancels a pending reset, as opening does', async () => {
    await app.db
      .update(users)
      .set({ vaultResetAt: new Date(Date.now() + 7 * 24 * 60 * MINUTE) })
      .where(eq(users.id, hana.userId))

    const response = await changeCode(hana, { currentCode: 'zzzzzz', newCode: 'yyyyyy' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ open: true, resetAt: null })
    expect((await userOf(hana.userId)).vaultResetAt).toBeNull()
    expect(await auditRows(hana.userId, 'vault.reset_cancelled')).toHaveLength(1)
  })

  it('says there is no vault to change the code of when none was made', async () => {
    const bob = await signIn('bob')
    const response = await changeCode(bob, { currentCode: '123456', newCode: 'abcdef' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'no_vault' } })
  })

  it('audits none of the codes or the recovery key', async () => {
    const secrets = [
      'abcdef',
      'zzzzzz',
      'yyyyyy',
      '999999',
      'nope-nope',
      ...hanaRecoveryKey.split('-'),
    ]
    const rows = await app.db.select().from(auditLog)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const text = JSON.stringify(row.meta)
      for (const secret of secrets) expect(text).not.toContain(secret)
    }
  })
})

function newRecoveryKey(browser: Browser) {
  return asBrowser(browser, 'POST', '/api/vault/recovery-key')
}

function askForReset(browser: Browser, password: string) {
  return asBrowser(browser, 'POST', '/api/vault/reset', { payload: { password } })
}

async function meOf(browser: Browser) {
  const response = await asBrowser(browser, 'GET', '/api/auth/me')
  expect(response.statusCode).toBe(200)
  return response.json<{ vaultResetAt: string | null }>()
}

describe('a new recovery key, and asking for a reset (§7.7)', { timeout: 60_000 }, () => {
  let ivan: Browser
  let judy: Browser
  let oldKey = ''
  let newKey = ''
  let resetAt = ''

  it('needs the vault open to make a new recovery key', async () => {
    ivan = await signIn('ivan')
    oldKey = await makeVault(ivan)
    expect((await asBrowser(ivan, 'POST', '/api/vault/lock')).statusCode).toBe(204)

    const response = await newRecoveryKey(ivan)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'vault_locked' } })
    expect(await auditRows(ivan.userId, 'vault.recovery_key_replaced')).toHaveLength(0)
  })

  it('makes a new recovery key while the vault is open, and the old one stops working', async () => {
    expect((await unlock(ivan, '123456')).statusCode).toBe(200)

    const response = await newRecoveryKey(ivan)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    newKey = response.json<{ recoveryKey: string }>().recoveryKey
    expect(newKey).toMatch(RECOVERY_KEY)
    expect(newKey).not.toBe(oldKey)
    expect(await auditRows(ivan.userId, 'vault.recovery_key_replaced')).toHaveLength(1)

    const row = await userOf(ivan.userId)
    const wrapped = row.vaultKeyByRecovery ?? new Uint8Array()
    expect(await unwrapVaultKeyByRecovery(wrapped, newKey, ivan.userId)).toHaveLength(32)
    expect(await unwrapVaultKeyByRecovery(wrapped, oldKey, ivan.userId)).toBeNull()

    const withOld = await changeCode(ivan, { recoveryKey: oldKey, newCode: '777777' })
    expect(withOld.statusCode).toBe(403)
    expect(withOld.json()).toMatchObject({ error: { code: 'wrong_recovery_key' } })
    const withNew = await changeCode(ivan, { recoveryKey: newKey, newCode: '777777' })
    expect(withNew.statusCode).toBe(200)
  })

  it('refuses a reset with the wrong password, and asks for nothing', async () => {
    judy = await signIn('judy')
    await makeVault(judy)

    const response = await askForReset(judy, 'not-the-password')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'wrong_password' } })
    expect((await userOf(judy.userId)).vaultResetAt).toBeNull()
    expect(await auditRows(judy.userId, 'vault.reset_requested')).toHaveLength(0)
  })

  it('asks for a reset with the password, seven days away, and says so on the session', async () => {
    const response = await askForReset(judy, 'the-judy-password')
    expect(response.statusCode).toBe(200)
    const body = response.json<VaultBody>()
    expect(body).toMatchObject({ exists: true, open: true })
    resetAt = body.resetAt ?? ''
    const inMs = new Date(resetAt).getTime() - Date.now()
    expect(Math.abs(inMs - 7 * 24 * 60 * MINUTE)).toBeLessThan(MINUTE)
    expect(await auditRows(judy.userId, 'vault.reset_requested')).toHaveLength(1)
    expect((await userOf(judy.userId)).vaultResetAt?.toISOString()).toBe(resetAt)
    expect((await meOf(judy)).vaultResetAt).toBe(resetAt)
  })

  it('keeps the first date when asked again', async () => {
    const response = await askForReset(judy, 'the-judy-password')
    expect(response.statusCode).toBe(200)
    expect(response.json<VaultBody>().resetAt).toBe(resetAt)
    expect(await auditRows(judy.userId, 'vault.reset_requested')).toHaveLength(1)
  })

  it('is cancelled by opening the vault again', async () => {
    expect((await asBrowser(judy, 'POST', '/api/vault/lock')).statusCode).toBe(204)
    const response = await unlock(judy, '123456')
    expect(response.statusCode).toBe(200)
    expect(response.json<VaultBody>().resetAt).toBeNull()
    expect((await meOf(judy)).vaultResetAt).toBeNull()
    expect(await auditRows(judy.userId, 'vault.reset_cancelled')).toHaveLength(1)
  })

  it('answers a fresh sign-in with the date of a reset asked for', async () => {
    const asked = await askForReset(judy, 'the-judy-password')
    expect(asked.statusCode).toBe(200)
    const date = asked.json<VaultBody>().resetAt
    expect(date).not.toBeNull()

    const again = await signIn('judy')
    expect(again.vaultResetAt).toBe(date)
  })

  it('has nothing to reset or replace without a vault', async () => {
    const bob = await signIn('bob')
    expect(bob.vaultResetAt).toBeNull()

    const reset = await askForReset(bob, 'the-bob-password')
    expect(reset.statusCode).toBe(404)
    expect(reset.json()).toMatchObject({ error: { code: 'no_vault' } })

    const key = await newRecoveryKey(bob)
    expect(key.statusCode).toBe(403)
    expect(key.json()).toMatchObject({ error: { code: 'vault_locked' } })
  })

  it('audits none of the passwords or recovery keys', async () => {
    const secrets = ['not-the-password', 'the-judy-password', '777777', ...newKey.split('-')]
    const rows = await app.db.select().from(auditLog)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const text = JSON.stringify(row.meta)
      for (const secret of secrets) expect(text).not.toContain(secret)
    }
  })
})
