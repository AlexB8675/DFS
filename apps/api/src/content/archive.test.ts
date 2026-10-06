import { users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { visibleNode } from '../nodes/read.ts'
import { createFolder, trashNodes, updateNode } from '../nodes/write.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { archiveEntries } from './archive.ts'

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

async function folder(name: string, parentId = auth.user.rootNodeId) {
  if (!parentId) throw new Error('Missing root folder.')
  return createFolder(app, auth, parentId, name)
}

describe('archive entries', () => {
  it('keeps descendant paths when the selected folder is renamed before traversal', async () => {
    const root = await folder('original-name')
    await folder('child', root.id)
    const selected = await visibleNode(app.db, auth.user.id, root.id)
    await updateNode(app, auth, root.id, { name: 'x' })

    const entries = await archiveEntries(app, [selected])

    expect(entries.map((entry) => entry.path)).toEqual(['original-name/', 'original-name/child/'])
  })

  it('leaves out a selection moved to the trash before traversal', async () => {
    const root = await folder('hidden-selection')
    await folder('child', root.id)
    const selected = await visibleNode(app.db, auth.user.id, root.id)
    await trashNodes(app, auth, [root.id])

    expect(await archiveEntries(app, [selected])).toEqual([])
  })

  it('looks up every selected subtree together instead of once per root', async () => {
    const selected = await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const created = await folder(`batch-${String(index)}`)
        return visibleNode(app.db, auth.user.id, created.id)
      }),
    )
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    try {
      const entries = await archiveEntries(app, selected)
      expect(entries).toHaveLength(selected.length)
      expect(queries).toHaveBeenCalledTimes(1)
    } finally {
      queries.mockRestore()
    }
  })

  it('keeps overlapping selections and disambiguates duplicate top-level names', async () => {
    const root = await folder('overlap')
    const child = await folder('overlap', root.id)
    await folder('leaf', child.id)
    const selected = await Promise.all(
      [root, child].map((node) => visibleNode(app.db, auth.user.id, node.id)),
    )
    const entries = await archiveEntries(app, selected)
    expect(entries.map((entry) => entry.path)).toEqual([
      'overlap/',
      'overlap/overlap/',
      'overlap/overlap/leaf/',
      'overlap (1)/',
      'overlap (1)/leaf/',
    ])
  })

  it('returns no entries and makes no query for an empty selection', async () => {
    const execute = vi.spyOn(app.db, 'execute')
    try {
      expect(await archiveEntries(app, [])).toEqual([])
      expect(execute).not.toHaveBeenCalled()
    } finally {
      execute.mockRestore()
    }
  })
})
