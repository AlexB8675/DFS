import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  auditLog,
  createDatabase,
  createPool,
  devicePairings,
  nodes,
  sessions,
  shareLinks,
  users,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import {
  cleanUp,
  dropEarlierVersions,
  emptyOldTrash,
  emptyResetVaults,
  giveUpIdleUploads,
  onTheClock,
} from './leader-work.ts'
import { uploadedFiles } from './testing.ts'

// The leader samples the system once in each half-minute bucket (DESIGN §16):
// on the clock, so a slow run never pushes a sample into the next bucket.

describe('onTheClock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a little past each mark, once in each bucket, however long runs take', async () => {
    const start = Date.UTC(2026, 9, 6, 12)
    vi.useFakeTimers({ now: start + 7_000 })
    const runs: number[] = []
    const ticking = onTheClock(30_000, 2_000, { warn: vi.fn() }, 'sampling', async () => {
      runs.push(Date.now())
      // Each run takes 4 s, which `repeat` would add to every interval.
      await new Promise((resolve) => setTimeout(resolve, 4_000))
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await ticking.stop()
    expect(runs.map((at) => (at - start) / 1000)).toEqual(
      Array.from({ length: 10 }, (_, index) => 32 + 30 * index),
    )
  })

  it('keeps to the clock after a run fails, and says so', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12) })
    const log = { warn: vi.fn() }
    let calls = 0
    const ticking = onTheClock(30_000, 2_000, log, 'sampling', () => {
      calls += 1
      return Promise.reject(new Error('down'))
    })
    await vi.advanceTimersByTimeAsync(61_000)
    await ticking.stop()
    expect(calls).toBe(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
})

