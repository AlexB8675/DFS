import { ApiClient, createFolder, startUpload, text, uploadFile, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { fileVersions, nodes, users } from '@dfs/db'
import { madeAppTokenSchema } from '@dfs/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// The v1 reads (DESIGN.md §7.8): list, stat, files and search in the token's
// folder, against a real database, with files uploaded through the real routes.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let baseUrl: string
let owner: ApiClient
let token: string
let readOnlyToken: string
let version: { a: string; x: string }
let otherToken: string
let bobToken: string

const DEEP = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, '0') + 'd'.repeat(58))

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'alice', password: 'the-alice-password' })
  owner = new ApiClient(baseUrl, setup.config.publicBaseUrl)
  await owner.signIn('alice', 'the-alice-password')
  const [user] = await app.db.select().from(users).where(eq(users.username, 'alice'))
  if (!user) throw new Error('no user')

  const root = await workspace(owner)
  const notes = await createFolder(owner, root.id, 'Notes')
  const other = await createFolder(owner, root.id, 'Other')
  const sub = await createFolder(owner, notes.id, 'Sub')
  await uploadFile(owner, notes.id, 'a.txt', text('hello'))
  await uploadFile(owner, notes.id, 'b.txt', text('second'))
  await uploadFile(owner, sub.id, 'x.txt', text('deep'))
  await uploadFile(owner, other.id, 'y.txt', text('outside'))
  await startUpload(owner, notes.id, 'pending.txt', 4)
  const trashed = await uploadFile(owner, notes.id, 'gone.txt', text('bye'))
  await app.db.update(nodes).set({ deletedAt: new Date() }).where(eq(nodes.id, trashed.nodeId))
  // The same name in the Backups drive and the vault, inside Notes.
  for (const tree of ['backups', 'vault'] as const) {
    const folder = await createFolder(owner, notes.id, `${tree}-folder`)
    await uploadFile(owner, folder.id, 'z.txt', text('hidden'))
    await app.db.update(nodes).set({ tree }).where(eq(nodes.id, folder.id))
  }
  // A subfolder with a match, trashed through the real route, and single files in other trees.
  const doomed = await createFolder(owner, notes.id, 'Doomed')
  await uploadFile(owner, doomed.id, 'doomed.txt', text('x'))
  await owner.send('POST', '/nodes/trash', { json: { ids: [doomed.id] } })
  for (const tree of ['vault', 'backups'] as const) {
    const file = await uploadFile(owner, notes.id, `${tree}-file.txt`, text('hidden'))
    await app.db.update(nodes).set({ tree }).where(eq(nodes.id, file.nodeId))
  }
  const broken = await uploadFile(owner, notes.id, 'broken.dat', text('bad'))
  await app.db
    .update(fileVersions)
    .set({ state: 'failed' })
    .where(eq(fileVersions.nodeId, broken.nodeId))
  let parent = notes.id
  for (const name of DEEP) parent = (await createFolder(owner, parent, name)).id

  const make = async (canWrite: boolean) => {
    const made = await owner.call('POST', '/app-tokens', madeAppTokenSchema, {
      json: { name: 'Notes agent', folderId: notes.id, canWrite },
    })
    return made.token
  }
  const sibling = await owner.call('POST', '/app-tokens', madeAppTokenSchema, {
    json: { name: 'Other agent', folderId: other.id, canWrite: false },
  })
  otherToken = sibling.token
  // A distinct stored type, which the upload helper doesn't set.
  await app.db.update(nodes).set({ mimeType: 'text/plain' }).where(eq(nodes.name, 'a.txt'))
  await seedUser(app.db, { username: 'bob', password: 'the-bob-password' })
  const bob = new ApiClient(baseUrl, setup.config.publicBaseUrl)
  await bob.signIn('bob', 'the-bob-password')
  const bobRoot = await workspace(bob)
  const bobNotes = await createFolder(bob, bobRoot.id, 'Notes')
  await uploadFile(bob, bobNotes.id, 'a.txt', text('bob'))
  await uploadFile(bob, bobNotes.id, 'bobs.txt', text('bob'))
  bobToken = (
    await bob.call('POST', '/app-tokens', madeAppTokenSchema, {
      json: { name: 'Bob agent', folderId: bobNotes.id, canWrite: false },
    })
  ).token
  token = await make(true)
  readOnlyToken = await make(false)
  const item = async (path: string) =>
    (await (await v1(`/stat/${path}`)).json()) as { version: string }
  version = { a: (await item('a.txt')).version, x: (await item('Sub/x.txt')).version }
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

function v1(path: string, headers: Record<string, string> = {}, method = 'GET', bearer = token) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...headers },
  })
}

interface Item {
  name: string
  path: string
  kind: string
  size: number
  mimeType: string | null
  version: string | null
}
interface Page {
  items: Item[]
  nextCursor: string | null
}

