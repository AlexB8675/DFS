import { LOCK_NAMESPACE, LOCKS, nodes, purgeSubtrees, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { cancelUpload, createUploads, receivePart, uploadStatus } from '../uploads/uploads.ts'
import { visibleNode } from './read.ts'
import { createFolder, ensureFolders, restoreNode, trashNodes, updateNode } from './write.ts'

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

describe('concurrent node changes', () => {
  it('keeps both a rename and a move when both requests read the original node', async () => {
    const destination = await folder()
    const node = await folder()
    const locked = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const holding = app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM nodes WHERE id = ${node.id} FOR NO KEY UPDATE`)
      locked.resolve(undefined)
      await proceed.promise
    })
    await locked.promise
    const name = `renamed-${crypto.randomUUID()}`
    const changes = Promise.allSettled([
      updateNode(app, auth, node.id, { name }),
      updateNode(app, auth, node.id, { parentId: destination.id }),
    ])
    try {
      // Hold both writes until their earlier reads are complete. Either order
      // must preserve the field changed by the other request.
      await vi.waitFor(async () => {
        const { rows } = await app.db.execute(sql`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock'
            AND position('update' in lower(query)) > 0 AND position('nodes' in query) > 0`)
        expect(rows).toHaveLength(2)
      })
    } finally {
      proceed.resolve(undefined)
    }
    await holding
    expect((await changes).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const final = await visibleNode(app.db, auth.user.id, node.id)
    expect(final).toMatchObject({ name, parent_id: destination.id })
  })
})

describe('preparing upload folders', () => {
  it('reuses folders created by a concurrent request for the same path', async () => {
    const parent = await folder()
    const path = 'photos/holidays'
    const locked = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const holding = app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCKS.journal})`)
      locked.resolve(undefined)
      await proceed.promise
    })
    await locked.promise
    const first = ensureFolders(app, auth, parent.id, [path])
    let requests: Promise<PromiseSettledResult<Record<string, string>>[]> | undefined
    try {
      // The first request has inserted its folders, but cannot commit them yet.
      await vi.waitFor(async () => {
        const { rows } = await app.db.execute(sql`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock'
            AND position('pg_advisory_xact_lock' in query) > 0`)
        expect(rows).toHaveLength(1)
      })
      requests = Promise.allSettled([first, ensureFolders(app, auth, parent.id, [path])])
      await vi.waitFor(async () => {
        const { rows } = await app.db.execute(sql`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock'
            AND position('insert' in lower(query)) > 0 AND position('nodes' in query) > 0`)
        expect(rows).toHaveLength(1)
      })
    } finally {
      proceed.resolve(undefined)
      await holding
      await first
    }
    const results = await requests
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const ids = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value[path]] : [],
    )
    expect(new Set(ids).size).toBe(1)
    const { rows } = await app.db.execute(sql`
      SELECT id FROM nodes WHERE parent_id = ${parent.id} AND name_key = 'photos'`)
    expect(rows).toHaveLength(1)
  })

  it('rejects a file occupying an upload folder path', async () => {
    const parent = await folder()
    await app.db.insert(nodes).values({
      ownerId: auth.user.id,
      parentId: parent.id,
      kind: 'file',
      name: 'photos',
      nameKey: 'photos',
    })

    await expect(ensureFolders(app, auth, parent.id, ['photos/holidays'])).rejects.toMatchObject({
      status: 409,
      code: 'name_conflict',
    })
  })

  it.each([
    { first: 'photos', second: 'reports', paths: ['reports', 'PHOTOS'] },
    { first: 'a', second: 'a-', paths: ['a-', 'a/child'] },
  ])(
    'does not deadlock with a reversed batch containing $first and $second',
    async ({ first, second, paths }) => {
      const parent = await folder()
      const locked = Promise.withResolvers<undefined>()
      const proceed = Promise.withResolvers<undefined>()
      const holding = app.db.transaction(async (tx) => {
        // Stop another batch between its first and second folder insert.
        await tx.insert(nodes).values({
          ownerId: auth.user.id,
          parentId: parent.id,
          kind: 'folder',
          name: first,
          nameKey: first,
        })
        locked.resolve(undefined)
        await proceed.promise
        await tx.insert(nodes).values({
          ownerId: auth.user.id,
          parentId: parent.id,
          kind: 'folder',
          name: second,
          nameKey: second,
        })
      })
      await locked.promise
      const preparing = ensureFolders(app, auth, parent.id, paths)
      const results = Promise.allSettled([holding, preparing])
      try {
        await vi.waitFor(async () => {
          const { rows } = await app.db.execute(sql`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock'
            AND position('insert' in lower(query)) > 0 AND position('nodes' in query) > 0`)
          expect(rows).toHaveLength(1)
        })
      } finally {
        proceed.resolve(undefined)
      }

      expect((await results).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      const folders = await preparing
      expect(Object.keys(folders).toSorted()).toEqual(paths.toSorted())
    },
  )

  it('keeps explicit folder creation strict when the folder already exists', async () => {
    const parent = await folder()
    await createFolder(app, auth, parent.id, 'photos')

    await expect(createFolder(app, auth, parent.id, 'photos')).rejects.toMatchObject({
      status: 409,
      code: 'name_conflict',
    })
  })
})

