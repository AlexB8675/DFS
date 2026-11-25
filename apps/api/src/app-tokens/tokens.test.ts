import { createHash } from 'node:crypto'
import { appTokens, auditLog, nodes, sessions, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import type { AdminAppToken, AppToken, MadeAppToken } from '@dfs/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { audit } from '../audit.ts'
import { buildApp } from '../app.ts'
import {
  endUserSessions,
  LAST_SEEN_EVERY_MS,
  sessionCookieName,
  type Auth,
} from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import {
  APP_TOKEN_PATTERN,
  findAppToken,
  makeAppToken,
  newAppToken,
  touchAppToken,
} from './tokens.ts'

// Making, listing and removing app tokens (DESIGN.md §7.8), and ending them
// with the user's sessions, against a real database.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let origin: string

const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hana', 'ivan', 'judy']

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  origin = setup.config.publicBaseUrl
  app = await buildApp({ config: setup.config, logger: false })
  for (const username of USERS) {
    await seedUser(app.db, { username, password: `the-${username}-password` })
  }
  await seedUser(app.db, {
    username: 'root',
    password: 'the-root-password',
    role: 'admin',
    isOwner: true,
  })
  await seedUser(app.db, { username: 'boss', password: 'the-boss-password', role: 'admin' })
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

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

function asBrowser(
  browser: Browser,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: browser.cookie, 'x-csrf-token': browser.csrfToken },
    payload,
  })
}

async function rootOf(userId: string): Promise<string> {
  const [user] = await app.db.select().from(users).where(eq(users.id, userId))
  if (!user?.rootNodeId) throw new Error('no root')
  return user.rootNodeId
}

async function folderIn(
  ownerId: string,
  parentId: string | null,
  name: string,
  extra: Partial<typeof nodes.$inferInsert> = {},
) {
  const [row] = await app.db
    .insert(nodes)
    .values({ ownerId, parentId, kind: 'folder', name, nameKey: name.toLowerCase(), ...extra })
    .returning()
  if (!row) throw new Error('no folder')
  return row
}

async function make(
  browser: Browser,
  folderId: string,
  options: { name?: string; canWrite?: boolean } = {},
) {
  return asBrowser(browser, 'POST', '/api/app-tokens', {
    name: options.name ?? 'An app',
    folderId,
    canWrite: options.canWrite ?? false,
  })
}

async function made(browser: Browser, folderId: string, name = 'An app') {
  const response = await make(browser, folderId, { name })
  expect(response.statusCode).toBe(201)
  return response.json<MadeAppToken>()
}

const hashOf = (token: string) => createHash('sha256').update(token).digest()

