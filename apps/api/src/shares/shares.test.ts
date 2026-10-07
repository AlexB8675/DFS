import { users, type JournalRecord } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { auditAlone } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { createFolder } from '../nodes/write.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { createShare, revokeShare, updateShare } from './shares.ts'

let database: TestDatabase
let app: FastifyInstance
let auth: Auth
let cleanup: () => Promise<void>

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password' })
  const [user] = await app.db.select().from(users).where(eq(users.username, 'owner'))
  if (!user) throw new Error('Missing test user.')
  auth = {
    user,
    sessionId: 'test',
    csrfToken: 'test',
    expiresAt: new Date(Date.now() + 60_000),
    seenAt: null,
    limited: false,
  }
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

/** The journal's records after `after`, oldest first. */
async function journaledSince(after: number): Promise<JournalRecord[]> {
  const { rows } = await app.db.execute<JournalRecord & Record<string, unknown>>(sql`
    SELECT kind, record FROM journal WHERE id > ${after} ORDER BY id`)
  return rows
}

async function lastJournalId(): Promise<number> {
  const { rows } = await app.db.execute<{ id: number }>(sql`
    SELECT coalesce(max(id), 0)::float8 AS id FROM journal`)
  return rows[0]?.id ?? 0
}

describe('share links in the journal (§8)', () => {
  it('records each change of a link with its audit entry, without its download count', async () => {
    if (!auth.user.rootNodeId) throw new Error('Missing root folder.')
    const folder = await createFolder(app, auth, auth.user.rootNodeId, 'Shared')

    let since = await lastJournalId()
    const share = await createShare(app, auth, {
      nodeId: folder.id,
      expiresAt: null,
      password: 'a share password',
      maxDownloads: 5,
    })
    const created = await journaledSince(since)
    expect(created).toMatchObject([
      { kind: 'share.upsert', record: { id: share.id, nodeId: folder.id, maxDownloads: 5 } },
      { kind: 'audit.added', record: { action: 'share.created', nodeId: folder.id } },
    ])
    expect(created[0]?.record.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(created[0]?.record.passwordHash).toEqual(expect.any(String))
    expect(created[0]?.record).not.toHaveProperty('downloadCount')

    since = await lastJournalId()
    await updateShare(app, auth, share.id, { maxDownloads: 9 })
    expect(await journaledSince(since)).toMatchObject([
      { kind: 'share.upsert', record: { id: share.id, maxDownloads: 9, revokedAt: null } },
    ])

    since = await lastJournalId()
    await revokeShare(app, auth, share.id)
    const revoked = await journaledSince(since)
    expect(revoked).toMatchObject([
      { kind: 'share.upsert', record: { id: share.id } },
      { kind: 'audit.added', record: { action: 'share.revoked' } },
    ])
    expect(revoked[0]?.record.revokedAt).toEqual(expect.any(String))
  })

  it('journals an audit entry written on its own', async () => {
    const since = await lastJournalId()
    await auditAlone(app.db, { actorId: auth.user.id, action: 'admin.viewed', target: 'Someone' })
    expect(await journaledSince(since)).toMatchObject([
      {
        kind: 'audit.added',
        record: { userId: auth.user.id, action: 'admin.viewed', meta: { target: 'Someone' } },
      },
    ])
  })
})
