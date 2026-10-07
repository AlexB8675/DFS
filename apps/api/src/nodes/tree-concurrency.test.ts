import { users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq, sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { moderate } from '../admin/browse.ts'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { createUploads } from '../uploads/uploads.ts'
import { visibleNode } from './read.ts'
import { createFolder, ensureFolders, moveNodes, trashNodes, updateNode } from './write.ts'

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

async function folder(parentId = auth.user.rootNodeId) {
  if (!parentId) throw new Error('Missing root folder.')
  return createFolder(app, auth, parentId, crypto.randomUUID())
}

/** Pause a write after its visibility check, then race it with removing the destination. */
async function removeDuringWrite<T>(
  heldRow: SQL,
  blockedTable: string,
  write: () => Promise<T>,
  remove: () => Promise<void>,
): Promise<PromiseSettledResult<T>> {
  const locked = Promise.withResolvers<undefined>()
  const proceed = Promise.withResolvers<undefined>()
  const holding = app.db.transaction(async (tx) => {
    await tx.execute(heldRow)
    locked.resolve(undefined)
    await proceed.promise
  })
  await locked.promise
  const writing = write()
  let removed = false
  const removing = (async () => {
    await vi.waitFor(async () => {
      const { rows } = await app.db.execute(sql`
        SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND state = 'active' AND wait_event_type = 'Lock'
          AND position(${blockedTable} in query) > 0`)
      expect(rows).toHaveLength(1)
    })
    await remove()
    removed = true
  })()
  const changes = Promise.allSettled([writing, removing])
  try {
    // Either removal finishes before the write, or correctly waits for its
    // tree lock. Release the row only after observing one of these outcomes.
    await vi.waitFor(async () => {
      const { rows } = await app.db.execute(sql`
        SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND state = 'active' AND wait_event_type = 'Lock'
          AND position('pg_advisory_xact_lock' in query) > 0`)
      expect(removed || rows.length > 0).toBe(true)
    })
  } finally {
    proceed.resolve(undefined)
    await holding
  }
  const [written, removal] = await changes
  expect(removal.status).toBe('fulfilled')
  return written
}

describe('concurrent changes to a subtree', () => {
  it.each(['single', 'paths'])(
    'includes an uncommitted %s folder creation when trashing its ancestor',
    async (creation) => {
      const ancestor = await folder()
      const destination = await folder(ancestor.id)
      const entered = Promise.withResolvers<undefined>()
      const proceed = Promise.withResolvers<undefined>()
      const transaction = app.db.transaction.bind(app.db)
      const spy = vi.spyOn(app.db, 'transaction').mockImplementationOnce((work, config) =>
        transaction(async (tx) => {
          const result = await work(tx)
          entered.resolve(undefined)
          await proceed.promise
          return result
        }, config),
      )
      const creating =
        creation === 'single'
          ? createFolder(app, auth, destination.id, 'added')
          : ensureFolders(app, auth, destination.id, ['added/child'])
      const removing = (async () => {
        await entered.promise
        await trashNodes(app, auth, [ancestor.id])
      })()
      const changes = Promise.allSettled([creating, removing])
      try {
        await vi.waitFor(async () => {
          const { rows } = await app.db.execute(sql`
            SELECT pid FROM pg_stat_activity WHERE datname = current_database()
              AND state = 'active' AND wait_event_type = 'Lock'
              AND position('pg_advisory_xact_lock' in query) > 0`)
          expect(rows).toHaveLength(1)
        })
      } finally {
        proceed.resolve(undefined)
        await changes
        spy.mockRestore()
      }
      const [created, removal] = await changes
      expect(removal.status).toBe('fulfilled')
      if (created.status === 'rejected') expect(created.reason).toMatchObject({ status: 404 })
      const { rows } = await app.db.execute<{ id: string }>(sql`
        WITH RECURSIVE below AS (
          SELECT id FROM nodes WHERE parent_id = ${destination.id}
          UNION ALL
          SELECT child.id FROM nodes child JOIN below ON child.parent_id = below.id
        )
        SELECT id FROM below`)
      expect(rows).toHaveLength(creation === 'single' ? 1 : 2)
      for (const row of rows)
        await expect(visibleNode(app.db, auth.user.id, row.id)).rejects.toMatchObject({
          status: 404,
        })
    },
  )

  it.each([
    { removal: 'trash', move: 'single' },
    { removal: 'trash', move: 'batch' },
    { removal: 'moderation', move: 'single' },
    { removal: 'moderation', move: 'batch' },
  ])(
    'keeps a $move move hidden when its destination races with $removal',
    async ({ removal, move }) => {
      const ancestor = await folder()
      const destination = await folder(ancestor.id)
      const moving = await folder()
      const result = await removeDuringWrite(
        sql`SELECT id FROM nodes WHERE id = ${moving.id} FOR NO KEY UPDATE`,
        'nodes',
        async () => {
          if (move === 'single')
            await updateNode(app, auth, moving.id, { parentId: destination.id })
          else await moveNodes(app, auth, [moving.id], destination.id)
        },
        () =>
          removal === 'trash'
            ? trashNodes(app, auth, [ancestor.id])
            : moderate(app, auth, ancestor.id, 'Test moderation').then(() => undefined),
      )
      // A single-node response may itself observe the now-trashed node.
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 404 })
      await expect(visibleNode(app.db, auth.user.id, moving.id)).rejects.toMatchObject({
        status: 404,
      })
    },
  )

  it('keeps an upload hidden when its checked destination is trashed before insertion', async () => {
    const ancestor = await folder()
    const destination = await folder(ancestor.id)
    const result = await removeDuringWrite(
      sql`SELECT id FROM users WHERE id = ${auth.user.id} FOR UPDATE`,
      'users',
      () =>
        createUploads(app, auth, [
          {
            parentId: destination.id,
            name: 'pending.txt',
            sizeBytes: 3,
            mimeType: 'text/plain',
          },
        ]),
      () => trashNodes(app, auth, [ancestor.id]),
    )
    expect(result.status).toBe('fulfilled')
    if (result.status !== 'fulfilled') throw new Error('The upload request failed.')
    const [upload] = result.value
    if (!upload?.ok) throw new Error('No upload was started.')
    await expect(visibleNode(app.db, auth.user.id, upload.session.nodeId)).rejects.toMatchObject({
      status: 404,
    })
  })
})
