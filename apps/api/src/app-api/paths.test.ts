import { fileVersions, nodes, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ApiError } from '../errors.ts'
import type { AppTokenAuth } from '../app-tokens/tokens.ts'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import type { FastifyInstance } from 'fastify'
import { toAppItem } from './items.ts'
import { bodySegments, joinPath, resolvePath, resolvePrefix, urlSegments } from './paths.ts'

const LIST = '/api/v1/list'

function invalidPath(run: () => unknown, message?: RegExp) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_path' })
    if (message) expect((error as ApiError).message).toMatch(message)
    return
  }
  throw new Error('did not throw')
}

describe('urlSegments', () => {
  it('answers no segments for the token’s folder', () => {
    expect(urlSegments(LIST, LIST)).toEqual([])
    expect(urlSegments(`${LIST}/`, LIST)).toEqual([])
    expect(urlSegments(`${LIST}?limit=5`, LIST)).toEqual([])
  })

  it('splits before decoding and cuts the query', () => {
    expect(urlSegments(`${LIST}/a%20b/c%3Fd?limit=5`, LIST)).toEqual(['a b', 'c?d'])
  })

  it('refuses a / inside a name', () => {
    invalidPath(() => urlSegments(`${LIST}/a%2Fb`, LIST))
  })

  it('refuses a trailing slash, and says to leave it out', () => {
    invalidPath(() => urlSegments(`${LIST}/a/`, LIST), /trailing slash/)
  })

  it('refuses a doubled slash', () => {
    invalidPath(() => urlSegments(`${LIST}/a//b`, LIST))
  })

  it('refuses . and ..', () => {
    invalidPath(() => urlSegments(`${LIST}/.`, LIST))
    invalidPath(() => urlSegments(`${LIST}/..`, LIST))
    invalidPath(() => urlSegments(`${LIST}/%2e%2e`, LIST))
  })

  it('refuses bad percent-encoding', () => {
    invalidPath(() => urlSegments(`${LIST}/%E0%A4%A`, LIST))
  })

  it('refuses spaces at either end', () => {
    invalidPath(() => urlSegments(`${LIST}/%20a`, LIST), /without spaces at either end/)
  })

  it('refuses a name that is not NFC', () => {
    invalidPath(() => urlSegments(`${LIST}/e%CC%81`, LIST), /Unicode NFC/)
  })

  it('takes a deep path whole', () => {
    const names = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, '0') + 'x'.repeat(58))
    expect(urlSegments(`${LIST}/${names.join('/')}`, LIST)).toEqual(names)
  })
})

describe('urlSegments, more', () => {
  it('refuses a slash, backslash or NUL in a middle segment', () => {
    invalidPath(() => urlSegments(`${LIST}/a/b%2Fc/d`, LIST))
    invalidPath(() => urlSegments(`${LIST}/a/b%5Cc/d`, LIST))
    invalidPath(() => urlSegments(`${LIST}/a/b%00c/d`, LIST))
  })

  it('keeps an encoded ? in a deeper segment', () => {
    expect(urlSegments(`${LIST}/a/b/c%3Fd/e?x=1`, LIST)).toEqual(['a', 'b', 'c?d', 'e'])
  })

  it('cuts at the first ?, even before a /', () => {
    expect(urlSegments(`${LIST}?x/y`, LIST)).toEqual([])
  })

  it('refuses a doubled slash at the end', () => {
    invalidPath(() => urlSegments(`${LIST}//`, LIST))
  })

  it('refuses a URL that does not start with the literal prefix', () => {
    invalidPath(() => urlSegments('/api/%76%31/list/x', LIST))
    invalidPath(() => urlSegments('/api/v1/listx', LIST))
  })
})

describe('bodySegments', () => {
  it('refuses a lone surrogate', () => {
    invalidPath(() => bodySegments('a/\uD800b'), /well-formed/)
  })

  it('allows one leading slash', () => {
    expect(bodySegments('/a/b')).toEqual(['a', 'b'])
    expect(bodySegments('a/b')).toEqual(['a', 'b'])
  })

  it('takes the token’s folder', () => {
    expect(bodySegments('')).toEqual([])
    expect(bodySegments('/')).toEqual([])
  })

  it('does not decode, and refuses a trailing slash', () => {
    expect(bodySegments('a%20b')).toEqual(['a%20b'])
    invalidPath(() => bodySegments('a/'))
  })
})

describe('joinPath', () => {
  it('joins without a leading slash', () => {
    expect(joinPath('', 'a')).toBe('a')
    expect(joinPath('a', 'b')).toBe('a/b')
  })
})

