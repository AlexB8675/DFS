import { ApiClient, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { shareLinkSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { RateLimiter } from '../auth/rate-limit.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Each app counts its own guesses, so this file has its own, and every test
// starts with a fresh limiter: the tests fill the address's window.
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

beforeEach(() => {
  app.limits.shareGuesses = new RateLimiter(30, 10 * 60_000)
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await setup.cleanup()
})

/** A link to `nodeId` made by the owner, as the token after `/s/` in its address. */
async function link(
  nodeId: string,
  terms: { expiresAt?: string | null; maxDownloads?: number | null } = {},
): Promise<string> {
  const made = await owner.call('POST', '/shares', shareLinkSchema, {
    json: { nodeId, expiresAt: null, password: null, maxDownloads: null, ...terms },
  })
  return made.url?.split('/s/')[1] ?? ''
}

describe('the guess limit (§7.5, D46)', () => {
  it('never counts a link that works, or one expired or used up', async () => {
    const working = await link(rootId)
    const expired = await link(rootId, { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    // One download, read to the end, uses this link up.
    const usedUp = await link(rootId, { maxDownloads: 1 })
    const archive = await stranger.fetch('GET', `/s/${usedUp}/archive`)
    expect(archive.status).toBe(200)
    await archive.arrayBuffer()
    for (let i = 0; i < 40; i += 1) {
      expect((await stranger.fetch('GET', `/s/${working}`)).status).toBe(200)
      expect(await stranger.error('GET', `/s/${expired}`)).toEqual({
        status: 410,
        code: 'share_expired',
      })
      expect(await stranger.error('GET', `/s/${usedUp}`)).toEqual({
        status: 410,
        code: 'share_used_up',
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

  it('answers at most 30 misses from guesses sent at once', async () => {
    // Each guess is counted only after its lookup, so all 60 pass the first
    // check; the check made again as each lookup settles keeps the answers to 30.
    const answers = await Promise.all(
      Array.from({ length: 60 }, (_, i) => stranger.error('GET', `/s/guess-${String(i)}`)),
    )
    for (const answer of answers) {
      expect([
        { status: 404, code: 'share_not_found' },
        { status: 429, code: 'rate_limited' },
      ]).toContainEqual(answer)
    }
    expect(answers.filter((answer) => answer.status === 404).length).toBeLessThanOrEqual(30)
    expect(answers.filter((answer) => answer.status === 429).length).toBeGreaterThanOrEqual(30)
  })
})
