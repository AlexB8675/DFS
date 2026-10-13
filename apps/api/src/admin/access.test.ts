import { randomUUID } from 'node:crypto'
import { ApiClient } from '@dfs/contract'
import { auditLog, deviceTokens, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { adminDeviceListSchema, adminSessionListSchema, sessionSchema } from '@dfs/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../app.ts'
import { findDevice, hashSecret, newDeviceToken } from '../devices/devices.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Admin → Access (DESIGN.md §9) with real sessions and devices: an admin
// signs people out and removes their devices, but the owner's sessions and
// devices are the owner's own.

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

/** A device of `username`, made directly: pairing is tested with the devices themselves. */
async function addDevice(
  username: string,
  name: string,
  createdAt?: Date,
): Promise<{ id: string; userId: string; token: string }> {
  const [user] = await app.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
  const token = newDeviceToken()
  const [made] = await app.db
    .insert(deviceTokens)
    .values({ userId: user?.id ?? '', name, tokenHash: hashSecret(token), createdAt })
    .returning({ id: deviceTokens.id, userId: deviceTokens.userId })
  if (!made) throw new Error('The device was not made.')
  return { ...made, token }
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
    const ownerSession = sessions.find((session) => session.userName === 'owner')
    const ownKey = sessions.find((session) => session.current)?.key ?? ''
    const ownerKey = ownerSession?.key ?? ''
    // The page offers only what the API allows.
    const owners = sessions.filter((session) => session.userName === 'owner')
    expect(owners.length).toBeGreaterThan(0)
    expect(owners.some((session) => session.canSignOut)).toBe(false)
    expect(sessions.find((session) => session.current)?.canSignOut).toBe(false)
    const asOwner = await owner.call('GET', '/admin/sessions', adminSessionListSchema)
    const elsewhere = asOwner.find((session) => session.userName === 'owner' && !session.current)
    expect(elsewhere?.canSignOut).toBe(true)
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

  it('lists devices beside sessions, for everyone or one user', async () => {
    const owner = await client('owner')
    const helper = await client('helper')
    const ownerLaptop = await addDevice('owner', 'Owner laptop')
    const memberOld = await addDevice('member', 'Member old PC', new Date(Date.now() - 3_600_000))
    const memberPc = await addDevice('member', 'Member PC')

    const all = await helper.call('GET', '/admin/devices', adminDeviceListSchema)
    const names = all.map((device) => device.name)
    expect(names).toEqual(expect.arrayContaining(['Owner laptop', 'Member PC', 'Member old PC']))
    // Newest first.
    expect(names.indexOf('Member PC')).toBeLessThan(names.indexOf('Member old PC'))
    expect(all.find((device) => device.id === memberPc.id)).toMatchObject({
      userId: memberPc.userId,
      username: 'member',
      displayName: 'member',
      lastUsedAt: null,
      lastAddress: null,
      lastAgent: null,
      canRemove: true,
    })
    // The page offers only what the API allows: the owner's are the owner's to remove.
    expect(all.find((device) => device.id === ownerLaptop.id)).toMatchObject({
      username: 'owner',
      canRemove: false,
    })
    // The token is never shown, nor anything that could find it.
    expect(JSON.stringify(all)).not.toContain(memberPc.token)
    expect(Object.keys(all[0] ?? {})).not.toContain('tokenHash')

    const theirs = await helper.call(
      'GET',
      `/admin/devices?userId=${memberPc.userId}`,
      adminDeviceListSchema,
    )
    expect(theirs.map((device) => device.id)).toEqual(
      expect.arrayContaining([memberPc.id, memberOld.id]),
    )
    expect(theirs.every((device) => device.userId === memberPc.userId)).toBe(true)

    const asOwner = await owner.call('GET', '/admin/devices', adminDeviceListSchema)
    expect(asOwner.find((device) => device.id === ownerLaptop.id)?.canRemove).toBe(true)
  })

  it('removes a device, ending its token', async () => {
    const helper = await client('helper')
    const laptop = await addDevice('member', 'Removed laptop')
    expect(await findDevice(app.db, laptop.token)).not.toBeNull()

    await helper.send('DELETE', `/admin/devices/${laptop.id}`)
    expect(await findDevice(app.db, laptop.token)).toBeNull()
    const rows = await app.db.select().from(deviceTokens).where(eq(deviceTokens.id, laptop.id))
    expect(rows).toEqual([])
    const [helperUser] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'helper'))
    const audited = await app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'device.removed'), eq(auditLog.userId, helperUser?.id ?? '')))
    expect(audited).toHaveLength(1)
    expect(audited[0]?.meta).toEqual({ target: 'Removed laptop', details: '@member' })

    // An admin may remove their own device: there is no session to keep here.
    const own = await addDevice('helper', 'Helper desktop')
    await helper.send('DELETE', `/admin/devices/${own.id}`)
    expect(await findDevice(app.db, own.token)).toBeNull()
  })

  it('only the owner removes the owner’s devices', async () => {
    const owner = await client('owner')
    const helper = await client('helper')
    const laptop = await addDevice('owner', 'Owner tablet')
    expect(await helper.error('DELETE', `/admin/devices/${laptop.id}`)).toEqual({
      status: 409,
      code: 'owner_protected',
    })
    expect(await findDevice(app.db, laptop.token)).not.toBeNull()

    await owner.send('DELETE', `/admin/devices/${laptop.id}`)
    expect(await findDevice(app.db, laptop.token)).toBeNull()
  })

  it('is for admins only', async () => {
    const member = await client('member')
    const laptop = await addDevice('member', 'Own laptop')
    expect(await member.error('GET', '/admin/devices')).toEqual({ status: 403, code: 'forbidden' })
    expect(await member.error('DELETE', `/admin/devices/${laptop.id}`)).toEqual({
      status: 403,
      code: 'forbidden',
    })
    expect(await findDevice(app.db, laptop.token)).not.toBeNull()
  })

  it('answers not_found for a device that doesn’t exist', async () => {
    const owner = await client('owner')
    const notFound = { status: 404, code: 'not_found' }
    expect(await owner.error('DELETE', `/admin/devices/${randomUUID()}`)).toEqual(notFound)
    // One that was removed a moment ago is as gone.
    const laptop = await addDevice('member', 'Gone laptop')
    await owner.send('DELETE', `/admin/devices/${laptop.id}`)
    expect(await owner.error('DELETE', `/admin/devices/${laptop.id}`)).toEqual(notFound)
  })
})
