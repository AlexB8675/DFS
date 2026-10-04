import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createDatabase, createPool, type Database } from './client.ts'
import { runMigrations } from './migrate.ts'
import { nodes, users } from './schema.ts'
import { createTestDatabase, databaseUrl, withAdmin, type TestDatabase } from './testing/index.ts'

describe('migrations', () => {
  it('apply to an empty database, and again as a no-op', async () => {
    const { adminUrl } = inject('testPostgres')
    const name = `dfs_empty_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await withAdmin(adminUrl, (admin) => admin.query(`CREATE DATABASE ${name}`))
    const url = databaseUrl(adminUrl, name)
    try {
      await runMigrations(url)
      await runMigrations(url)
      const counts = await withAdmin(url, async (client) => {
        const applied = await client.query<{ count: string }>(
          'SELECT count(*) FROM drizzle.__drizzle_migrations',
        )
        const tables = await client.query<{ count: string }>(
          "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
        )
        return { applied: Number(applied.rows[0]?.count), tables: Number(tables.rows[0]?.count) }
      })
      expect(counts).toEqual({ applied: 5, tables: 13 })
    } finally {
      await withAdmin(adminUrl, (admin) => admin.query(`DROP DATABASE ${name} WITH (FORCE)`))
    }
  })
})

describe('schema rules (DESIGN §5.1)', () => {
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

  /** A user with their root folder, made the way the API will. */
  async function createUser(username: string, fields: Partial<typeof users.$inferInsert> = {}) {
    return db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ username, displayName: username, passwordHash: 'x', quotaBytes: 1, ...fields })
        .returning()
      if (!user) throw new Error('no user')
      const [root] = await tx
        .insert(nodes)
        .values({ ownerId: user.id, kind: 'folder', name: 'My Drive', nameKey: 'my drive' })
        .returning()
      if (!root) throw new Error('no root')
      await tx
        .update(users)
        .set({ rootNodeId: root.id })
        .where(sql`${users.id} = ${user.id}`)
      return { user, root }
    })
  }

  /** The constraint a failed statement broke, from drizzle's wrapped error. */
  async function violated(work: Promise<unknown>): Promise<string | undefined> {
    const error: unknown = await work.then(
      () => null,
      (failure: unknown) => failure,
    )
    const cause = (error as { cause?: { constraint?: string } } | null)?.cause
    return cause?.constraint
  }

  it('generates time-ordered UUIDv7 IDs', async () => {
    const { user, root } = await createUser('ids')
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(root.id > user.id).toBe(true)
  })

  it('keeps usernames lowercase and unique, and allows one owner', async () => {
    await createUser('owner', { isOwner: true, role: 'admin' })
    expect(await violated(createUser('Sam'))).toBe('users_username_lowercase')
    expect(await violated(createUser('owner'))).toBe('users_username_key')
    expect(await violated(createUser('second', { isOwner: true, role: 'admin' }))).toBe(
      'users_one_owner',
    )
    expect(await violated(createUser('plain-owner', { isOwner: true }))).toBe(
      'users_owner_is_admin',
    )
  })

  it('allows one name per folder, ignoring trashed items', async () => {
    const { user, root } = await createUser('names')
    const file = (deletedAt: Date | null = null) =>
      db.insert(nodes).values({
        ownerId: user.id,
        parentId: root.id,
        kind: 'file',
        name: 'Photo.JPG',
        nameKey: 'photo.jpg',
        deletedAt,
      })
    await file()
    expect(await violated(file())).toBe('nodes_unique_name')
    await file(new Date())
  })

  it('gives each user one root folder, and roots are folders', async () => {
    const { user } = await createUser('roots')
    const root = (kind: 'folder' | 'file') =>
      db.insert(nodes).values({ ownerId: user.id, kind, name: 'Another', nameKey: 'another' })
    expect(await violated(root('folder'))).toBe('nodes_one_root_per_owner')
    expect(await violated(root('file'))).toBe('nodes_root_is_folder')
  })

  it('searches names by trigram similarity', async () => {
    const { rows } = await db.execute<{ similar: boolean }>(
      sql`SELECT similarity('holiday photos', 'holday photo') > 0.3 AS similar`,
    )
    expect(rows[0]?.similar).toBe(true)
  })
})
