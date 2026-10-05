import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApiClient } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { storageChannelSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Admin → Channels with Discord storage (D25): the bot checks a channel is in
// this environment's category before it is registered. A stand-in bot answers.

const OURS = '100000000000000001'
const THEIRS = '100000000000000002'

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let bot: Server
let admin: ApiClient

beforeAll(async () => {
  bot = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => {
      const { discordChannelId } = JSON.parse(body) as { discordChannelId: string }
      response.setHeader('content-type', 'application/json')
      if (request.url === '/internal/channels/adopt' && discordChannelId === OURS) {
        response.end(JSON.stringify({ name: 'storage-04', changes: [] }))
        return
      }
      response.statusCode = 422
      response.end(
        JSON.stringify({
          error: {
            code: 'channel_refused',
            message: 'That channel isn’t in the “DFS Dev” category.',
          },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => bot.listen(0, '127.0.0.1', resolve))
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({
    DATABASE_URL: database.url,
    BLOB_STORE: 'discord',
    BOT_INTERNAL_URL: `http://127.0.0.1:${String((bot.address() as AddressInfo).port)}`,
  })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password', role: 'admin' })
  admin = new ApiClient(address, setup.config.publicBaseUrl)
  await admin.signIn('owner', 'the-owner-password')
})

afterAll(async () => {
  await app.close()
  await new Promise((resolve) => bot.close(resolve))
  await database.drop()
  await cleanup()
})

describe('registering a channel by hand, with Discord storage', () => {
  it('takes a channel the bot finds in this environment’s category, and refuses others', async () => {
    const added = await admin.call('POST', '/admin/channels', storageChannelSchema, {
      json: { discordChannelId: OURS, name: 'storage-04' },
    })
    expect(added).toMatchObject({ discordChannelId: OURS, enabled: true })
    expect(
      await admin.error('POST', '/admin/channels', {
        json: { discordChannelId: THEIRS, name: 'production' },
      }),
    ).toEqual({ status: 422, code: 'channel_refused' })
  })

  it('says so when the bot can’t be asked', async () => {
    await new Promise((resolve) => bot.close(resolve))
    expect(
      await admin.error('POST', '/admin/channels', {
        json: { discordChannelId: '100000000000000003', name: 'later' },
      }),
    ).toEqual({ status: 503, code: 'bot_unavailable' })
    await new Promise<void>((resolve) => bot.listen(0, '127.0.0.1', resolve))
  })
})
