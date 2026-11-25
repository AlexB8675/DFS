import { appTokens, auditLog, nodes, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import type { MadeAppToken } from '@dfs/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { type ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { useAppJsonParser } from './routes.ts'
import { RateLimiter } from '../auth/rate-limit.ts'
import { sessionCookieName } from '../auth/sessions.ts'
import { newAppToken } from '../app-tokens/tokens.ts'
import { newDeviceToken } from '../devices/devices.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Signing in to /api/v1 with an app token, its limits, CORS and the folder
// check (DESIGN.md §7.8), against a real database.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let origin: string
let baseUrl: string

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  origin = setup.config.publicBaseUrl
  app = await buildApp({ config: setup.config, logger: false })
  await seedUser(app.db, { username: 'alice', password: 'the-alice-password' })
  // Throwaway v1 routes under the plugin's parser, for what no real route has yet.
  await app.register(
    (scope, _options, done) => {
      useAppJsonParser(scope)
      const routes = scope.withTypeProvider<ZodTypeProvider>()
      routes.get(
        '/v1/probe',
        {
          config: { access: 'app' },
          schema: { querystring: z.object({ n: z.coerce.number().int() }) },
        },
        () => ({ ok: true }),
      )
      const echo = (request: { body: unknown }) => ({ body: request.body ?? null })
      scope.delete('/v1/probe', { config: { access: 'app' } }, echo)
      scope.post('/v1/probe', { config: { access: 'app' } }, echo)
      done()
    },
    { prefix: '/api' },
  )
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

async function rootOf(): Promise<string> {
  const [user] = await app.db.select().from(users).where(eq(users.username, 'alice'))
  if (!user?.rootNodeId) throw new Error('no root')
  return user.rootNodeId
}

async function aliceId(): Promise<string> {
  const [user] = await app.db.select().from(users).where(eq(users.username, 'alice'))
  if (!user) throw new Error('no user')
  return user.id
}

async function folderIn(
  parentId: string | null,
  name: string,
  tree: 'drive' | 'backups' = 'drive',
) {
  const [row] = await app.db
    .insert(nodes)
    .values({
      ownerId: await aliceId(),
      parentId,
      kind: 'folder',
      name,
      nameKey: name.toLowerCase(),
      tree,
    })
    .returning()
  if (!row) throw new Error('no folder')
  return row
}

async function signInCookie(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username: 'alice', password: 'the-alice-password' },
  })
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies.find((c) => c.name === sessionCookieName(app.config))
  return `${sessionCookieName(app.config)}=${cookie?.value ?? ''}`
}

/** Makes a token through the API, as the Settings page does. */
async function makeToken(folderId: string, canWrite = false): Promise<MadeAppToken> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username: 'alice', password: 'the-alice-password' },
  })
  const cookie = login.cookies.find((c) => c.name === sessionCookieName(app.config))
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken
  const response = await app.inject({
    method: 'POST',
    url: '/api/app-tokens',
    headers: {
      cookie: `${sessionCookieName(app.config)}=${cookie?.value ?? ''}`,
      'x-csrf-token': csrfToken,
    },
    payload: { name: 'Notes agent', folderId, canWrite },
  })
  expect(response.statusCode).toBe(201)
  return response.json<MadeAppToken>()
}

let nextAddress = 1
/** A fresh client address per test, so the failure counts never mix. */
function address(): string {
  nextAddress += 1
  return `10.9.${String(Math.floor(nextAddress / 250))}.${String(nextAddress % 250)}`
}