describe('restoring nested trash', () => {
  it('restores an independently trashed child when its parent is still trashed', async () => {
    const parent = await folder()
    const child = await folder(parent.id)
    const descendant = await folder(child.id)
    await trashNodes(app, auth, [child.id])
    await trashNodes(app, auth, [parent.id])

    const restored = await restoreNode(app, auth, child.id)

    expect(restored.parentId).toBe(auth.user.rootNodeId)
    const visible = await visibleNode(app.db, auth.user.id, descendant.id)
    expect(visible.parent_id).toBe(child.id)
    const [stillTrashed] = await app.db.select().from(nodes).where(eq(nodes.id, parent.id))
    expect(stillTrashed?.deletedAt).not.toBeNull()
  })

  it('keeps independently trashed descendants in the trash after restoring their parent', async () => {
    const parent = await folder()
    const child = await folder(parent.id)
    const descendant = await folder(child.id)
    await trashNodes(app, auth, [child.id])
    await trashNodes(app, auth, [parent.id])

    await restoreNode(app, auth, parent.id)

    await expect(visibleNode(app.db, auth.user.id, child.id)).rejects.toMatchObject({
      status: 404,
    })
    await expect(visibleNode(app.db, auth.user.id, descendant.id)).rejects.toMatchObject({
      status: 404,
    })
    const restored = await restoreNode(app, auth, child.id)
    expect(restored.parentId).toBe(parent.id)
    await expect(visibleNode(app.db, auth.user.id, descendant.id)).resolves.toMatchObject({
      parent_id: child.id,
    })
  })
})

async function overlappingUploads() {
  if (!auth.user.rootNodeId) throw new Error('Missing root folder.')
  const input = {
    parentId: auth.user.rootNodeId,
    name: `${crypto.randomUUID()}.txt`,
    sizeBytes: 3,
    mimeType: 'text/plain',
  }
  const [first, second] = await createUploads(app, auth, [input, input])
  if (!first?.ok || !second?.ok) throw new Error('Could not start overlapping uploads.')
  return [first.session, second.session] as const
}

