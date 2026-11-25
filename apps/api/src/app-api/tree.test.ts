import { fileVersions, nodes, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import type { AppItem, MadeAppToken } from '@dfs/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { sessionCookieName } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// The v1 write routes (DESIGN.md §7.8): folders, move and trash, against a
// real database.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let origin: string
let userId: string
let rootId: string
let cookie: string
let csrf: string

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  origin = setup.config.publicBaseUrl
  app = await buildApp({ config: setup.config, logger: false })
  await seedUser(app.db, { username: 'alice', password: 'the-alice-password' })
  const [user] = await app.db.select().from(users).where(eq(users.username, 'alice'))
  if (!user?.rootNodeId) throw new Error('no user')
  userId = user.id
  rootId = user.rootNodeId
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username: 'alice', password: 'the-alice-password' },
  })
  const session = login.cookies.find((c) => c.name === sessionCookieName(app.config))
  cookie = `${sessionCookieName(app.config)}=${session?.value ?? ''}`
  csrf = login.json<{ csrfToken: string }>().csrfToken
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

async function folder(parentId: string, name: string) {
  const [row] = await app.db
    .insert(nodes)
    .values({ ownerId: userId, parentId, kind: 'folder', name, nameKey: name.toLowerCase() })
    .returning()
  if (!row) throw new Error('no folder')
  return row
}

async function file(parentId: string, name: string, complete = true) {
  const [row] = await app.db
    .insert(nodes)
    .values({
      ownerId: userId,
      parentId,
      kind: 'file',
      name,
      nameKey: name.toLowerCase(),
      mimeType: 'text/plain',
      sizeBytes: 5,
    })
    .returning()
  if (!row) throw new Error('no file')
  if (complete) {
    const [version] = await app.db
      .insert(fileVersions)
      .values({
        nodeId: row.id,
        versionNo: 1,
        state: 'stored',
        sizeBytes: 5,
        chunkSize: 5,
        chunkCount: 1,
        wrappedDek: Buffer.from('k'),
        keyId: 'k',
      })
      .returning()
    if (!version) throw new Error('no version')
    await app.db.update(nodes).set({ currentVersionId: version.id }).where(eq(nodes.id, row.id))
  }
  return row
}

let counter = 0
/** A fresh token folder and a token for it, so each test starts from nothing. */
async function setup(canWrite = true) {
  counter += 1
  const home = await folder(rootId, `Home ${String(counter)}`)
  const response = await app.inject({
    method: 'POST',
    url: '/api/app-tokens',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { name: 'Agent', folderId: home.id, canWrite },
  })
  expect(response.statusCode).toBe(201)
  return { home, token: response.json<MadeAppToken>().token }
}

