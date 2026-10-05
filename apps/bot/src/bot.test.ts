import path from 'node:path'
import { loadConfig } from '@dfs/config'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { createBot, type Bot } from './bot.ts'

describe('bot', () => {
  let database: TestDatabase
  let bot: Bot
  const secret = 'a-test-secret-that-is-long-enough'

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    const config = loadConfig(
      { NODE_ENV: 'test', DATABASE_URL: database.url, INTERNAL_RPC_SECRET: secret },
      { service: 'bot', rootDir: path.resolve('/repo') },
    )
    bot = createBot({
      config,
      logger: false,
      onLeadershipLost: () => undefined,
      election: { pollMs: 50 },
    })
  })

  afterAll(async () => {
    await bot.stop()
    await database.drop()
  })

  it('starts the job queue once it leads', async () => {
    await vi.waitFor(
      () => {
        expect(bot.queue()).not.toBeNull()
      },
      { timeout: 15_000 },
    )
    const health = await bot.server.inject({
      method: 'GET',
      url: '/internal/health',
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(health.json()).toEqual({ role: 'leader', queue: 'running' })
  })

  it('answers internal calls only with the shared secret (§7.5)', async () => {
    const call = (authorization?: string) =>
      bot.server.inject({
        method: 'GET',
        url: '/internal/health',
        headers: authorization ? { authorization } : {},
      })
    expect((await call()).statusCode).toBe(401)
    expect((await call('Bearer wrong')).statusCode).toBe(401)
    expect((await call(`Bearer ${secret}`)).statusCode).toBe(200)
  })

  it('signs CDN URLs only for Discord storage, for a bounded number of blobs', async () => {
    const refresh = (blobIds: unknown) =>
      bot.server.inject({
        method: 'POST',
        url: '/internal/urls/refresh',
        headers: { authorization: `Bearer ${secret}` },
        payload: { blobIds },
      })
    expect((await refresh([])).statusCode).toBe(400)
    expect((await refresh(Array.from({ length: 201 }, (_, i) => i + 1))).statusCode).toBe(400)
    // A local store has no URLs to sign.
    expect((await refresh([1, 2])).json()).toEqual({ urls: [] })
  })
})
