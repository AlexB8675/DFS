import { storeAllStagedBlobs } from '@dfs/bot/uploader'
import { defineContractSuite, type ContractTarget } from '@dfs/contract'
import { foldAllFolderStats } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { LocalBlobStore } from '@dfs/storage'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from './app.ts'
import { testConfig } from './testing/config.ts'
import { seedUser } from './testing/seed.ts'

// The contract suite (BACKEND.md §5) against the real API, over real HTTP.
// `settle` does what the bot would: store staged blobs, fold folder sizes.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let target: ContractTarget

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  // Only server errors are logged: a 500 in the suite should say why.
  app = await buildApp({ config: setup.config, logger: { level: 'error' } })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const owner = { username: 'owner', password: 'the-owner-password' }
  await seedUser(app.db, { ...owner, role: 'admin', isOwner: true })
  const store = new LocalBlobStore(setup.config.localBlobDir)
  target = {
    name: 'api',
    baseUrl: address,
    origin: setup.config.publicBaseUrl,
    owner,
    settle: async () => {
      await storeAllStagedBlobs({ db: app.db, staging: app.staging, store })
      await foldAllFolderStats(app.db)
    },
  }
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

defineContractSuite({ describe, it, expect }, () => target)
