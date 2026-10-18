import { ApiClient, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { shareLinkSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Each app counts its own guesses, so this file has its own: the second test
// fills the address's window, and no other file's links share it.
let database: TestDatabase
let setup: Awaited<ReturnType<typeof testConfig>>
let app: FastifyInstance
let owner: ApiClient
let stranger: ApiClient
let rootId: string

const ADDRESS = 'address:127.0.0.1'

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  setup = await testConfig({ DATABASE_URL: database.url })
  app = await buildApp({ config: setup.config, logger: false })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password' })
  owner = new ApiClient(address, setup.config.publicBaseUrl)
  stranger = new ApiClient(address, setup.config.publicBaseUrl)
  await owner.signIn('owner', 'the-owner-password')
  rootId = (await workspace(owner)).id
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await setup.cleanup()
})

/** A link to `nodeId` made by the owner, as the token after `/s/` in its address. */
async function link(nodeId: string, terms: { expiresAt?: string | null } = {}): Promise<string> {
  const made = await owner.call('POST', '/shares', shareLinkSchema, {
    json: { nodeId, expiresAt: null, password: null, maxDownloads: null, ...terms },
  })
  return made.url?.split('/s/')[1] ?? ''
}

describe('the guess limit (§7.5, D46)', () => {
  it('never counts a link that works, or one expired or used up', async () => {
    const working = await link(rootId)
    const expired = await link(rootId, { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    for (let i = 0; i < 40; i += 1) {
      expect((await stranger.fetch('GET', `/s/${working}`)).status).toBe(200)
      expect(await stranger.error('GET', `/s/${expired}`)).toEqual({
        status: 410,
        code: 'share_expired',
      })
    }
  })

  it('refuses an address that asked for 30 links that don’t exist, working ones too', async () => {
    const working = await link(rootId)
    for (let hit = 1; hit < 30; hit += 1) app.limits.shareGuesses.hit(ADDRESS)
    // The 30th miss is answered as a miss, and fills the window.
    expect(await stranger.error('GET', '/s/zzzzzz')).toEqual({
      status: 404,
      code: 'share_not_found',
    })
    const refused = await stranger.fetch('GET', `/s/${working}`)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await stranger.error('GET', `/s/${working}/children`)).toEqual({
      status: 429,
      code: 'rate_limited',
    })
    expect(
      await stranger.error('POST', `/s/${working}/unlock`, { json: { password: 'x' } }),
    ).toEqual({ status: 429, code: 'rate_limited' })
  })
})
