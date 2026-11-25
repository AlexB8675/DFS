import { randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createDatabase, createPool, type Database } from './client.ts'
import { appTokens, nodes, users } from './schema.ts'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'

describe('app tokens (DESIGN.md §7.8)', () => {
  let database: TestDatabase
  let db: Database
  let close: () => Promise<void>

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    const pool = createPool(database.url, {
      applicationName: 'dfs-tests',
      onError: () => undefined,
    })
    db = createDatabase(pool)
    close = () => pool.end()
  })

  afterAll(async () => {
    await close()
    await database.drop()
  })

  async function makeUser() {
    const username = `app-${randomUUID().slice(0, 8)}`
    const [user] = await db
      .insert(users)
      .values({ username, displayName: username, passwordHash: 'x', quotaBytes: 1 })
      .returning()
    if (!user) throw new Error('no user')
    return user
  }

  async function makeFolder(ownerId: string) {
    const name = `folder-${randomUUID().slice(0, 8)}`
    const [folder] = await db
      .insert(nodes)
      .values({ ownerId, kind: 'folder', name, nameKey: name })
      .returning()
    if (!folder) throw new Error('no folder')
    return folder
  }

  const token = (userId: string, folderId: string, tokenHash = randomBytes(32)) => ({
    userId,
    folderId,
    name: 'An app',
    tokenHash,
    canWrite: false,
  })

  const count = async (id: string) => {
    const { rows } = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM app_tokens WHERE id = ${id}`,
    )
    return rows[0]?.n
  }

  it('goes with its folder when the folder is deleted for good', async () => {
    const user = await makeUser()
    const folder = await makeFolder(user.id)
    const [row] = await db.insert(appTokens).values(token(user.id, folder.id)).returning()
    if (!row) throw new Error('no token')
    expect(await count(row.id)).toBe(1)
    /* tree: a test removing a folder as purge.ts does */
    await db.execute(sql`DELETE FROM nodes WHERE id = ${folder.id}`)
    expect(await count(row.id)).toBe(0)
  })

  it('goes with its user', async () => {
    const user = await makeUser()
    const other = await makeUser()
    const folder = await makeFolder(other.id)
    const [row] = await db.insert(appTokens).values(token(user.id, folder.id)).returning()
    if (!row) throw new Error('no token')
    await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`)
    expect(await count(row.id)).toBe(0)
  })

  it('refuses a second row with the same hash', async () => {
    const user = await makeUser()
    const folder = await makeFolder(user.id)
    const hash = randomBytes(32)
    await db.insert(appTokens).values(token(user.id, folder.id, hash))
    await expect(
      db.insert(appTokens).values(token(user.id, folder.id, hash)),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })
})