describe('GET /api/v1/list', () => {
  it('lists folders first, then files, each by name', async () => {
    const response = await v1('/list')
    expect(response.status).toBe(200)
    const page = (await response.json()) as Page
    expect(page.nextCursor).toBeNull()
    expect(page.items.map((i) => i.path)).toEqual([DEEP[0], 'Sub', 'a.txt', 'b.txt', 'broken.dat'])
  })

  it('shows items as the contract says: relative paths, the current version, null for folders', async () => {
    const page = (await (await v1('/list')).json()) as Page
    const sub = page.items.find((i) => i.name === 'Sub')
    const a = page.items.find((i) => i.name === 'a.txt')
    expect(sub).toMatchObject({ path: 'Sub', kind: 'folder', mimeType: null, version: null })
    expect(a).toMatchObject({ path: 'a.txt', kind: 'file', size: 5 })
    expect(a?.version).toBe(version.a)
    const inSub = (await (await v1('/list/Sub')).json()) as Page
    expect(inSub.items.map((i) => i.path)).toEqual(['Sub/x.txt'])
  })

  it('leaves out files mid-upload, trashed ones, and other trees', async () => {
    const names = ((await (await v1('/list')).json()) as Page).items.map((i) => i.name)
    expect(names).not.toContain('pending.txt')
    expect(names).not.toContain('gone.txt')
    expect(names).not.toContain('backups-folder')
    expect(names).not.toContain('vault-folder')
  })

  it('pages with nextCursor to the end', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const page = (await (await v1(`/list?limit=1${query}`)).json()) as Page
      expect(page.items).toHaveLength(1)
      seen.push(...page.items.map((i) => i.path))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([DEEP[0], 'Sub', 'a.txt', 'b.txt', 'broken.dat'])
  })

  it('refuses limit=1001 as invalid_request, still with CORS headers', async () => {
    const response = await v1('/list?limit=1001')
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_request',
    )
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-expose-headers')).toContain('Content-Range')
  })

  it('answers 404 for a file’s path', async () => {
    const response = await v1('/list/a.txt')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })
})

describe('GET /api/v1/stat', () => {
  it('answers the item', async () => {
    const item = (await (await v1('/stat/Sub/x.txt')).json()) as Item
    expect(item).toMatchObject({ name: 'x.txt', path: 'Sub/x.txt', kind: 'file', size: 4 })
    expect(item.version).toBe(version.x)
  })

  it('answers the token’s folder with path ""', async () => {
    const item = (await (await v1('/stat')).json()) as Item
    expect(item).toMatchObject({ name: 'Notes', path: '', kind: 'folder' })
  })

  it('answers 404 for nothing, and for a file mid-upload', async () => {
    expect((await v1('/stat/nope')).status).toBe(404)
    expect((await v1('/stat/pending.txt')).status).toBe(404)
  })

  it('resolves a path of over 700 characters, never a 414', async () => {
    const path = DEEP.join('/')
    expect(path.length).toBeGreaterThan(700)
    const response = await v1(`/stat/${path}`)
    expect(response.status).toBe(200)
    expect(((await response.json()) as Item).path).toBe(path)
  })
})