describe('resolving', () => {
  let database: TestDatabase
  let app: FastifyInstance
  let cleanup: () => Promise<void>
  let userId: string
  let rootId: string
  let notes: typeof nodes.$inferSelect
  let token: AppTokenAuth

  async function folder(
    parentId: string,
    name: string,
    tree: 'drive' | 'vault' | 'backups' = 'drive',
  ) {
    const [row] = await app.db
      .insert(nodes)
      .values({
        ownerId: userId,
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

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    const setup = await testConfig({ DATABASE_URL: database.url })
    cleanup = setup.cleanup
    app = await buildApp({ config: setup.config, logger: false })
    await seedUser(app.db, { username: 'alice', password: 'the-alice-password' })
    const [user] = await app.db.select().from(users).where(eq(users.username, 'alice'))
    if (!user?.rootNodeId) throw new Error('no user')
    userId = user.id
    rootId = user.rootNodeId
    notes = await folder(rootId, 'Notes')
    const sub = await folder(notes.id, 'Sub')
    await file(sub.id, 'x.txt')
    await file(sub.id, 'pending.txt', false)
    const trashed = await file(sub.id, 'gone.txt')
    await app.db.update(nodes).set({ deletedAt: new Date() }).where(eq(nodes.id, trashed.id))
    await folder(rootId, 'Other')
    const dead = await folder(notes.id, 'Dead')
    const innerFile = await file(dead.id, 'inner.txt')
    await app.db.update(nodes).set({ trashedVia: dead.id }).where(eq(nodes.id, innerFile.id))
    await app.db.update(nodes).set({ deletedAt: new Date() }).where(eq(nodes.id, dead.id))
    const vaulted = await folder(notes.id, 'Vaulted')
    await app.db.update(nodes).set({ tree: 'vault' }).where(eq(nodes.id, vaulted.id))
    const elsewhere = await folder(notes.id, 'Elsewhere')
    await app.db.update(nodes).set({ tree: 'backups' }).where(eq(nodes.id, elsewhere.id))
    await file(notes.id, 'É.txt')
    await file(notes.id, '%2F')
    token = {
      tokenId: '00000000-0000-0000-0000-000000000000',
      tokenName: 'Notes agent',
      folderId: notes.id,
      canWrite: false,
      user,
      lastUsedAt: null,
    }
  })

  afterAll(async () => {
    await app.close()
    await cleanup()
    await database.drop()
  })

  async function code(run: () => Promise<unknown>): Promise<[number, string]> {
    try {
      await run()
    } catch (error) {
      if (error instanceof ApiError) return [error.status, error.code]
      throw error
    }
    throw new Error('did not throw')
  }

  it('walks by name key and answers the stored path', async () => {
    const found = await resolvePath(app.db, token, ['sub', 'X.TXT'])
    expect(found.node.name).toBe('x.txt')
    expect(found.path).toBe('Sub/x.txt')
    expect(found.folder.id).toBe(notes.id)
    const item = toAppItem(found.node, found.path)
    expect(item).toMatchObject({
      name: 'x.txt',
      path: 'Sub/x.txt',
      kind: 'file',
      size: 5,
      mimeType: 'text/plain',
    })
    expect(item.version).toBe(found.node.current_version_id)
    expect(item.version).not.toBeNull()
  })

  it('answers the token’s folder for no segments', async () => {
    const found = await resolvePath(app.db, token, [])
    expect(found.node.id).toBe(notes.id)
    expect(found.path).toBe('')
    expect(toAppItem(found.node, found.path)).toMatchObject({ kind: 'folder', version: null })
  })

  it('does not see an unfinished file or a trashed one', async () => {
    expect(await code(() => resolvePath(app.db, token, ['Sub', 'pending.txt']))).toEqual([
      404,
      'not_found',
    ])
    expect(await code(() => resolvePath(app.db, token, ['Sub', 'gone.txt']))).toEqual([
      404,
      'not_found',
    ])
  })

  it('does not walk through a file', async () => {
    expect(await code(() => resolvePath(app.db, token, ['Sub', 'x.txt', 'y']))).toEqual([
      404,
      'not_found',
    ])
  })

  it('never reaches a sibling of the token’s folder', async () => {
    expect(await code(() => resolvePath(app.db, token, ['Other']))).toEqual([404, 'not_found'])
  })

  it('walks as far as folders exist', async () => {
    const found = await resolvePrefix(app.db, token, ['sub', 'new', 'deeper'])
    expect(found.deepest.name).toBe('Sub')
    expect(found.path).toBe('Sub')
    expect(found.rest).toEqual(['new', 'deeper'])
    expect((await resolvePrefix(app.db, token, [])).rest).toEqual([])
  })

  it('refuses a file where a folder must be, finished or not', async () => {
    expect(await code(() => resolvePrefix(app.db, token, ['Sub', 'x.txt', 'y']))).toEqual([
      409,
      'not_a_folder',
    ])
    expect(await code(() => resolvePrefix(app.db, token, ['Sub', 'pending.txt', 'y']))).toEqual([
      409,
      'not_a_folder',
    ])
  })

  it('does not see below a trashed folder, the vault or Backups', async () => {
    expect(await code(() => resolvePath(app.db, token, ['Dead', 'inner.txt']))).toEqual([
      404,
      'not_found',
    ])
    expect(await code(() => resolvePath(app.db, token, ['Vaulted']))).toEqual([404, 'not_found'])
    expect(await code(() => resolvePath(app.db, token, ['Elsewhere']))).toEqual([404, 'not_found'])
    const prefix = await resolvePrefix(app.db, token, ['Vaulted', 'x'])
    expect(prefix.deepest.id).toBe(notes.id)
    expect(prefix.rest).toEqual(['Vaulted', 'x'])
  })

  it('finds a name by its Unicode case, and a literal %2F name', async () => {
    expect((await resolvePath(app.db, token, ['é.txt'])).node.name).toBe('É.txt')
    const literal = urlSegments(`${LIST}/%252F`, LIST)
    expect(literal).toEqual(['%2F'])
    expect((await resolvePath(app.db, token, literal)).path).toBe('%2F')
    expect(await code(() => resolvePath(app.db, token, ['%2F', 'y']))).toEqual([404, 'not_found'])
  })

  it('answers folder_unavailable once the folder is in the vault', async () => {
    const moved = await folder(rootId, 'Moved')
    const inside = { ...token, folderId: moved.id }
    expect((await resolvePath(app.db, inside, [])).node.id).toBe(moved.id)
    await app.db.update(nodes).set({ tree: 'vault' }).where(eq(nodes.id, moved.id))
    expect(await code(() => resolvePath(app.db, inside, []))).toEqual([409, 'folder_unavailable'])
    expect(await code(() => resolvePrefix(app.db, inside, []))).toEqual([409, 'folder_unavailable'])
  })
})
