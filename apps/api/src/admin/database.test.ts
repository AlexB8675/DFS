import { ApiClient } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { auditPageSchema, databaseStatusSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Admin → Database (DESIGN.md §16) against a real PostgreSQL: a stuck query
// shows up with what it runs, and an admin can cancel it.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let admin: ApiClient

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password', role: 'admin' })
  admin = new ApiClient(address, setup.config.publicBaseUrl)
  await admin.signIn('owner', 'the-owner-password')
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

describe('Admin → Database (§16)', () => {
  it('shows a long query and cancels it, in the audit log', async () => {
    const sleeper = new pg.Client({
      connectionString: database.url,
      application_name: 'dfs-test-sleeper',
    })
    await sleeper.connect()
    try {
      const sleeping = sleeper.query('SELECT pg_sleep(30)').then(
        () => 'finished',
        (error: unknown) => (error as { code?: string }).code,
      )
      let session
      for (let tries = 0; tries < 50 && !session; tries++) {
        const status = await admin.call('GET', '/admin/database', databaseStatusSchema)
        session = status.sessions.find((entry) => entry.application === 'dfs-test-sleeper')
        if (!session) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(session).toMatchObject({ state: 'active', query: 'SELECT pg_sleep(30)' })

      await admin.send('POST', `/admin/database/sessions/${String(session?.pid)}/cancel`)
      // 57014: query_canceled.
      expect(await sleeping).toBe('57014')
      const log = await admin.call('GET', '/admin/audit?limit=5', auditPageSchema)
      expect(log.items[0]).toMatchObject({
        action: 'database.query_cancelled',
        target: `dfs-test-sleeper (${String(session?.pid)})`,
      })
    } finally {
      await sleeper.end()
    }
  })

  it('ends a transaction left open, which only ending its connection can do', async () => {
    const idle = new pg.Client({
      connectionString: database.url,
      application_name: 'dfs-test-idle',
    })
    idle.on('error', () => undefined)
    await idle.connect()
    try {
      await idle.query('BEGIN')
      await idle.query('SELECT 1')
      const status = await admin.call('GET', '/admin/database', databaseStatusSchema)
      const session = status.sessions.find((entry) => entry.application === 'dfs-test-idle')
      expect(session?.state).toBe('idle in transaction')
      const pid = String(session?.pid)

      expect(await admin.error('POST', `/admin/database/sessions/${pid}/cancel`)).toEqual({
        status: 409,
        code: 'not_running',
      })
      await admin.send('POST', `/admin/database/sessions/${pid}/terminate`)
      await expect(idle.query('SELECT 1')).rejects.toThrow()
    } finally {
      await idle.end().catch(() => undefined)
    }
  })

  it('vacuums a table it lists, by name, and nothing else', async () => {
    await admin.send('POST', '/admin/database/tables/nodes/vacuum')
    const status = await admin.call('GET', '/admin/database', databaseStatusSchema)
    expect(status.tables.find((table) => table.name === 'nodes')?.lastVacuumAt).not.toBeNull()
    for (const name of ['no_such_table', 'nodes; DROP TABLE users', 'pg_catalog.pg_class']) {
      expect(
        await admin.error('POST', `/admin/database/tables/${encodeURIComponent(name)}/vacuum`),
      ).toEqual({ status: 404, code: 'not_found' })
    }
    const log = await admin.call('GET', '/admin/audit?limit=1', auditPageSchema)
    expect(log.items[0]).toMatchObject({ action: 'database.vacuumed', target: 'nodes' })
  })

  it('keeps the slowest statements, normalized', async () => {
    const status = await admin.call('GET', '/admin/database', databaseStatusSchema)
    expect(status.statements.unavailable).toBeNull()
    expect(status.statements.items.length).toBeGreaterThan(0)
  })
})
