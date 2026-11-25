import { ApiClient, createFolder, startUpload, text, uploadFile, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { nodes, users } from '@dfs/db'
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
  let parent = notes.id
  for (const name of DEEP) parent = (await createFolder(owner, parent, name)).id

  const make = async (canWrite: boolean) => {
    const made = await owner.call('POST', '/app-tokens', madeAppTokenSchema, {
      json: { name: 'Notes agent', folderId: notes.id, canWrite },
    })
    return made.token
  }
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
    expect(page.items.map((i) => i.path)).toEqual([DEEP[0], 'Sub', 'a.txt', 'b.txt'])
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
    expect(seen).toEqual([DEEP[0], 'Sub', 'a.txt', 'b.txt'])
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
    expect(response.headers.get('content-type')).toContain('application/octet-stream')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/)
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

  it('refuses an empty q', async () => {
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

  it('reaches only its own user’s folder', async () => {
    expect((await v1(`/stat/Sub%2Fx.txt`)).status).toBe(400)
    expect((await v1(`/list/Other`)).status).toBe(404)
  })
})
