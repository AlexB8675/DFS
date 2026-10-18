import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApiClient, workspace } from '@dfs/contract'
import { shareLinks, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { isShortCode, publicShareSchema, shareLinkSchema } from '@dfs/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { createFolder } from '../nodes/write.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { createShare } from './shares.ts'
import { storedTokenHash } from './tokens.ts'

let database: TestDatabase
let setup: Awaited<ReturnType<typeof testConfig>>
let app: FastifyInstance
let owner: ApiClient
let stranger: ApiClient
let ownerAuth: Auth
let rootId: string

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
  await setup.cleanup()
})

/** The terms of a short link to `nodeId`, as `createShare` takes them. */
const shortTerms = (nodeId: string, password: string | null = null) => ({
  nodeId,
  expiresAt: null,
  password,
  maxDownloads: null,
  short: true,
})

async function shortLink(nodeId: string) {
  const made = await owner.call('POST', '/shares', shareLinkSchema, {
    json: shortTerms(nodeId),
  })
  return { made, code: made.url?.split('/s/')[1] ?? '' }
}

/**
 * A short link to the root folder with this code, drawn through the seam so
 * the tests of lookalikes always have a letter, a 0 and a 1 to mistake. The
 * code is read back from the link's address.
 */
async function fixedLink(code: string, password: string | null = null): Promise<string> {
  const made = await createShare(app, ownerAuth, shortTerms(rootId, password), () => code)
  const madeCode = made.url?.split('/s/')[1] ?? ''
  expect(madeCode).toBe(code)
  return madeCode
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
    const code = await fixedLink('k0h-1q')
    expect(typed(code)).toBe('KOH-IQ')
    for (const token of [code, typed(code)]) {
      expect(await stranger.call('GET', `/s/${token}`, publicShareSchema)).toMatchObject({
        locked: false,
        root: { id: rootId },
      })
    }
  })

  it('unlocks a password link typed with lookalikes for the code as made', async () => {
    const code = await fixedLink('p1z-0w', 'open sesame')
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
    const terms = shortTerms(rootId)
    await createShare(app, ownerAuth, terms, () => 'aaaaaa')
    const codes = ['aaaaaa', 'bbbbbb']
    const second = await createShare(app, ownerAuth, terms, () => codes.shift() ?? 'cccccc')
    expect(second.url).toMatch(/\/s\/bbbbbb$/)
  })

  it('gives up after five codes in a row are taken', async () => {
    const terms = shortTerms(rootId)
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

  it('counts a code taken under a retired master key as taken, and still finds it', async () => {
    // A second app on the same database, whose key file holds the first app's
    // key as retired and a new key as current (a master-key rotation).
    const first = JSON.parse(await readFile(path.join(setup.dir, 'master-key.json'), 'utf8')) as {
      keys: Record<string, string>
    }
    const keyDir = await mkdtemp(path.join(tmpdir(), 'dfs-rotated-'))
    const keyFile = path.join(keyDir, 'master-key.json')
    await writeFile(
      keyFile,
      JSON.stringify({
        current: 'k2',
        keys: { ...first.keys, k2: randomBytes(32).toString('base64') },
      }),
    )
    const rotated = await testConfig({ DATABASE_URL: database.url, MASTER_KEY_FILE: keyFile })
    const second = await buildApp({ config: rotated.config, logger: false })
    try {
      const address = await second.listen({ port: 0, host: '127.0.0.1' })
      const visitor = new ApiClient(address, rotated.config.publicBaseUrl)
      const folder = await createFolder(app, ownerAuth, rootId, 'Made after the rotation')
      await createShare(app, ownerAuth, shortTerms(rootId), () => 'eeeeee')
      // The first app's link is under the retired key, so `eeeeee` is taken
      // although the unique index, keyed by the current key, can't see it.
      const draws = ['eeeeee', 'ffffff']
      const made = await createShare(
        second,
        ownerAuth,
        shortTerms(folder.id),
        () => draws.shift() ?? 'gggggg',
      )
      expect(made.url).toMatch(/\/s\/ffffff$/)
      expect(await visitor.call('GET', '/s/eeeeee', publicShareSchema)).toMatchObject({
        root: { id: rootId },
      })
      expect(await visitor.call('GET', '/s/ffffff', publicShareSchema)).toMatchObject({
        root: { id: folder.id },
      })
    } finally {
      await second.close()
      await rotated.cleanup()
      await rm(keyDir, { recursive: true, force: true })
    }
  })
})
