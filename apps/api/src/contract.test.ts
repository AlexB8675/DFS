import path from 'node:path'
import { loadConfig } from '@dfs/config'
import { defineContractSuite, type ContractTarget } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from './app.ts'
import { seedUser } from './testing/seed.ts'

// The contract suite (BACKEND.md §5) against the real API, over real HTTP.

let database: TestDatabase
let app: FastifyInstance
let target: ContractTarget

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const config = loadConfig(
    { NODE_ENV: 'test', DATABASE_URL: database.url, LOG_LEVEL: 'silent' },
    { service: 'api', rootDir: path.resolve('/repo') },
  )
  app = await buildApp({ config, logger: false })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const owner = { username: 'owner', password: 'the-owner-password' }
  await seedUser(app.db, { ...owner, role: 'admin', isOwner: true })
  target = {
    name: 'api',
    baseUrl: address,
    origin: config.publicBaseUrl,
    owner,
    settle: () => Promise.resolve(),
  }
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

defineContractSuite({ describe, it, expect }, () => target)