function get(url: string, token: string | null, remoteAddress = address()) {
  return app.inject({
    method: 'GET',
    url,
    remoteAddress,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const CORS_ORIGIN = '*'
const EXPOSED = 'Content-Range, Content-Length, Accept-Ranges, ETag, Retry-After'

function expectCors(headers: Record<string, unknown>) {
  expect(headers['access-control-allow-origin']).toBe(CORS_ORIGIN)
  expect(headers['access-control-expose-headers']).toBe(EXPOSED)
  expect(headers['access-control-allow-credentials']).toBeUndefined()
}

describe('GET /api/v1/me', () => {
  it('answers what the token is', async () => {
    const notes = await folderIn(await rootOf(), 'Notes')
    const { token } = await makeToken(notes.id)

    const response = await get('/api/v1/me', token)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      token: {
        name: 'Notes agent',
        folder: { name: 'Notes', path: 'My Drive / Notes' },
        canWrite: false,
      },
      user: { displayName: 'alice' },
    })
  })

  it('is never opened by a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: await signInCookie() },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  })

  it('is never opened by a device token, which counts but is not audited', async () => {
    const before = await app.db.select().from(auditLog)
    const response = await get('/api/v1/me', newDeviceToken())
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
    expect(await app.db.select().from(auditLog)).toHaveLength(before.length)

    const from = address()
    for (let i = 0; i < 30; i += 1) {
      expect((await get('/api/v1/me', newDeviceToken(), from)).statusCode).toBe(401)
    }
    expect((await get('/api/v1/me', newDeviceToken(), from)).statusCode).toBe(429)
  })

  it('refuses a well-formed wrong token and audits it with the address', async () => {
    const from = address()
    const response = await get('/api/v1/me', newAppToken(), from)
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_token' } })
    const entries = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.app_token_failed'))
    expect(entries.map((entry) => entry.meta)).toContainEqual({
      target: 'an app token',
      details: from,
    })
  })

  it('costs nothing without a header', async () => {
    const from = address()
    for (let i = 0; i < 35; i += 1) {
      const response = await get('/api/v1/me', null, from)
      expect(response.statusCode).toBe(401)
    }
  })

  it('stops an address after 30 failures', async () => {
    const from = address()
    for (let i = 0; i < 30; i += 1) {
      expect((await get('/api/v1/me', newAppToken(), from)).statusCode).toBe(401)
    }
    const response = await get('/api/v1/me', newAppToken(), from)
    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({ error: { code: 'rate_limited' } })
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('counts two IPv6 addresses of one /64 together', async () => {
    const one = '2001:db8:1:2:aaaa::1'
    const two = '2001:db8:1:2:bbbb::2'
    for (let i = 0; i < 30; i += 1) {
      const from = i % 2 === 0 ? one : two
      expect((await get('/api/v1/me', newAppToken(), from)).statusCode).toBe(401)
    }
    expect((await get('/api/v1/me', newAppToken(), one)).statusCode).toBe(429)
    expect((await get('/api/v1/me', newAppToken(), two)).statusCode).toBe(429)
  })

  it('limits requests per token', async () => {
    const root = await rootOf()
    const { token } = await makeToken(root)
    const real = app.limits.appRequests
    app.limits.appRequests = new RateLimiter(3, 60_000)
    try {
      for (let i = 0; i < 3; i += 1) expect((await get('/api/v1/me', token)).statusCode).toBe(200)
      const response = await get('/api/v1/me', token)
      expect(response.statusCode).toBe(429)
      expect(response.json()).toMatchObject({ error: { code: 'rate_limited' } })
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    } finally {
      app.limits.appRequests = real
    }
  })

  it('limits searches to 60 a minute per token, and lists still work', async () => {
    const root = await rootOf()
    const { token } = await makeToken(root)
    const real = app.limits.appSearches
    app.limits.appSearches = new RateLimiter(60, 60_000)
    try {
      for (let i = 0; i < 60; i += 1) {
        expect((await get('/api/v1/search?q=a', token)).statusCode).toBe(200)
      }
      const response = await get('/api/v1/search?q=a', token)
      expect(response.statusCode).toBe(429)
      expect(response.json()).toMatchObject({ error: { code: 'rate_limited' } })
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
      expect((await get('/api/v1/list', token)).statusCode).toBe(200)
    } finally {
      app.limits.appSearches = real
    }
  })

  it('notes a use of the token', async () => {
    const root = await rootOf()
    const { token, appToken } = await makeToken(root)
    await get('/api/v1/me', token, '203.0.113.9')
    const [row] = await app.db.select().from(appTokens).where(eq(appTokens.id, appToken.id))
    expect(row?.lastUsedAt).not.toBeNull()
    expect(row?.lastAddress).toBe('203.0.113.9')
  })
})

describe('the token’s folder', () => {
  it('is checked on every request', async () => {
    const root = await rootOf()
    const notes = await folderIn(root, 'Checked')
    const { token } = await makeToken(notes.id)
    expect((await get('/api/v1/me', token)).statusCode).toBe(200)

    await app.db.update(nodes).set({ deletedAt: new Date() }).where(eq(nodes.id, notes.id))
    const trashed = await get('/api/v1/me', token)
    expect(trashed.statusCode).toBe(409)
    const trashedError = trashed.json<{ error: { code: string; message: string } }>().error
    expect(trashedError.code).toBe('folder_unavailable')
    expect(trashedError.message).toContain('in the trash')

    await app.db.update(nodes).set({ deletedAt: null }).where(eq(nodes.id, notes.id))
    expect((await get('/api/v1/me', token)).statusCode).toBe(200)

    const backups = await folderIn(null, 'Backups', 'backups')
    await app.db
      .update(nodes)
      .set({ parentId: backups.id, tree: 'backups' })
      .where(eq(nodes.id, notes.id))
    const moved = await get('/api/v1/me', token)
    expect(moved.statusCode).toBe(409)
    const movedError = moved.json<{ error: { code: string; message: string } }>().error
    expect(movedError.code).toBe('folder_unavailable')
    expect(movedError.message).toContain('no longer in My drive')
  })
})

describe('a token whose folder is inside a trashed folder', () => {
  it('answers 409 folder_unavailable while the web app has the parent in the trash, and works after a restore', async () => {
    const root = await rootOf()
    const parent = await folderIn(root, 'Outer')
    const inner = await folderIn(parent.id, 'Inner')
    const { token } = await makeToken(inner.id)
    expect((await get('/api/v1/me', token)).statusCode).toBe(200)

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username: 'alice', password: 'the-alice-password' },
    })
    const session = login.cookies.find((c) => c.name === sessionCookieName(app.config))
    const web = {
      cookie: `${sessionCookieName(app.config)}=${session?.value ?? ''}`,
      'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken,
    }
    const trashed = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${parent.id}`,
      headers: web,
    })
    expect(trashed.statusCode).toBe(204)
    // The web app trashes the folder and marks what is below it `trashed_via`.
    const [row] = await app.db.select().from(nodes).where(eq(nodes.id, inner.id))
    expect(row?.deletedAt).toBeNull()
    expect(row?.trashedVia).not.toBeNull()
    const answer = await get('/api/v1/me', token)
    expect(answer.statusCode).toBe(409)
    expect(answer.json()).toMatchObject({ error: { code: 'folder_unavailable' } })

    const restored = await app.inject({
      method: 'POST',
      url: `/api/nodes/${parent.id}/restore`,
      headers: web,
    })
    expect(restored.statusCode).toBe(200)
    expect((await get('/api/v1/me', token)).statusCode).toBe(200)
  })
})

describe('CORS', () => {
  it('answers a preflight before authentication', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/list/a',
      headers: { origin: 'https://agent.example', 'access-control-request-method': 'PUT' },
    })
    expect(response.statusCode).toBe(204)
    expectCors(response.headers)
    expect(response.headers['access-control-allow-methods']).toBe('GET, PUT, POST, DELETE')
    expect(response.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type, Range, If-Range, If-None-Match, If-Match',
    )
    expect(response.headers['access-control-max-age']).toBe('600')
  })

  it('marks every kind of answer', async () => {
    const root = await rootOf()
    const { token } = await makeToken(root)
    expectCors((await get('/api/v1/me', token)).headers)
    expectCors((await get('/api/v1/me', null)).headers)
    expectCors((await get('/api/v1/nope', token)).headers)
    const nope = await get('/api/v1/nope', token)
    expect(nope.statusCode).toBe(404)

    const failing = address()
    for (let i = 0; i < 30; i += 1) await get('/api/v1/me', newAppToken(), failing)
    const limited = await get('/api/v1/me', newAppToken(), failing)
    expect(limited.statusCode).toBe(429)
    expectCors(limited.headers)

    const real = app.limits.appRequests
    app.limits.appRequests = new RateLimiter(1, 60_000)
    try {
      await get('/api/v1/me', token)
      const second = await get('/api/v1/me', token)
      expect(second.statusCode).toBe(429)
      expectCors(second.headers)
    } finally {
      app.limits.appRequests = real
    }
  })

  it('answers a path with a bad percent-encoding in the API’s shape', async () => {
    const v1 = await fetch(`${baseUrl}/api/v1/stat/%E0%A4%A`)
    expect(v1.status).toBe(400)
    expect(await v1.json()).toMatchObject({ error: { code: 'invalid_path' } })
    expect(v1.headers.get('access-control-allow-origin')).toBe(CORS_ORIGIN)
    expect(v1.headers.get('access-control-expose-headers')).toBe(EXPOSED)

    const other = await fetch(`${baseUrl}/api/nodes/%E0%A4%A`)
    expect(other.status).toBe(400)
    expect(await other.json()).toMatchObject({ error: { code: 'invalid_request' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('stays off every other route', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' })
    const content = await app.inject({
      method: 'GET',
      url: '/api/files/00000000-0000-4000-8000-000000000000/content',
    })
    for (const response of [health, content]) {
      const names = Object.keys(response.headers).filter((name) =>
        name.startsWith('access-control-'),
      )
      expect(names).toEqual([])
    }
  })
})

describe('the v1 plugin’s scope', () => {
  async function send(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    token: string,
    body?: string,
  ) {
    return app.inject({
      method,
      url,
      remoteAddress: address(),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: body }),
    })
  }

  it('reaches a route through a percent-encoded prefix, with CORS', async () => {
    const { token } = await makeToken(await rootOf())
    const response = await get('/api/%76%31/me', token)
    expect(response.statusCode).toBe(200)
    expectCors(response.headers)
  })

  it('marks a Zod 400 with CORS, in the API’s shape', async () => {
    const { token } = await makeToken(await rootOf())
    const response = await send('GET', '/api/v1/probe?n=x', token)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } })
    expectCors(response.headers)
  })

  it('takes an empty or blank JSON body as none', async () => {
    const { token } = await makeToken(await rootOf())
    for (const body of [undefined, '', '  \n']) {
      const response = await send('DELETE', '/api/v1/probe', token, body)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ body: null })
    }
  })

  it('refuses invalid JSON and a poisoned prototype, with CORS', async () => {
    const { token } = await makeToken(await rootOf())
    for (const body of ['{', '{"__proto__": {"admin": true}}']) {
      const response = await send('POST', '/api/v1/probe', token, body)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } })
      expectCors(response.headers)
    }
  })
})

describe('what a token opens', () => {
  it('is only /api/v1', async () => {
    const root = await rootOf()
    const { token } = await makeToken(root)
    const response = await get(`/api/nodes/${root}/children`, token)
    expect(response.statusCode).toBe(401)
  })
})
