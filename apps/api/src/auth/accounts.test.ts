import { sessions, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { changePassword, signIn } from './accounts.ts'
import type * as PasswordModule from './passwords.ts'
import { hashPassword, verifyPassword } from './passwords.ts'
import { endUserSessions, findSession, openSession, type UserRow } from './sessions.ts'

vi.mock('./passwords.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>()
  return {
    ...actual,
    hashPassword: vi.fn(actual.hashPassword),
    verifyPassword: vi.fn(actual.verifyPassword),
  }
})

let database: TestDatabase
let app: FastifyInstance
let setup: Awaited<ReturnType<typeof testConfig>>

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  setup = await testConfig({ DATABASE_URL: database.url })
  app = await buildApp({ config: setup.config, logger: false })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await setup.cleanup()
})

beforeEach(async () => {
  const actual = await vi.importActual<typeof PasswordModule>('./passwords.ts')
  vi.mocked(hashPassword).mockReset().mockImplementation(actual.hashPassword)
  vi.mocked(verifyPassword).mockReset()
})

async function account(username: string) {
  await seedUser(app.db, { username, password: 'the-original-password' })
  const [user] = await app.db.select().from(users).where(eq(users.username, username))
  if (!user) throw new Error('No account seeded.')
  return user
}

function heldVerification() {
  const entered = Promise.withResolvers<undefined>()
  const result = Promise.withResolvers<boolean>()
  vi.mocked(verifyPassword).mockImplementation(() => {
    entered.resolve(undefined)
    return result.promise
  })
  return { entered: entered.promise, release: result.resolve }
}

async function authenticated(user: UserRow) {
  const opened = await openSession(app.db, user)
  const auth = await findSession(app.db, opened.token)
  if (!auth) throw new Error('No session opened.')
  return auth
}

describe('sign-in races', () => {
  it('counts every concurrent failure and computes the lock from the current count', async () => {
    const user = await account('concurrent-failures')
    const verification = heldVerification()
    const attempts = Array.from({ length: 12 }, (_, index) =>
      signIn(app, { username: user.username, password: 'wrong' }, `address-${String(index)}`).then(
        () => null,
        (error: unknown) => error,
      ),
    )
    await vi.waitFor(() => {
      expect(verifyPassword).toHaveBeenCalledTimes(12)
    })
    verification.release(false)
    for (const outcome of await Promise.all(attempts)) {
      expect(outcome).toMatchObject({ status: 401, code: 'invalid_credentials' })
    }

    const [current] = await app.db.select().from(users).where(eq(users.id, user.id))
    expect(current?.failedSignIns).toBe(12)
    const remaining = (current?.signInLockedUntil?.getTime() ?? 0) - Date.now()
    expect(remaining).toBeGreaterThan(235_000)
    expect(remaining).toBeLessThanOrEqual(240_000)
  })

  it('caps the lock even after a large number of failures', async () => {
    const user = await account('many-failures')
    await app.db.update(users).set({ failedSignIns: 1000 }).where(eq(users.id, user.id))
    vi.mocked(verifyPassword).mockResolvedValue(false)
    await expect(
      signIn(app, { username: user.username, password: 'wrong' }, 'address'),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' })

    const [current] = await app.db.select().from(users).where(eq(users.id, user.id))
    expect(current?.failedSignIns).toBe(1001)
    const remaining = (current?.signInLockedUntil?.getTime() ?? 0) - Date.now()
    expect(remaining).toBeGreaterThan(3_595_000)
    expect(remaining).toBeLessThanOrEqual(3_600_000)
  })

  it.each([
    ['disabled', () => ({ disabledAt: new Date() }), 403, 'account_disabled'],
    [
      'expired',
      () => ({ passwordExpiresAt: new Date(Date.now() - 1000) }),
      403,
      'password_expired',
    ],
    ['locked', () => ({ signInLockedUntil: new Date(Date.now() + 60_000) }), 429, 'rate_limited'],
  ] as const)(
    'does not sign in an account %s while its password is being checked',
    async (name, changes, status, code) => {
      const user = await account(`became-${name}`)
      const verification = heldVerification()
      const outcome = signIn(
        app,
        { username: user.username, password: 'the-original-password' },
        'address',
      ).then(
        () => null,
        (error: unknown) => error,
      )
      await verification.entered
      await app.db.update(users).set(changes()).where(eq(users.id, user.id))
      verification.release(true)

      expect(await outcome).toMatchObject({ status, code })
      const opened = await app.db.select().from(sessions).where(eq(sessions.userId, user.id))
      expect(opened).toHaveLength(0)
    },
  )

  it('does not open a session with a password replaced during verification', async () => {
    const user = await account('password-replaced')
    const verification = heldVerification()
    const outcome = signIn(
      app,
      { username: user.username, password: 'the-original-password' },
      'address',
    ).then(
      () => null,
      (error: unknown) => error,
    )
    await verification.entered
    const passwordHash = await hashPassword('the-replacement-password')
    await app.db.update(users).set({ passwordHash }).where(eq(users.id, user.id))
    verification.release(true)

    expect(await outcome).toMatchObject({ status: 401, code: 'invalid_credentials' })
    const opened = await app.db.select().from(sessions).where(eq(sessions.userId, user.id))
    expect(opened).toHaveLength(0)
  })
})

describe('password-change races', () => {
  it('keeps an admin reset made while the original password is being verified', async () => {
    const user = await account('reset-during-change')
    const auth = await authenticated(user)
    const verification = heldVerification()
    const outcome = changePassword(app, auth, {
      currentPassword: 'the-original-password',
      newPassword: 'the-user-chosen-password',
    }).then(
      () => null,
      (error: unknown) => error,
    )
    await verification.entered
    const passwordHash = await hashPassword('the-admin-reset-password')
    await app.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, passwordExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(users.id, user.id))
      await endUserSessions(tx, user.id)
    })
    verification.release(true)

    expect(await outcome).toMatchObject({ status: 401, code: 'unauthenticated' })
    const [current] = await app.db.select().from(users).where(eq(users.id, user.id))
    expect(current?.passwordHash).toBe(passwordHash)
    const opened = await app.db.select().from(sessions).where(eq(sessions.userId, user.id))
    expect(opened).toHaveLength(0)
  })

  it('does not change a password or open a session after disabling during hashing', async () => {
    const user = await account('disabled-during-change')
    const auth = await authenticated(user)
    const chosenHash = await hashPassword('the-user-chosen-password')
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const entered = Promise.withResolvers<undefined>()
    const hashed = Promise.withResolvers<string>()
    vi.mocked(hashPassword).mockImplementation(() => {
      entered.resolve(undefined)
      return hashed.promise
    })
    const outcome = changePassword(app, auth, {
      currentPassword: 'the-original-password',
      newPassword: 'the-user-chosen-password',
    }).then(
      () => null,
      (error: unknown) => error,
    )
    await entered.promise
    await app.db.transaction(async (tx) => {
      await tx.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
      await endUserSessions(tx, user.id)
    })
    hashed.resolve(chosenHash)

    expect(await outcome).toMatchObject({ status: 401, code: 'unauthenticated' })
    const [current] = await app.db.select().from(users).where(eq(users.id, user.id))
    expect(current?.passwordHash).toBe(user.passwordHash)
    const opened = await app.db.select().from(sessions).where(eq(sessions.userId, user.id))
    expect(opened).toHaveLength(0)
  })
})
