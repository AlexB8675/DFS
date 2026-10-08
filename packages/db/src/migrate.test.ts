import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createDatabase, createPool, type Database } from './client.ts'
import { auditRecords, shareRecords, type JournalRecord } from './journal.ts'
import { MIGRATIONS_DIR, runMigrations } from './migrate.ts'
import { auditLog, fileVersions, nodes, shareLinks, users } from './schema.ts'
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
        const instance = await client.query<{ id: string }>('SELECT id FROM instance')
        return {
          applied: Number(applied.rows[0]?.count),
          tables: Number(tables.rows[0]?.count),
          instance: instance.rows.map((row) => row.id),
        }
      })
      // One instance ID, made once (DESIGN §4).
      expect(counts).toEqual({
        applied: 24,
        tables: 18,
        instance: [expect.stringMatching(/^[0-9a-f]{12}$/)],
      })
    } finally {
      await withAdmin(adminUrl, (admin) => admin.query(`DROP DATABASE ${name} WITH (FORCE)`))
    }
  })
})

describe('migrations over existing rows', () => {
  it('make the state types again without `lost`, and date the blobs already released (0020, 0021)', async () => {
    const { adminUrl } = inject('testPostgres')
    const name = `dfs_states_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await withAdmin(adminUrl, (admin) => admin.query(`CREATE DATABASE ${name}`))
    const url = databaseUrl(adminUrl, name)
    // The migrations up to 0019, as a database last migrated before these.
    const before = await mkdtemp(path.join(tmpdir(), 'dfs-migrations-'))
    try {
      const journal = JSON.parse(
        await readFile(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { idx: number; tag: string }[] }
      journal.entries = journal.entries.filter((entry) => entry.idx <= 19)
      await mkdir(path.join(before, 'meta'))
      await writeFile(path.join(before, 'meta', '_journal.json'), JSON.stringify(journal))
      for (const entry of journal.entries) {
        await copyFile(
          path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
          path.join(before, `${entry.tag}.sql`),
        )
      }
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      try {
        await migrate(createDatabase(client), { migrationsFolder: before })
        await client.query(`
          WITH owner AS (
            INSERT INTO users (username, display_name, password_hash, quota_bytes)
            VALUES ('states', 'States', 'x', 1) RETURNING id
          ), file AS (
            INSERT INTO nodes (owner_id, kind, name, name_key)
            SELECT id, 'folder', 'My Drive', 'my drive' FROM owner RETURNING id
          )
          INSERT INTO file_versions
            (node_id, version_no, state, size_bytes, chunk_size, chunk_count, wrapped_dek, key_id)
          SELECT file.id, number, state::version_state, 1, 1, 1, decode('00', 'hex'), 'k'
          FROM file, unnest(ARRAY['uploading', 'syncing', 'stored', 'failed'])
            WITH ORDINALITY AS states(state, number)`)
        await client.query(`
          INSERT INTO blobs (kind, state, size_bytes)
          SELECT 'pack', state::blob_state, 1
          FROM unnest(ARRAY['staged', 'stored', 'deleting', 'deleted']) AS states(state)`)
      } finally {
        await client.end()
      }

      await runMigrations(url)
      const after = await withAdmin(url, async (admin) => ({
        versions: (
          await admin.query<{ state: string }>(
            'SELECT state FROM file_versions ORDER BY version_no',
          )
        ).rows.map((row) => row.state),
        blobs: (
          await admin.query<{ state: string; released: boolean }>(
            'SELECT state, released_at IS NOT NULL AS released FROM blobs ORDER BY id',
          )
        ).rows,
        types: (
          await admin.query<{ type: string; labels: string[] }>(`
            SELECT typname AS type, array_agg(enumlabel::text ORDER BY enumsortorder) AS labels
            FROM pg_enum JOIN pg_type ON pg_type.oid = enumtypid
            WHERE typname IN ('blob_state', 'version_state') GROUP BY typname ORDER BY typname`)
        ).rows,
        indexes: (
          await admin.query<{ name: string }>(`
            SELECT indexname AS name FROM pg_indexes
            WHERE indexname IN ('blobs_queue', 'file_versions_in_flight', 'blobs_lost')
            ORDER BY indexname`)
        ).rows.map((row) => row.name),
        defaultState: (
          await admin.query<{ state: string }>(`
            SELECT column_default AS state FROM information_schema.columns
            WHERE table_name = 'file_versions' AND column_name = 'state'`)
        ).rows[0]?.state,
      }))
      expect(after).toEqual({
        versions: ['uploading', 'syncing', 'stored', 'failed'],
        blobs: [
          { state: 'staged', released: false },
          { state: 'stored', released: false },
          { state: 'deleting', released: true },
          { state: 'deleted', released: false },
        ],
        types: [
          {
            type: 'blob_state',
            labels: ['building', 'staged', 'uploading', 'stored', 'deleting', 'deleted'],
          },
          {
            type: 'version_state',
            labels: ['uploading', 'syncing', 'stored', 'failed', 'purging', 'purged'],
          },
        ],
        indexes: ['blobs_queue', 'file_versions_in_flight'],
        defaultState: "'uploading'::version_state",
      })
    } finally {
      await rm(before, { recursive: true, force: true })
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

  /**
   * Runs an older migration's statements again, against the schema as it is
   * now, with the column they read that a later one dropped (0019).
   */
  async function replay(statements: readonly string[]) {
    await db.execute(sql`ALTER TABLE share_links ADD COLUMN revoked_at timestamptz`)
    try {
      for (const statement of statements) await db.execute(sql.raw(statement))
    } finally {
      await db.execute(sql`ALTER TABLE share_links DROP COLUMN revoked_at`)
    }
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

  it('backfills share links and audit entries as the API journals them (0016)', async () => {
    const { user, root } = await createUser('backfill')
    const [share] = await db
      .insert(shareLinks)
      .values({
        nodeId: root.id,
        tokenHash: Buffer.alloc(32, 7),
        passwordHash: 'argon',
        maxDownloads: 3,
        downloadCount: 2,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      })
      .returning()
    const [entry] = await db
      .insert(auditLog)
      .values({ userId: user.id, action: 'share.created', nodeId: root.id, meta: { target: 'x' } })
      .returning()
    if (!share || !entry) throw new Error('no rows')

    const backfill = await readFile(
      new URL('../migrations/0016_journal_shares_audit.sql', import.meta.url),
      'utf8',
    )
    await replay(backfill.split('--> statement-breakpoint'))
    const { rows } = await db.execute<JournalRecord & Record<string, unknown>>(sql`
      SELECT kind, record FROM journal
      WHERE record->>'id' IN (${share.id}, ${String(entry.id)}) ORDER BY id`)
    // As JSON, the way recovery reads either: dates compare as instants.
    const normal = (records: JournalRecord[]) =>
      records.map(({ kind, record }) => ({
        kind,
        record: Object.fromEntries(
          Object.entries(JSON.parse(JSON.stringify(record)) as Record<string, unknown>).map(
            ([key, value]) => [
              key,
              typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)
                ? Date.parse(value)
                : value,
            ],
          ),
        ),
      }))
    // 0016 came before links had versions (0018), and while they kept revokedAt (0019).
    const [record, ...rest] = [...shareRecords([share]), ...auditRecords([entry])]
    if (!record) throw new Error('no record')
    const { versionId: _versionId, ...linkState } = record.record
    expect(normal(rows)).toEqual(
      normal([{ ...record, record: { ...linkState, revokedAt: null } }, ...rest]),
    )
    expect(rows[0]?.record).not.toHaveProperty('downloadCount')
  })

  it('pins file links to their file’s version, journaled as the API journals them (0018)', async () => {
    const { user, root } = await createUser('pins')
    const [file] = await db
      .insert(nodes)
      .values({
        ownerId: user.id,
        parentId: root.id,
        kind: 'file',
        name: 'a.txt',
        nameKey: 'a.txt',
      })
      .returning()
    if (!file) throw new Error('no file')
    const [version] = await db
      .insert(fileVersions)
      .values({
        nodeId: file.id,
        versionNo: 1,
        state: 'stored',
        sizeBytes: 1,
        chunkSize: 1,
        chunkCount: 1,
        wrappedDek: Buffer.alloc(60),
        keyId: 'k',
      })
      .returning()
    if (!version) throw new Error('no version')
    await db.update(nodes).set({ currentVersionId: version.id }).where(eq(nodes.id, file.id))
    const links = await db
      .insert(shareLinks)
      .values([
        { nodeId: file.id, tokenHash: Buffer.alloc(32, 1) },
        { nodeId: root.id, tokenHash: Buffer.alloc(32, 2) },
      ])
      .returning()

    // Its data statements: the column, the key and the index exist already.
    const backfill = await readFile(
      new URL('../migrations/0018_share_link_versions.sql', import.meta.url),
      'utf8',
    )
    await replay(backfill.split('--> statement-breakpoint').slice(3))
    const pinned = await db.select().from(shareLinks).where(eq(shareLinks.nodeId, file.id))
    expect(pinned.map((link) => link.versionId)).toEqual([version.id])
    const folderLink = await db.select().from(shareLinks).where(eq(shareLinks.nodeId, root.id))
    expect(folderLink.map((link) => link.versionId)).toEqual([null])
    const { rows } = await db.execute<JournalRecord & Record<string, unknown>>(sql`
      SELECT kind, record FROM journal WHERE record->>'id' = ${links[0]?.id ?? ''}`)
    expect(rows.at(-1)?.record).toMatchObject({
      id: links[0]?.id,
      versionId: version.id,
      tokenHash: Buffer.alloc(32, 1).toString('hex'),
    })
  })

  it('searches names by trigram similarity', async () => {
    const { rows } = await db.execute<{ similar: boolean }>(
      sql`SELECT similarity('holiday photos', 'holday photo') > 0.3 AS similar`,
    )
    expect(rows[0]?.similar).toBe(true)
  })
})
