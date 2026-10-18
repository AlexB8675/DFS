import { createHash } from 'node:crypto'
import { ApiClient, workspace } from '@dfs/contract'
import { shareLinks, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { isShortCode, publicShareSchema, shareLinkSchema } from '@dfs/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { createShare } from './shares.ts'
import { storedTokenHash } from './tokens.ts'

let database: TestDatabase
let app: FastifyInstance
let owner: ApiClient
let stranger: ApiClient
let ownerAuth: Auth
let rootId: string
let cleanup: () => Promise<void>

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password' })
  owner = new ApiClient(address, setup.config.publicBaseUrl)
  stranger = new ApiClient(address, setup.config.publicBaseUrl)
  await owner.signIn('owner', 'the-owner-password')
  rootId = (await workspace(owner)).id
  // The owner as createShare takes them, built as shares.test.ts builds it.
  const [user] = await app.db.select().from(users).where(eq(users.username, 'owner'))
  if (!user) throw new Error('Missing test user.')
  ownerAuth = {
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

async function shortLink(nodeId: string, terms: { password?: string } = {}) {
  const made = await owner.call('POST', '/shares', shareLinkSchema, {
    json: {
      nodeId,
      expiresAt: null,
      password: terms.password ?? null,
      maxDownloads: null,
      short: true,
    },
  })
  return { made, code: made.url?.split('/s/')[1] ?? '' }
}

/** The code as someone might type it: in capitals, with O for 0 and I for 1. */
const typed = (code: string) => code.toUpperCase().replaceAll('0', 'O').replaceAll('1', 'I')

describe('short share links (§7.5, D46)', () => {
  it('makes a link of a six-character code, stored under a keyed hash', async () => {
    const { made, code } = await shortLink(rootId)
    expect(isShortCode(code)).toBe(true)
    const [row] = await app.db.select().from(shareLinks).where(eq(shareLinks.id, made.id))
    expect(row?.tokenHash).toEqual(await storedTokenHash(app.keys, code))
    expect(row?.tokenHash).not.toEqual(createHash('sha256').update(code).digest())
  })

  it('opens with the code as made and as typed in capitals with lookalikes', async () => {
    const { code } = await shortLink(rootId)
    for (const token of [code, typed(code)]) {
      expect(await stranger.call('GET', `/s/${token}`, publicShareSchema)).toMatchObject({
        locked: false,
        root: { id: rootId },
      })
    }
  })

  it('unlocks a password link typed with lookalikes for the code as made', async () => {
    const { code } = await shortLink(rootId, { password: 'open sesame' })
    const response = await stranger.fetch('POST', `/s/${typed(code)}/unlock`, {
      json: { password: 'open sesame' },
    })
    expect(response.status).toBe(204)
    expect(response.headers.getSetCookie().join('\n')).toContain(`Path=/api/s/${code};`)
  })

  it('still makes a long link when short is left out', async () => {
    const made = await owner.call('POST', '/shares', shareLinkSchema, {
      json: { nodeId: rootId, expiresAt: null, password: null, maxDownloads: null },
    })
    expect(made.url).toMatch(/\/s\/[\w-]{22}$/)
  })

  it('draws another code when one is taken', async () => {
    const terms = {
      nodeId: rootId,
      expiresAt: null,
      password: null,
      maxDownloads: null,
      short: true,
    }
    await createShare(app, ownerAuth, terms, () => 'aaaaaa')
    const codes = ['aaaaaa', 'bbbbbb']
    const second = await createShare(app, ownerAuth, terms, () => codes.shift() ?? 'cccccc')
    expect(second.url).toMatch(/\/s\/bbbbbb$/)
  })

  it('gives up after five codes in a row are taken', async () => {
    const terms = {
      nodeId: rootId,
      expiresAt: null,
      password: null,
      maxDownloads: null,
      short: true,
    }
    await createShare(app, ownerAuth, terms, () => 'dddddd')
    let draws = 0
    await expect(
      createShare(app, ownerAuth, terms, () => {
        draws += 1
        return 'dddddd'
      }),
    ).rejects.toThrow(Error)
    expect(draws).toBe(5)
  })
})