let nextAddress = 1
function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  nextAddress += 1
  return app.inject({
    method,
    url,
    remoteAddress: `10.8.${String(Math.floor(nextAddress / 250))}.${String(nextAddress % 250)}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
}

const move = (token: string, from: string, to: string) =>
  call('POST', '/api/v1/move', token, { from, to })

async function live(parentId: string, name: string) {
  const [row] = await app.db
    .select()
    // tree: by parent
    .from(nodes)
    .where(and(eq(nodes.parentId, parentId), eq(nodes.name, name), isNull(nodes.deletedAt)))
  return row
}

describe('POST /api/v1/folders', () => {
  it('makes a deep folder, then answers 200 for it again', async () => {
    const { token } = await setup()
    const made = await call('POST', '/api/v1/folders/a/b/c', token)
    expect(made.statusCode).toBe(201)
    expect(made.json<AppItem>()).toMatchObject({ name: 'c', path: 'a/b/c', kind: 'folder' })
    const again = await call('POST', '/api/v1/folders/a/b/c', token)
    expect(again.statusCode).toBe(200)
    expect(again.json<AppItem>().id).toBe(made.json<AppItem>().id)
  })

  it('answers the token’s folder for the bare route', async () => {
    const { token, home } = await setup()
    for (const url of ['/api/v1/folders', '/api/v1/folders/']) {
      const response = await call('POST', url, token)
      expect(response.statusCode).toBe(200)
      expect(response.json<AppItem>()).toMatchObject({ id: home.id, path: '' })
    }
  })

  it('refuses a file in the way with 409 not_a_folder', async () => {
    const { token, home } = await setup()
    const a = await folder(home.id, 'a')
    await file(a.id, 'b')
    const response = await call('POST', '/api/v1/folders/a/b/c', token)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'not_a_folder' } })
  })

  it('refuses a file still uploading at the final name with 409 not_a_folder, not a 500', async () => {
    const { token, home } = await setup()
    await file(home.id, 'x', false)
    const response = await call('POST', '/api/v1/folders/x', token)
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'not_a_folder' } })
  })

  it('answers 201 for a folder with no body, though Content-Type says JSON', async () => {
    const { token } = await setup()
    const response = await call('POST', '/api/v1/folders/z', token, undefined, {
      'content-type': 'application/json',
    })
    expect(response.statusCode).toBe(201)
  })

  it('refuses a bad name with 400 invalid_path', async () => {
    const { token } = await setup()
    const response = await call('POST', '/api/v1/folders/a/b%2Fc', token)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_path' } })
  })
})

describe('POST /api/v1/move', () => {
  it('moves a file, and the old path is gone', async () => {
    const { token, home } = await setup()
    await folder(home.id, 'Sub')
    await file(home.id, 'a.txt')
    const response = await move(token, 'a.txt', 'Sub/b.txt')
    expect(response.statusCode).toBe(200)
    expect(response.json<AppItem>()).toMatchObject({
      name: 'b.txt',
      path: 'Sub/b.txt',
      kind: 'file',
    })
    expect(await live(home.id, 'a.txt')).toBeUndefined()
  })

  it('makes the parents of `to` that are missing', async () => {
    const { token, home } = await setup()
    await file(home.id, 'a.txt')
    const response = await move(token, 'a.txt', '/x/y/a.txt')
    expect(response.statusCode).toBe(200)
    expect(response.json<AppItem>().path).toBe('x/y/a.txt')
  })

  it('renames by case', async () => {
    const { token, home } = await setup()
    await file(home.id, 'a.txt')
    const response = await move(token, 'a.txt', 'A.txt')
    expect(response.statusCode).toBe(200)
    expect(response.json<AppItem>()).toMatchObject({ name: 'A.txt', path: 'A.txt' })
  })

  it('refuses another item at `to` with 409 exists, and changes nothing', async () => {
    const { token, home } = await setup()
    const a = await file(home.id, 'a.txt')
    await file(home.id, 'b.txt')
    const response = await move(token, 'a.txt', 'B.TXT')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'exists' } })
    expect((await live(home.id, 'a.txt'))?.id).toBe(a.id)
  })

  it('refuses a file still uploading at `to` with 409 exists', async () => {
    const { token, home } = await setup()
    await file(home.id, 'a.txt')
    await file(home.id, 'b.txt', false)
    const response = await move(token, 'a.txt', 'b.txt')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'exists' } })
  })

  it('refuses a folder into itself with 400 invalid_move, making nothing', async () => {
    const { token, home } = await setup()
    const sub = await folder(home.id, 'Sub')
    const response = await move(token, 'Sub', 'Sub/In/Sub')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_move' } })
    expect(await live(sub.id, 'In')).toBeUndefined()
  })

  it('refuses the token’s folder as `from`', async () => {
    const { token } = await setup()
    for (const from of ['', '/']) {
      const response = await move(token, from, 'x')
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'token_folder' } })
    }
  })

  it('needs a name in `to`', async () => {
    const { token, home } = await setup()
    await file(home.id, 'a.txt')
    for (const to of ['', '/']) {
      const response = await move(token, 'a.txt', to)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'invalid_path' } })
      expect(response.json<{ error: { message: string } }>().error.message).toMatch(/to/)
    }
  })

  it('answers 200 with the item unchanged when `from` is `to`', async () => {
    const { token, home } = await setup()
    const a = await file(home.id, 'a.txt')
    const response = await move(token, 'a.txt', 'a.txt')
    expect(response.statusCode).toBe(200)
    expect(response.json<AppItem>()).toMatchObject({ id: a.id, path: 'a.txt' })
  })

  it('answers 404 for a `from` that is not there', async () => {
    const { token } = await setup()
    expect((await move(token, 'nope', 'x')).statusCode).toBe(404)
  })

  it('refuses a file in the way of `to`’s parents with 409 not_a_folder', async () => {
    const { token, home } = await setup()
    await file(home.id, 'a.txt')
    await file(home.id, 'f')
    const response = await move(token, 'a.txt', 'f/a.txt')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'not_a_folder' } })
  })

  it('answers 400 invalid_request with no body', async () => {
    const { token } = await setup()
    const response = await call('POST', '/api/v1/move', token, undefined, {
      'content-type': 'application/json',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })

  it('answers 409 exists, never name_conflict, when a web rename takes the name in between', async () => {
    const { token, home } = await setup()
    await file(home.id, 'a.txt')
    // An insert that has not committed: the move's check does not see it, and
    // its update waits on the unique index until the insert commits.
    const taken = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const holding = app.db.transaction(async (tx) => {
      await tx
        // tree: inherits
        .insert(nodes)
        .values({
          ownerId: userId,
          parentId: home.id,
          kind: 'file',
          name: 'b.txt',
          nameKey: 'b.txt',
        })
      taken.resolve(undefined)
      await release.promise
    })
    await taken.promise
    const moving = move(token, 'a.txt', 'b.txt')
    await new Promise((resolve) => setTimeout(resolve, 400))
    release.resolve(undefined)
    await holding
    const response = await moving
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'exists' } })
  })

  it('finishes as one serial order against the web app’s move of the same folder', async () => {
    const { token, home } = await setup()
    const x = await folder(home.id, 'X')
    const child = await file(x.id, 'c.txt')
    const elsewhere = await folder(rootId, `Elsewhere ${String(counter)}`)
    const [v1, web] = await Promise.all([
      move(token, 'X', 'Y/X'),
      app.inject({
        method: 'POST',
        url: '/api/nodes/move',
        headers: { cookie, 'x-csrf-token': csrf, origin },
        payload: { ids: [x.id], parentId: elsewhere.id },
      }),
    ])
    expect(web.statusCode).toBe(204)
    // Either the v1 move ran first, and then the web's took X out; or it ran
    // second, and found nothing in the token's reach.
    expect([200, 404]).toContain(v1.statusCode)
    const [moved] = await app.db.select().from(nodes).where(eq(nodes.id, x.id))
    expect(moved?.parentId).toBe(elsewhere.id)
    const [kept] = await app.db.select().from(nodes).where(eq(nodes.id, child.id))
    expect(kept?.parentId).toBe(x.id)
    expect(Boolean(await live(home.id, 'Y'))).toBe(v1.statusCode === 200)
  })
})

describe('DELETE /api/v1/files', () => {
  it('trashes a file, with a JSON content type and no body', async () => {
    const { token, home } = await setup()
    await file(home.id, 'a.txt')
    const response = await call('DELETE', '/api/v1/files/a.txt', token, undefined, {
      'content-type': 'application/json',
    })
    expect(response.statusCode).toBe(204)
    expect(await live(home.id, 'a.txt')).toBeUndefined()
  })

  it('trashes a folder with its contents', async () => {
    const { token, home } = await setup()
    const sub = await folder(home.id, 'Sub')
    const inner = await file(sub.id, 'in.txt')
    const response = await call('DELETE', '/api/v1/files/Sub', token)
    expect(response.statusCode).toBe(204)
    const [folderRow] = await app.db.select().from(nodes).where(eq(nodes.id, sub.id))
    expect(folderRow?.deletedAt).not.toBeNull()
    const [innerRow] = await app.db.select().from(nodes).where(eq(nodes.id, inner.id))
    expect(innerRow?.trashedVia).toBe(sub.id)
  })

  it('refuses the token’s folder with 400 token_folder', async () => {
    const { token, home } = await setup()
    for (const url of ['/api/v1/files', '/api/v1/files/']) {
      const response = await call('DELETE', url, token)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'token_folder' } })
    }
    expect((await live(rootId, home.name))?.id).toBe(home.id)
  })

  it('answers 404 for nothing, and for a file still uploading', async () => {
    const { token, home } = await setup()
    await file(home.id, 'u.txt', false)
    expect((await call('DELETE', '/api/v1/files/nope', token)).statusCode).toBe(404)
    expect((await call('DELETE', '/api/v1/files/u.txt', token)).statusCode).toBe(404)
  })
})

describe('a read-only token', () => {
  it('is refused on each write route, changing nothing', async () => {
    const { token, home } = await setup(false)
    await file(home.id, 'a.txt')
    const answers = [
      await call('POST', '/api/v1/folders/new', token),
      await call('POST', '/api/v1/folders', token),
      await move(token, 'a.txt', 'b.txt'),
      await call('POST', '/api/v1/move', token, {}),
      await call('DELETE', '/api/v1/files/a.txt', token),
    ]
    for (const response of answers) {
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'read_only' } })
    }
    expect(await live(home.id, 'a.txt')).toBeDefined()
    expect(await live(home.id, 'b.txt')).toBeUndefined()
    expect(await live(home.id, 'new')).toBeUndefined()
  })
})