describe('app tokens (§7.8)', () => {
  it('makes a token, keeping only its hash, and audits and journals it', async () => {
    const alice = await signIn('alice')
    const notes = await folderIn(alice.userId, await rootOf(alice.userId), 'Notes')

    const response = await make(alice, notes.id, { name: 'Notes agent', canWrite: true })
    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json<MadeAppToken>()
    expect(body.token).toMatch(APP_TOKEN_PATTERN)
    expect(body.appToken).toMatchObject({
      name: 'Notes agent',
      folderId: notes.id,
      folderPath: 'My Drive / Notes',
      folderAvailable: true,
      canWrite: true,
      lastUsedAt: null,
      lastAddress: null,
      lastAgent: null,
    })

    const rows = await app.db.select().from(appTokens).where(eq(appTokens.userId, alice.userId))
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0]?.tokenHash ?? '').equals(hashOf(body.token))).toBe(true)

    const audited = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, alice.userId), eq(auditLog.action, 'app_token.made')))
    expect(audited).toHaveLength(1)
    expect(audited[0]?.meta).toMatchObject({
      target: 'Notes agent',
      details: 'My Drive / Notes, read and write',
    })
    expect(audited[0]?.nodeId).toBe(notes.id)
    const { rows: journaled } = await app.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM journal
      WHERE kind = 'audit.added' AND record::text LIKE '%app_token.made%'`)
    expect(journaled[0]?.n).toBeGreaterThanOrEqual(1)
    // The token itself is never journaled.
    const { rows: leaked } = await app.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM journal WHERE record::text LIKE ${`%${body.token}%`}`)
    expect(leaked[0]?.n).toBe(0)
  })

  it('accepts the root folder', async () => {
    const bob = await signIn('bob')
    const response = await make(bob, await rootOf(bob.userId))
    expect(response.statusCode).toBe(201)
    expect(response.json<MadeAppToken>().appToken.folderPath).toBe('My Drive')
  })

  it('refuses what is not a folder of the user’s own My drive', async () => {
    const carol = await signIn('carol')
    const other = await signIn('dave')
    const root = await rootOf(carol.userId)

    const [file] = await app.db
      .insert(nodes)
      .values({
        ownerId: carol.userId,
        parentId: root,
        kind: 'file',
        name: 'a.txt',
        nameKey: 'a.txt',
      })
      .returning()
    const notAFolder = await make(carol, file?.id ?? '')
    expect(notAFolder.statusCode).toBe(400)
    expect(notAFolder.json()).toMatchObject({ error: { code: 'not_a_folder' } })

    const trashed = await folderIn(carol.userId, root, 'Trashed', { deletedAt: new Date() })
    const foreign = await folderIn(other.userId, await rootOf(other.userId), 'Theirs')
    const backupsRoot = await folderIn(carol.userId, null, 'Backups', { tree: 'backups' })
    const backups = await folderIn(carol.userId, backupsRoot.id, 'Laptop', { tree: 'backups' })
    const vaultRoot = await folderIn(carol.userId, null, 'Vault', { tree: 'vault' })
    const vault = await folderIn(carol.userId, vaultRoot.id, 'Inside', { tree: 'vault' })
    for (const target of [trashed, foreign, backups, vault, backupsRoot, vaultRoot]) {
      const response = await make(carol, target.id)
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
    }
    const missing = await make(carol, '0198a000-0000-7000-8000-000000000000')
    expect(missing.statusCode).toBe(404)
    expect(
      await app.db.select().from(appTokens).where(eq(appTokens.userId, carol.userId)),
    ).toHaveLength(0)
  })

  it('refuses the 51st token', async () => {
    const erin = await signIn('erin')
    const root = await rootOf(erin.userId)
    await app.db.insert(appTokens).values(
      Array.from({ length: 50 }, (_, index) => ({
        userId: erin.userId,
        name: `t${String(index)}`,
        tokenHash: hashOf(`seed-${String(index)}`),
        folderId: root,
        canWrite: false,
      })),
    )
    const response = await make(erin, root)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'too_many_tokens' } })
    expect(
      await app.db.select().from(appTokens).where(eq(appTokens.userId, erin.userId)),
    ).toHaveLength(50)
  })

  it('refuses when the session ended before the token was made', async () => {
    const frank = await signIn('frank')
    const [user] = await app.db.select().from(users).where(eq(users.id, frank.userId))
    if (!user) throw new Error('no user')
    const [session] = await app.db.select().from(sessions).where(eq(sessions.userId, frank.userId))
    if (!session) throw new Error('no session')
    const auth: Auth = {
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      seenAt: null,
      user,
      limited: false,
    }
    await app.db.delete(sessions).where(eq(sessions.id, session.id))
    await expect(
      makeAppToken(app, auth, {
        name: 'Late',
        folderId: await rootOf(frank.userId),
        canWrite: false,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
    expect(
      await app.db.select().from(appTokens).where(eq(appTokens.userId, frank.userId)),
    ).toHaveLength(0)
  })

  it('lists newest first, and says when the folder is unavailable', async () => {
    const gina = await signIn('gina')
    const root = await rootOf(gina.userId)
    const docs = await folderIn(gina.userId, root, 'Docs')
    const first = await made(gina, root, 'First')
    const second = await made(gina, docs.id, 'Second')

    const list = await asBrowser(gina, 'GET', '/api/app-tokens')
    expect(list.statusCode).toBe(200)
    const items = list.json<AppToken[]>()
    expect(items.map((item) => item.id)).toEqual([second.appToken.id, first.appToken.id])
    expect(items.every((item) => item.folderAvailable)).toBe(true)
    expect(items[0]?.folderPath).toBe('My Drive / Docs')
    expect(JSON.stringify(items)).not.toContain(second.token)

    await app.db.update(nodes).set({ deletedAt: new Date() }).where(eq(nodes.id, docs.id))
    const after = await asBrowser(gina, 'GET', '/api/app-tokens')
    const [trashedOne, rootOne] = after.json<AppToken[]>()
    expect(trashedOne).toMatchObject({ id: second.appToken.id, folderAvailable: false })
    expect(rootOne).toMatchObject({ id: first.appToken.id, folderAvailable: true })
  })

  it('removes a token, audits it, and keeps others’ tokens from the wrong user', async () => {
    const hana = await signIn('hana')
    const alice = await signIn('alice')
    const token = await made(hana, await rootOf(hana.userId), 'Removable')

    const foreign = await asBrowser(alice, 'DELETE', `/api/app-tokens/${token.appToken.id}`)
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json()).toMatchObject({ error: { code: 'not_found' } })
    expect(await findAppToken(app.db, token.token)).not.toBeNull()

    const removed = await asBrowser(hana, 'DELETE', `/api/app-tokens/${token.appToken.id}`)
    expect(removed.statusCode).toBe(204)
    expect(
      await app.db.select().from(appTokens).where(eq(appTokens.id, token.appToken.id)),
    ).toHaveLength(0)
    expect(await findAppToken(app.db, token.token)).toBeNull()
    const audited = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, hana.userId), eq(auditLog.action, 'app_token.removed')))
    expect(audited).toHaveLength(1)
    expect(audited[0]?.meta).toMatchObject({ target: 'Removable' })
    expect(audited[0]?.nodeId).toBe(await rootOf(hana.userId))
  })

  it('ends a user’s tokens with their sessions', async () => {
    const root = await signIn('root')

    // A password change.
    const ivan = await signIn('ivan')
    const ivanToken = await made(ivan, await rootOf(ivan.userId))
    const changed = await asBrowser(ivan, 'POST', '/api/auth/password', {
      currentPassword: 'the-ivan-password',
      newPassword: 'a-much-better-password-1',
    })
    expect(changed.statusCode).toBe(200)
    expect(await findAppToken(app.db, ivanToken.token)).toBeNull()

    // An admin's disable.
    const judy = await signIn('judy')
    const judyToken = await made(judy, await rootOf(judy.userId))
    const disabled = await asBrowser(root, 'PATCH', `/api/admin/users/${judy.userId}`, {
      disabled: true,
    })
    expect(disabled.statusCode).toBe(200)
    expect(
      await app.db.select().from(appTokens).where(eq(appTokens.userId, judy.userId)),
    ).toHaveLength(0)
    expect(await findAppToken(app.db, judyToken.token)).toBeNull()

    // Sign out everywhere, by an admin.
    const bob = await signIn('bob')
    const bobToken = await made(bob, await rootOf(bob.userId), 'Bob’s')
    const signedOut = await asBrowser(root, 'POST', `/api/admin/users/${bob.userId}/sign-out`)
    expect(signedOut.statusCode).toBe(200)
    expect(await findAppToken(app.db, bobToken.token)).toBeNull()
  })

  it('finds a token only by its own pattern, and not a device’s or a disabled user’s', async () => {
    const dave = await signIn('dave')
    const token = await made(dave, await rootOf(dave.userId))
    expect(await findAppToken(app.db, token.token)).toMatchObject({
      tokenId: token.appToken.id,
      folderId: await rootOf(dave.userId),
      canWrite: false,
    })
    expect(await findAppToken(app.db, newAppToken())).toBeNull()
    expect(await findAppToken(app.db, 'dfs_app_short')).toBeNull()
    expect(await findAppToken(app.db, `dfs_${'A'.repeat(43)}`)).toBeNull()

    await app.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, dave.userId))
    expect(await findAppToken(app.db, token.token)).toBeNull()
  })

  it('lists every user’s tokens for an admin, and protects the owner’s', async () => {
    const owner = await signIn('root')
    const boss = await signIn('boss')
    const ownerToken = await made(owner, await rootOf(owner.userId), 'Owner’s')
    const bossToken = await made(boss, await rootOf(boss.userId), 'Boss’s')

    const list = await asBrowser(boss, 'GET', '/api/admin/app-tokens')
    expect(list.statusCode).toBe(200)
    const items = list.json<AdminAppToken[]>()
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get(ownerToken.appToken.id)).toMatchObject({
      username: 'root',
      canRemove: false,
    })
    expect(byId.get(bossToken.appToken.id)).toMatchObject({ username: 'boss', canRemove: true })
    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining([ownerToken.appToken.id, bossToken.appToken.id]),
    )

    const one = await asBrowser(boss, 'GET', `/api/admin/app-tokens?userId=${boss.userId}`)
    expect(one.json<AdminAppToken[]>().every((item) => item.userId === boss.userId)).toBe(true)

    const refused = await asBrowser(
      boss,
      'DELETE',
      `/api/admin/app-tokens/${ownerToken.appToken.id}`,
    )
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ error: { code: 'owner_protected' } })

    const ownerList = await asBrowser(owner, 'GET', '/api/admin/app-tokens')
    expect(
      ownerList.json<AdminAppToken[]>().find((item) => item.id === ownerToken.appToken.id),
    ).toMatchObject({ canRemove: true })

    const removed = await asBrowser(
      owner,
      'DELETE',
      `/api/admin/app-tokens/${bossToken.appToken.id}`,
    )
    expect(removed.statusCode).toBe(204)
    const missing = await asBrowser(
      owner,
      'DELETE',
      `/api/admin/app-tokens/${bossToken.appToken.id}`,
    )
    expect(missing.statusCode).toBe(404)
    const audited = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, owner.userId), eq(auditLog.action, 'app_token.removed')))
    expect(audited).toHaveLength(1)
    expect(audited[0]?.meta).toMatchObject({ target: 'Boss’s', details: '@boss' })
    expect(audited[0]?.nodeId).toBe(await rootOf(boss.userId))
  })

  it('notes a use at most once in a while, and cuts the agent', async () => {
    const hana = await signIn('hana')
    const token = await made(hana, await rootOf(hana.userId), 'Touched')
    const auth = await findAppToken(app.db, token.token)
    if (!auth) throw new Error('not found')
    await touchAppToken(app.db, auth, { ip: '203.0.113.5', agent: 'x'.repeat(500) })
    const [row] = await app.db.select().from(appTokens).where(eq(appTokens.id, auth.tokenId))
    expect(row?.lastUsedAt).not.toBeNull()
    expect(row?.lastAddress).toBe('203.0.113.5')
    expect(row?.lastAgent).toBe('x'.repeat(200))
    const listed = (await asBrowser(hana, 'GET', '/api/app-tokens')).json<AppToken[]>()
    expect(listed.find((item) => item.id === auth.tokenId)).toMatchObject({
      lastAddress: '203.0.113.5',
      lastAgent: 'x'.repeat(200),
    })

    // A second use within the interval writes nothing.
    const again = await findAppToken(app.db, token.token)
    if (!again) throw new Error('not found')
    expect(Date.now() - (again.lastUsedAt?.getTime() ?? 0)).toBeLessThan(LAST_SEEN_EVERY_MS)
    await touchAppToken(app.db, again, { ip: '203.0.113.9', agent: 'other' })
    const [after] = await app.db.select().from(appTokens).where(eq(appTokens.id, auth.tokenId))
    expect(after?.lastAddress).toBe('203.0.113.5')
    expect(after?.lastAgent).toBe('x'.repeat(200))
  })

  it('ends a token made by a request that waited on the user’s row for a sign-out', async () => {
    const root = await signIn('root')
    const gina = await signIn('gina')
    const [user] = await app.db.select().from(users).where(eq(users.id, gina.userId))
    const [session] = await app.db.select().from(sessions).where(eq(sessions.userId, gina.userId))
    if (!user || !session) throw new Error('missing')
    const auth: Auth = {
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      seenAt: null,
      user,
      limited: false,
    }
    const folderId = await rootOf(gina.userId)

    // A sign-out that holds the user's row; the token request queues behind it.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked: () => void = () => undefined
    const hasLock = new Promise<void>((resolve) => (locked = resolve))
    const signOut = app.db.transaction(async (tx) => {
      await endUserSessions(tx, gina.userId)
      locked()
      await held
    })
    await hasLock
    const pending = makeAppToken(app, auth, { name: 'Queued', folderId, canWrite: false }).then(
      () => 'made',
      (error: unknown) => (error as { code?: string }).code,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    release()
    await signOut
    expect(await pending).toBe('unauthenticated')

    // And through the admin route: a token made before is gone after.
    const again = await signIn('gina')
    const token = await made(again, folderId, 'Before sign-out')
    const out = await asBrowser(root, 'POST', `/api/admin/users/${gina.userId}/sign-out`)
    expect(out.statusCode).toBe(200)
    expect(await findAppToken(app.db, token.token)).toBeNull()
    expect(
      await app.db.select().from(appTokens).where(eq(appTokens.userId, gina.userId)),
    ).toHaveLength(0)
  })

  it('does not deadlock a removal with the end of a user's sessions', async () => {
    // The removal holds its token's row and then audits (a row that names the
    // user); the end of sessions locks the user's row and then deletes tokens.
    // With FOR UPDATE on the user's row the two wait on each other (40P01).
    await seedUser(app.db, { username: 'kate', password: 'the-kate-password' })
    const kate = await signIn('kate')
    const token = await made(kate, await rootOf(kate.userId), 'Deadlock')
    const release = Promise.withResolvers<undefined>()
    const held = Promise.withResolvers<undefined>()
    const removal = app.db.transaction(async (tx) => {
      await tx.delete(appTokens).where(eq(appTokens.id, token.appToken.id))
      held.resolve(undefined)
      await release.promise
      await audit(tx, { actorId: kate.userId, action: 'app_token.removed', target: 'Deadlock' })
    })
    const settle = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? String(error),
      )
    const removalOutcome = settle(removal)
    await held.promise
    const ending = settle(
      app.db.transaction(async (tx) => {
        await tx.update(users).set({ disabledAt: new Date() }).where(eq(users.id, kate.userId))
        await endUserSessions(tx, kate.userId)
      }),
    )
    // Wait until the ending is stuck on the removal's token row.
    await vi.waitFor(
      async () => {
        const { rows } = await app.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%delete from "app_tokens"%'`)
        expect(rows[0]?.n).toBeGreaterThan(0)
      },
      { timeout: 10_000 },
    )
    release.resolve(undefined)
    expect([await removalOutcome, await ending]).toEqual(['ok', 'ok'])
  })

  it('keeps the admin pages from plain users', async () => {
    const alice = await signIn('alice')
    const list = await asBrowser(alice, 'GET', '/api/admin/app-tokens')
    expect(list.statusCode).toBe(403)
    const removal = await asBrowser(
      alice,
      'DELETE',
      '/api/admin/app-tokens/0198a000-0000-7000-8000-000000000000',
    )
    expect(removal.statusCode).toBe(403)
  })
})