describe('GET /api/v1/files', () => {
  it('sends the bytes with the headers an agent needs', async () => {
    const response = await v1('/files/a.txt')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
    expect(response.headers.get('etag')).toBe(`"${version.a}"`)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment.*a\.txt/)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-expose-headers')).toContain('ETag')
  })

  it('answers a Range with 206 and Content-Range', async () => {
    const response = await v1('/files/a.txt', { Range: 'bytes=2-4' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-4/5')
    expect(await response.text()).toBe('llo')
  })

  it('answers If-Range naming another version with the whole file', async () => {
    const response = await v1('/files/a.txt', {
      Range: 'bytes=2-4',
      'If-Range': '"00000000-0000-0000-0000-000000000000"',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
  })

  it('answers If-None-Match with the ETag as 304', async () => {
    const response = await v1('/files/a.txt', { 'If-None-Match': `"${version.a}"` })
    expect(response.status).toBe(304)
  })

  it('answers HEAD with the headers and no body', async () => {
    const response = await v1('/files/a.txt', {}, 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('5')
    expect(response.headers.get('etag')).toBe(`"${version.a}"`)
    expect(await response.text()).toBe('')
  })

  it('answers a matching If-Range with 206, and an out-of-range Range with 416', async () => {
    const matching = await v1('/files/a.txt', { Range: 'bytes=0-1', 'If-Range': `"${version.a}"` })
    expect(matching.status).toBe(206)
    expect(await matching.text()).toBe('he')
    const beyond = await v1('/files/a.txt', { Range: 'bytes=50-60' })
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe('bytes */5')
  })

  it('carries CORS headers on a 304 and a 400', async () => {
    const notModified = await v1('/files/a.txt', { 'If-None-Match': `"${version.a}"` })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('access-control-allow-origin')).toBe('*')
    const refused = await v1('/files/Sub')
    expect(refused.status).toBe(400)
    expect(refused.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers HEAD on a folder with 400', async () => {
    expect((await v1('/files/Sub', {}, 'HEAD')).status).toBe(400)
  })

  it('answers 409 for a file whose version failed, saying it could not be stored', async () => {
    const response = await v1('/files/broken.dat')
    expect(response.status).toBe(409)
    const error = ((await response.json()) as { error: { code: string; message: string } }).error
    expect(error.code).toBe('not_ready')
    expect(error.message).toMatch(/could not be stored/)
  })

  it('answers a folder, and the bare route, with 400 not_a_file', async () => {
    for (const path of ['/files/Sub', '/files']) {
      const response = await v1(path)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_a_file')
    }
  })
})

describe('GET /api/v1/search', () => {
  it('finds matches in the folder and below, with paths, never the folder itself', async () => {
    const page = (await (await v1('/search?q=TXT')).json()) as Page
    expect(page.items.map((i) => i.path)).toEqual(['a.txt', 'b.txt', 'Sub/x.txt'])
    const folders = (await (await v1('/search?q=notes')).json()) as Page
    expect(folders.items).toEqual([])
    const sub = (await (await v1('/search?q=sub')).json()) as Page
    expect(sub.items.map((i) => i.path)).toEqual(['Sub'])
  })

  it('never reaches beside the folder, the Backups drive, the vault, the trash or unfinished files', async () => {
    const names = ((await (await v1('/search?q=.txt')).json()) as Page).items.map((i) => i.name)
    expect(names).not.toContain('y.txt')
    expect(names).not.toContain('z.txt')
    expect(names).not.toContain('gone.txt')
    expect(names).not.toContain('pending.txt')
  })

  it('pages by cursor', async () => {
    const first = (await (await v1('/search?q=txt&limit=2')).json()) as Page
    expect(first.items.map((i) => i.path)).toEqual(['a.txt', 'b.txt'])
    expect(first.nextCursor).not.toBeNull()
    const second = (await (
      await v1(`/search?q=txt&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
    ).json()) as Page
    expect(second.items.map((i) => i.path)).toEqual(['Sub/x.txt'])
    expect(second.nextCursor).toBeNull()
  })

  it('leaves out a trashed subfolder’s match and files of other trees', async () => {
    const names = ((await (await v1('/search?q=txt')).json()) as Page).items.map((i) => i.name)
    for (const name of ['doomed.txt', 'vault-file.txt', 'backups-file.txt']) {
      expect(names).not.toContain(name)
    }
    const listed = ((await (await v1('/list')).json()) as Page).items.map((i) => i.name)
    for (const name of ['Doomed', 'vault-file.txt', 'backups-file.txt']) {
      expect(listed).not.toContain(name)
      expect((await v1(`/stat/${name}`)).status).toBe(404)
    }
    expect((await v1('/stat/Doomed/doomed.txt')).status).toBe(404)
  })

  it('refuses an empty q, and one of spaces', async () => {
    expect((await v1('/search?q=%20')).status).toBe(400)
    expect((await v1('/search?q=')).status).toBe(400)
    expect((await v1('/search')).status).toBe(400)
  })
})

describe('a read-only token', () => {
  it('reads every route', async () => {
    for (const path of [
      '/list',
      '/list/Sub',
      '/stat',
      '/stat/a.txt',
      '/files/a.txt',
      '/search?q=txt',
    ]) {
      const response = await v1(path, {}, 'GET', readOnlyToken)
      expect(response.status, path).toBe(200)
    }
    expect((await v1('/files/a.txt', {}, 'HEAD', readOnlyToken)).status).toBe(200)
  })

  it('keeps users and tokens apart', async () => {
    const bobs = (await (await v1('/list', {}, 'GET', bobToken)).json()) as Page
    expect(bobs.items.map((i) => i.path)).toEqual(['a.txt', 'bobs.txt'])
    const bobSearch = (await (await v1('/search?q=txt', {}, 'GET', bobToken)).json()) as Page
    expect(bobSearch.items.map((i) => i.path)).toEqual(['a.txt', 'bobs.txt'])
    // A cursor from the first token's results, used with Bob's token.
    const first = (await (await v1('/search?q=txt&limit=1')).json()) as Page
    expect(first.nextCursor).not.toBeNull()
    const foreign = (await (
      await v1(
        `/search?q=txt&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        {},
        'GET',
        bobToken,
      )
    ).json()) as Page
    expect(foreign.items.every((i) => ['a.txt', 'bobs.txt'].includes(i.path))).toBe(true)
    // The same user's token on a sibling folder.
    expect((await v1('/stat/Sub', {}, 'GET', otherToken)).status).toBe(404)
    const sibling = (await (await v1('/search?q=txt', {}, 'GET', otherToken)).json()) as Page
    expect(sibling.items.map((i) => i.path)).toEqual(['y.txt'])
  })

  it('reaches only its own user’s folder', async () => {
    expect((await v1(`/stat/Sub%2Fx.txt`)).status).toBe(400)
    expect((await v1(`/list/Other`)).status).toBe(404)
  })
})
