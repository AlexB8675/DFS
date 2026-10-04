import { ApiClient } from '@dfs/contract'
import { users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { adminUserSchema } from '@dfs/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { hashPassword, verifyPassword } from './passwords.ts'

// What the real API does beyond the shared contract (DESIGN.md §7.1).

let database: TestDatabase
let app: FastifyInstance
let address: string
let origin: string

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const { config } = await testConfig({ DATABASE_URL: database.url })
  app = await buildApp({ config, logger: false })
  address = await app.listen({ port: 0, host: '127.0.0.1' })
  origin = config.publicBaseUrl
  await seedUser(app.db, {
    username: 'owner',
    password: 'the-owner-password',
    role: 'admin',
    isOwner: true,
  })
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

const client = () => new ApiClient(address, origin)

describe('passwords', () => {
  it('hash to argon2id PHC strings and verify', async () => {
    const phc = await hashPassword('correct horse battery')
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
    expect(await verifyPassword(phc, 'correct horse battery')).toBe(true)
    expect(await verifyPassword(phc, 'correct horse batterY')).toBe(false)
    expect(await verifyPassword('not a hash', 'x')).toBe(false)
  })
})

describe('sign-in protection', () => {
  it('accepts sign-in only from our own pages', async () => {
    const stranger = new ApiClient(address, 'https://evil.example')
    expect(
      await stranger.error('POST', '/auth/login', {
        json: { username: 'owner', password: 'the-owner-password' },
      }),
    ).toEqual({ status: 403, code: 'forbidden_origin' })
  })

  it('sets an HttpOnly, SameSite=Lax session cookie', async () => {
    const response = await client().fetch('POST', '/auth/login', {
      json: { username: 'owner', password: 'the-owner-password' },
    })
    const [cookie = ''] = response.headers.getSetCookie()
    expect(cookie).toMatch(/^dfs_session=[\w-]{43};/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
  })

  it('counts only failed sign-ins against an address', async () => {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      await client().signIn('owner', 'the-owner-password')
    }
  })

  it('makes an account wait after 10 failures in a row, even for the right password', async () => {
    await seedUser(app.db, { username: 'guessed', password: 'the-real-password' })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        await client().error('POST', '/auth/login', {
          json: { username: 'guessed', password: `guess-${String(attempt)}` },
        }),
      ).toMatchObject({ status: 401 })
    }
    const locked = await client().fetch('POST', '/auth/login', {
      json: { username: 'guessed', password: 'the-real-password' },
    })
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)

    await app.db
      .update(users)
      .set({ signInLockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.username, 'guessed'))
    await client().signIn('guessed', 'the-real-password')
    const [after] = await app.db.select().from(users).where(eq(users.username, 'guessed'))
    expect(after?.failedSignIns).toBe(0)
  })

  it('ends a disabled user’s sessions at once', async () => {
    await seedUser(app.db, { username: 'leaving', password: 'leaving-password' })
    const user = client()
    await user.signIn('leaving', 'leaving-password')

    const admin = client()
    await admin.signIn('owner', 'the-owner-password')
    const [row] = await app.db.select().from(users).where(eq(users.username, 'leaving'))
    await admin.call('PATCH', `/admin/users/${row?.id ?? ''}`, adminUserSchema, {
      json: { disabled: true },
    })
    expect(await user.error('GET', '/auth/me')).toEqual({ status: 401, code: 'unauthenticated' })
  })
})
