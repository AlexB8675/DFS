import { ApiClient } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { adminSessionListSchema, sessionSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Admin → Access (DESIGN.md §9) with real sessions: an admin signs people
// out, but the owner's sessions are the owner's own.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let address: string
let origin: string
const endedSchema = z.object({ ended: z.number() })

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  origin = setup.config.publicBaseUrl
  app = await buildApp({ config: setup.config, logger: false })
  address = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, {
    username: 'owner',
    password: 'the-owner-password',
    isOwner: true,
    role: 'admin',
  })
  await seedUser(app.db, { username: 'helper', password: 'the-helper-password', role: 'admin' })
  await seedUser(app.db, { username: 'member', password: 'the-member-password' })
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

async function client(username: string): Promise<ApiClient> {
  const signedIn = new ApiClient(address, origin)
  await signedIn.signIn(username, `the-${username}-password`)
  return signedIn
}

describe('Admin → Access (§9)', () => {
  it('lists sessions with where they signed in from, and ends one', async () => {
    const owner = await client('owner')
    const member = await client('member')
    const sessions = await owner.call('GET', '/admin/sessions', adminSessionListSchema)
    const memberSession = sessions.find((session) => session.userName === 'member')
    expect(memberSession).toMatchObject({ ip: '127.0.0.1', limited: false, current: false })
    expect(sessions.filter((session) => session.current)).toHaveLength(1)

    await owner.send('DELETE', `/admin/sessions/${memberSession?.key ?? ''}`)
    expect(await member.error('GET', '/auth/me')).toEqual({ status: 401, code: 'unauthenticated' })
    await owner.call('GET', '/auth/me', sessionSchema)
  })

  it('keeps the owner’s sessions the owner’s, and an admin’s own current one', async () => {
    const owner = await client('owner')
    const helper = await client('helper')
    const sessions = await helper.call('GET', '/admin/sessions', adminSessionListSchema)
    const ownerKey = sessions.find((session) => session.userName === 'owner')?.key ?? ''
    const ownKey = sessions.find((session) => session.current)?.key ?? ''
    expect(await helper.error('DELETE', `/admin/sessions/${ownerKey}`)).toEqual({
      status: 409,
      code: 'owner_protected',
    })
    expect(await helper.error('DELETE', `/admin/sessions/${ownKey}`)).toEqual({
      status: 409,
      code: 'self_change',
    })
    const ownerUser = await owner.call('GET', '/auth/me', sessionSchema)
    expect(await helper.error('POST', `/admin/users/${ownerUser.user.id}/sign-out`)).toEqual({
      status: 409,
      code: 'owner_protected',
    })
  })

  it('signs a user out everywhere; an admin signing out themselves keeps this session', async () => {
    const owner = await client('owner')
    const phone = await client('member')
    const laptop = await client('member')
    const member = await phone.call('GET', '/auth/me', sessionSchema)
    const ended = await owner.call('POST', `/admin/users/${member.user.id}/sign-out`, endedSchema)
    expect(ended.ended).toBeGreaterThanOrEqual(2)
    for (const device of [phone, laptop]) {
      expect(await device.error('GET', '/auth/me')).toEqual({
        status: 401,
        code: 'unauthenticated',
      })
    }

    const elsewhere = await client('owner')
    const self = await owner.call('GET', '/auth/me', sessionSchema)
    await owner.call('POST', `/admin/users/${self.user.id}/sign-out`, endedSchema)
    await owner.call('GET', '/auth/me', sessionSchema)
    expect(await elsewhere.error('GET', '/auth/me')).toEqual({
      status: 401,
      code: 'unauthenticated',
    })
  })
})