describe('cancelling overlapping uploads', () => {
  it('keeps another receiving version and removes the unfinished file after the last cancellation', async () => {
    const [first, second] = await overlappingUploads()

    await cancelUpload(app, auth, first.uploadId)

    await expect(uploadStatus(app, auth, second.uploadId)).resolves.toMatchObject({
      state: 'receiving',
    })
    await expect(visibleNode(app.db, auth.user.id, second.nodeId)).resolves.toMatchObject({
      version_state: null,
    })

    await cancelUpload(app, auth, second.uploadId)

    const remaining = await app.db.select().from(nodes).where(eq(nodes.id, second.nodeId))
    expect(remaining).toHaveLength(0)
  })

  it('keeps the first version when a later receiving version is cancelled', async () => {
    const [first, second] = await overlappingUploads()

    await cancelUpload(app, auth, second.uploadId)

    await expect(uploadStatus(app, auth, first.uploadId)).resolves.toMatchObject({
      state: 'receiving',
    })
    await cancelUpload(app, auth, first.uploadId)
    const remaining = await app.db.select().from(nodes).where(eq(nodes.id, first.nodeId))
    expect(remaining).toHaveLength(0)
  })

  it('keeps the completed version when an earlier receiving version is cancelled', async () => {
    const [first, second] = await overlappingUploads()
    await receivePart(app, auth, second.uploadId, 0, Buffer.from('new'), undefined)

    await cancelUpload(app, auth, first.uploadId)

    await expect(visibleNode(app.db, auth.user.id, second.nodeId)).resolves.toMatchObject({
      version_state: 'syncing',
    })
    await expect(uploadStatus(app, auth, second.uploadId)).resolves.toMatchObject({
      state: 'completed',
    })
  })

  it('purges a file without deadlocking with a transaction completing its upload', async () => {
    const [first] = await overlappingUploads()
    const locked = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const completing = app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM upload_sessions WHERE id = ${first.uploadId} FOR UPDATE`)
      locked.resolve(undefined)
      await proceed.promise
      await tx.execute(sql`UPDATE nodes SET updated_at = now() WHERE id = ${first.nodeId}`)
    })
    await locked.promise
    const purging = app.db.transaction((tx) => purgeSubtrees(tx, auth.user.id, [first.nodeId]))
    // Observe the blocked session lock before letting completion take its node
    // lock. Both operations must acquire those locks in the same order.
    try {
      await vi.waitFor(async () => {
        const { rows } = await app.db.execute(sql`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock'
            AND position('upload_sessions' in query) > 0`)
        expect(rows.length).toBeGreaterThan(0)
      })
    } finally {
      proceed.resolve(undefined)
    }

    const results = await Promise.allSettled([completing, purging])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('cancels without blocking a new version that already reserved the user lock', async () => {
    if (!auth.user.rootNodeId) throw new Error('Missing root folder.')
    const [first] = await createUploads(app, auth, [
      {
        parentId: auth.user.rootNodeId,
        name: `${crypto.randomUUID()}.txt`,
        sizeBytes: 3,
        mimeType: 'text/plain',
      },
    ])
    if (!first?.ok) throw new Error('Could not start test upload.')
    const { session } = first
    const uploadId = crypto.randomUUID()
    const versionId = crypto.randomUUID()
    const locked = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const starting = app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${auth.user.id} FOR UPDATE`)
      locked.resolve(undefined)
      await proceed.promise
      // The same foreign-key locks as starting an upload: its version and
      // session both refer to the file while the user's quota row is held.
      await tx.execute(sql`
        INSERT INTO file_versions (id, node_id, version_no, size_bytes, chunk_size, chunk_count,
          wrapped_dek, key_id, created_by)
        SELECT ${versionId}, node_id, 2, size_bytes, chunk_size, chunk_count,
          wrapped_dek, key_id, created_by FROM file_versions WHERE id = ${session.versionId}`)
      await tx.execute(sql`
        INSERT INTO upload_sessions (id, user_id, node_id, version_id, reserved_bytes, expires_at)
        VALUES (${uploadId}, ${auth.user.id}, ${session.nodeId}, ${versionId}, 3, now() + interval '1 day')`)
      await tx.execute(sql`
        UPDATE users SET reserved_bytes = reserved_bytes + 3 WHERE id = ${auth.user.id}`)
    })
    await locked.promise
    const cancelling = cancelUpload(app, auth, session.uploadId)
    try {
      await vi.waitFor(async () => {
        const { rows } = await app.db.execute(sql`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock'
            AND position('UPDATE users' in query) > 0`)
        expect(rows.length).toBeGreaterThan(0)
      })
    } finally {
      proceed.resolve(undefined)
    }

    const results = await Promise.allSettled([starting, cancelling])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    await expect(uploadStatus(app, auth, uploadId)).resolves.toMatchObject({ state: 'receiving' })
    await cancelUpload(app, auth, uploadId)
    const remaining = await app.db.select().from(nodes).where(eq(nodes.id, session.nodeId))
    expect(remaining).toHaveLength(0)
  })
})