describe('cleanUp', () => {
  let database: TestDatabase
  let pool: pg.Pool
  let db: Database
  let directory: string

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    pool = createPool(database.url, { applicationName: 'dfs-janitor-test', onError: vi.fn() })
    db = createDatabase(pool)
    directory = await mkdtemp(path.join(tmpdir(), 'dfs-janitor-'))
  })

  afterAll(async () => {
    await pool.end()
    await database.drop()
    await rm(directory, { recursive: true, force: true })
  })

  it('empties what has been in the trash past its days, as the system', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, files } = await uploadedFiles(db, staging, [100, 200])
    const [old, recent] = files
    if (!old || !recent) throw new Error('No test files.')
    // Ages by the database's clock, which the janitor goes by.
    await db.execute(
      sql`UPDATE nodes SET deleted_at = now() - interval '31 days' WHERE id = ${old.nodeId}`,
    )
    await db.execute(
      sql`UPDATE nodes SET deleted_at = now() - interval '29 days' WHERE id = ${recent.nodeId}`,
    )

    expect(await emptyOldTrash(db, staging, 30)).toBe(1)
    const { rows: left } = await db.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE id = ANY(ARRAY[${old.nodeId}, ${recent.nodeId}]::uuid[])`)
    expect(left.map((row) => row.id)).toEqual([recent.nodeId])
    // Its staged frame and its quota go with it; the other's stay.
    await expect(staging.read(staging.framePath(old.versionId, 0))).rejects.toThrow()
    expect((await staging.read(staging.framePath(recent.versionId, 0))).length).toBe(200)
    const { rows: used } = await db.execute<{ used: number }>(sql`
      SELECT used_bytes::float8 AS used FROM users WHERE id = ${ownerId}`)
    expect(used[0]?.used).toBe(200)

    const { rows: logged } = await db.execute<{ user_id: string | null; details: string }>(sql`
      SELECT user_id, meta->>'details' AS details FROM audit_log
      WHERE action = 'node.purged' AND node_id = ${old.nodeId}`)
    expect(logged).toEqual([{ user_id: null, details: 'after 30 days in the trash' }])
    const { rows: journaled } = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM journal
      WHERE kind = 'node.purge' AND record->>'id' = ${old.nodeId}`)
    expect(journaled[0]?.count).toBe(1)
    // Nothing else is due.
    expect(await emptyOldTrash(db, staging, 30)).toBe(0)
  })

  /** An owner whose one file is moved into a vault of theirs, made by hand, with an open session. */
  async function vaultWithAFile(staging: Staging, resetAt: ReturnType<typeof sql.raw>) {
    const { ownerId, files } = await uploadedFiles(db, staging, [100])
    const file = files[0]
    if (!file) throw new Error('No test file.')
    const [vault] = await db
      .insert(nodes)
      .values({ ownerId, kind: 'folder', name: 'Vault', nameKey: 'vault', tree: 'vault' })
      .returning()
    if (!vault) throw new Error('No test vault.')
    // The trigger fills the tree on insert only, so a move says it.
    await db.execute(
      sql`UPDATE nodes SET parent_id = ${vault.id}, tree = 'vault' WHERE id = ${file.nodeId}`,
    )
    await db.execute(sql`
      UPDATE users SET vault_root_id = ${vault.id}, vault_salt = decode('00', 'hex'),
        vault_key_by_code = decode('01', 'hex'), vault_key_by_recovery = decode('02', 'hex'),
        vault_reset_at = ${resetAt}
      WHERE id = ${ownerId}`)
    const sessionId = randomBytes(16).toString('hex')
    await db.insert(sessions).values({
      id: sessionId,
      userId: ownerId,
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() + 3_600_000),
      vaultKeySealed: Buffer.from('sealed'),
      vaultLocksAt: new Date(Date.now() + 600_000),
    })
    return { ownerId, vaultId: vault.id, nodeId: file.nodeId, versionId: file.versionId, sessionId }
  }

  it('leaves a vault alone until its reset is due', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { vaultId, nodeId } = await vaultWithAFile(staging, sql.raw(`now() + interval '1 day'`))

    expect(await emptyResetVaults(db, staging)).toBe(0)
    const { rows: left } = await db.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE id = ANY(ARRAY[${vaultId}, ${nodeId}]::uuid[])`)
    expect(left.map((row) => row.id).sort()).toEqual([vaultId, nodeId].sort())
  })

  it('empties a vault whose reset is due, as the system, and lets its owner make a new one', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, vaultId, nodeId, versionId, sessionId } = await vaultWithAFile(
      staging,
      sql.raw(`now() - interval '1 minute'`),
    )

    expect(await emptyResetVaults(db, staging)).toBe(1)
    // The vault and its file are gone; the drive stays.
    const { rows: left } = await db.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE id = ANY(ARRAY[${vaultId}, ${nodeId}]::uuid[])`)
    expect(left).toEqual([])
    const { rows: drive } = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM nodes
      WHERE owner_id = ${ownerId} AND parent_id IS NULL AND tree = 'drive'`)
    expect(drive[0]?.count).toBe(1)
    await expect(staging.read(staging.framePath(versionId, 0))).rejects.toThrow()

    const { rows: owner } = await db.execute<{
      used: number
      vault_root_id: string | null
      vault_salt: Buffer | null
      vault_key_by_code: Buffer | null
      vault_key_by_recovery: Buffer | null
      vault_reset_at: Date | null
    }>(sql`
      SELECT used_bytes::float8 AS used, vault_root_id, vault_salt, vault_key_by_code,
        vault_key_by_recovery, vault_reset_at
      FROM users WHERE id = ${ownerId}`)
    expect(owner).toEqual([
      {
        used: 0,
        vault_root_id: null,
        vault_salt: null,
        vault_key_by_code: null,
        vault_key_by_recovery: null,
        vault_reset_at: null,
      },
    ])
    // An open session no longer holds the key of a vault that is gone.
    const { rows: session } = await db.execute<{
      vault_key_sealed: Buffer | null
      vault_locks_at: Date | null
    }>(sql`SELECT vault_key_sealed, vault_locks_at FROM sessions WHERE id = ${sessionId}`)
    expect(session).toEqual([{ vault_key_sealed: null, vault_locks_at: null }])

    const { rows: logged } = await db.execute<{ user_id: string | null }>(sql`
      SELECT user_id FROM audit_log WHERE action = 'vault.reset'`)
    expect(logged).toEqual([{ user_id: null }])
    const { rows: journaled } = await db.execute<{ kind: string; vault_key: string | null }>(sql`
      SELECT kind, record->>'vaultKeyByCode' AS vault_key FROM journal
      WHERE (kind = 'node.purge' AND record->>'id' = ${vaultId})
        OR (kind = 'user.upsert' AND record->>'id' = ${ownerId})
      ORDER BY id`)
    expect(journaled.map((row) => row.kind)).toEqual(['node.purge', 'user.upsert'])
    expect(journaled[1]?.vault_key).toBeNull()

    // The owner can make a new one: the tree's root is free again.
    await db.insert(nodes).values({
      ownerId,
      kind: 'folder',
      name: 'Vault',
      nameKey: 'vault',
      tree: 'vault',
    })
    // Nothing else is due.
    expect(await emptyResetVaults(db, staging)).toBe(0)
  })

  it('keeps a vault its owner opened meanwhile', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, vaultId, nodeId } = await vaultWithAFile(
      staging,
      sql.raw(`now() - interval '1 minute'`),
    )
    // As opening the vault clears the date.
    await db.execute(sql`UPDATE users SET vault_reset_at = NULL WHERE id = ${ownerId}`)

    expect(await emptyResetVaults(db, staging)).toBe(0)
    const { rows: left } = await db.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE id = ANY(ARRAY[${vaultId}, ${nodeId}]::uuid[])`)
    expect(left.map((row) => row.id).sort()).toEqual([vaultId, nodeId].sort())
  })

  it('gives up uploads whose page went quiet for ten minutes, and keeps those it hears of', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, files } = await uploadedFiles(db, staging, [100, 200])
    const [quiet, heard] = files
    if (!quiet || !heard) throw new Error('No test files.')
    // As a first upload still receiving: no current version, its bytes reserved.
    for (const [file, age] of [
      [quiet, '11 minutes'],
      [heard, '2 minutes'],
    ] as const) {
      await db.execute(sql`UPDATE nodes SET current_version_id = NULL WHERE id = ${file.nodeId}`)
      await db.execute(
        sql`UPDATE file_versions SET state = 'uploading' WHERE id = ${file.versionId}`,
      )
      await db.execute(sql`
        INSERT INTO upload_sessions (user_id, node_id, version_id, reserved_bytes, expires_at, alive_at)
        VALUES (${ownerId}, ${file.nodeId}, ${file.versionId}, 1000, now() + interval '1 day',
          now() - ${age}::interval)`)
    }
    await db.execute(sql`UPDATE users SET reserved_bytes = 2000 WHERE id = ${ownerId}`)

    await giveUpIdleUploads(db, staging)
    const { rows: left } = await db.execute<{ id: string }>(sql`
      SELECT id FROM nodes WHERE id = ANY(ARRAY[${quiet.nodeId}, ${heard.nodeId}]::uuid[])`)
    expect(left.map((row) => row.id)).toEqual([heard.nodeId])
    await expect(staging.read(staging.framePath(quiet.versionId, 0))).rejects.toThrow()
    const { rows: owner } = await db.execute<{ reserved: number }>(sql`
      SELECT reserved_bytes::float8 AS reserved FROM users WHERE id = ${ownerId}`)
    expect(owner[0]?.reserved).toBe(1000)
  })

  it('deletes an earlier version left over, and the links made for it (D42)', async () => {
    const staging = new Staging(path.join(directory, 'staging'))
    const { ownerId, files } = await uploadedFiles(db, staging, [100, 200])
    const [first, second] = files
    if (!first || !second) throw new Error('No test files.')
    // The second upload is the file's second version, its current one.
    await db.execute(sql`
      UPDATE file_versions SET node_id = ${first.nodeId}, version_no = 2 WHERE id = ${second.versionId}`)
    await db.execute(
      sql`UPDATE nodes SET current_version_id = ${second.versionId} WHERE id = ${first.nodeId}`,
    )
    const [link] = await db
      .insert(shareLinks)
      .values({
        nodeId: first.nodeId,
        versionId: first.versionId,
        tokenHash: randomBytes(32),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning()
    if (!link) throw new Error('No test link.')
    // A folder link has no version, and stays.
    const { rows: parents } = await db.execute<{ parent_id: string }>(sql`
      SELECT parent_id FROM nodes WHERE id = ${first.nodeId}`)
    const [folderLink] = await db
      .insert(shareLinks)
      .values({ nodeId: parents[0]?.parent_id ?? '', tokenHash: randomBytes(32) })
      .returning()
    const used = async () => {
      const { rows } = await db.execute<{ used: number }>(sql`
        SELECT used_bytes::float8 AS used FROM users WHERE id = ${ownerId}`)
      return rows[0]?.used
    }

    expect(await used()).toBe(300)
    await dropEarlierVersions(db, staging)
    expect(await used()).toBe(200)
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT id FROM share_links WHERE id IN (${link.id}, ${folderLink?.id ?? ''})`)
    expect(rows).toEqual([{ id: folderLink?.id }])
    const { rows: journaled } = await db.execute<{ record: { id: string } }>(sql`
      SELECT record FROM journal WHERE kind = 'share.deleted'`)
    expect(journaled.map((row) => row.record.id)).toContain(link.id)
    // Its staged frame went with it; the current version's stays.
    await expect(staging.read(staging.framePath(first.versionId, 0))).rejects.toThrow()
    await expect(staging.read(staging.framePath(second.versionId, 0))).resolves.toHaveLength(200)
    const { rows: versions } = await db.execute<{ id: string }>(sql`
      SELECT id FROM file_versions WHERE node_id = ${first.nodeId}`)
    expect(versions.map((row) => row.id)).toEqual([second.versionId])
  })

  it('deletes pairings whose minute has passed, and keeps live ones', async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: crypto.randomUUID(),
        displayName: 'Pairing',
        passwordHash: '-',
        quotaBytes: 1,
      })
      .returning()
    if (!user) throw new Error('No test user.')
    // Ages by the database's clock, which the janitor goes by.
    await db.insert(devicePairings).values([
      {
        codeHash: Buffer.alloc(32, 1),
        userId: user.id,
        name: 'Laptop',
        challenge: 'c',
        expiresAt: sql`now() - interval '1 second'`,
      },
      {
        codeHash: Buffer.alloc(32, 2),
        userId: user.id,
        name: 'Desktop',
        challenge: 'c',
        expiresAt: sql`now() + interval '1 minute'`,
      },
    ])

    await cleanUp(db, new Staging(path.join(directory, 'staging')))
    const left = await db
      .select({ codeHash: devicePairings.codeHash })
      .from(devicePairings)
      .where(sql`${devicePairings.userId} = ${user.id}`)
    expect(left.map((row) => row.codeHash)).toEqual([Buffer.alloc(32, 2)])
  })

  it('keeps the audit log for a year', async () => {
    // Ages by the database's clock, which the janitor goes by.
    const entry = (action: string, age: string) => ({
      action,
      meta: { target: '', details: null },
      at: sql`now() - ${age}::interval`,
    })
    await db
      .insert(auditLog)
      .values([
        entry('auth.login', '1 year 1 hour'),
        entry('auth.login_failed', '364 days'),
        entry('user.created', '1 day'),
      ])

    await cleanUp(db, new Staging(path.join(directory, 'staging')))
    const left = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(sql`${auditLog.action} IN ('auth.login', 'auth.login_failed', 'user.created')`)
      .orderBy(auditLog.id)
    expect(left.map((row) => row.action)).toEqual(['auth.login_failed', 'user.created'])
  })
})
