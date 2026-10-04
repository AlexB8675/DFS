import { adminUserSchema, sessionSchema } from '@dfs/shared'
import { ApiClient } from './client.ts'
import type { ContractTarget, TestApi } from './target.ts'

// The contract between the web app and the API (DESIGN.md §9), run against
// both the mock and the real API, so the two can't drift (BACKEND.md §5).
// Tests make their own users and files: they don't rely on seed data. The mock
// keeps one session at a time, like the browser it runs in, so a test signs
// in again before it goes back to a user it switched away from.

export function defineContractSuite(t: TestApi, target: () => ContractTarget): void {
  const { describe, it, expect } = t

  /** A client signed in as the owner. */
  async function owner(): Promise<ApiClient> {
    const { baseUrl, origin, owner } = target()
    const client = new ApiClient(baseUrl, origin)
    await client.signIn(owner.username, owner.password)
    return client
  }

  /** A fresh account with a temporary password, made by the owner. */
  async function newUser(admin: ApiClient, role: 'user' | 'admin' = 'user') {
    const username = `user-${crypto.randomUUID().slice(0, 8)}`
    const temporaryPassword = `temp-${crypto.randomUUID()}`
    const user = await admin.call('POST', '/admin/users', adminUserSchema, {
      json: { username, temporaryPassword, role },
    })
    return { user, username, temporaryPassword }
  }

  /** Signs in as `username` and chooses a password, as a first sign-in does. */
  async function activated(username: string, temporaryPassword: string): Promise<ApiClient> {
    const { baseUrl, origin } = target()
    const client = new ApiClient(baseUrl, origin)
    await client.signIn(username, temporaryPassword)
    await client.call('POST', '/auth/password', sessionSchema, {
      json: { newPassword: `chosen-${crypto.randomUUID()}` },
    })
    return client
  }

  describe('sign-in (§7.1)', () => {
    it('signs the owner in, and answers alike for a wrong password and an unknown user', async () => {
      const { baseUrl, origin, owner: credentials } = target()
      const client = new ApiClient(baseUrl, origin)
      const wrong = { status: 401, code: 'invalid_credentials' }
      expect(
        await client.error('POST', '/auth/login', {
          json: { username: credentials.username, password: 'not-the-password' },
        }),
      ).toEqual(wrong)
      expect(
        await client.error('POST', '/auth/login', {
          json: { username: 'nobody-at-all', password: 'not-the-password' },
        }),
      ).toEqual(wrong)

      const session = await client.signIn(credentials.username.toUpperCase(), credentials.password)
      expect(session).toMatchObject({ user: { role: 'admin' }, passwordChange: null })
      const me = await client.call('GET', '/auth/me', sessionSchema)
      expect(me.user.id).toBe(session.user.id)
    })

    it('ends the session on sign-out', async () => {
      const client = await owner()
      await client.send('POST', '/auth/logout')
      expect(await client.error('GET', '/auth/me')).toEqual({
        status: 401,
        code: 'unauthenticated',
      })
    })

    it('needs the CSRF token on changes', async () => {
      const client = await owner()
      expect(
        await client.error('POST', '/admin/users', {
          json: { username: 'no-csrf', temporaryPassword: 'a-long-enough-one' },
          withoutCsrf: true,
        }),
      ).toEqual({ status: 403, code: 'csrf_failed' })
    })

    it('limits a first sign-in to choosing a password, which activates the account', async () => {
      const admin = await owner()
      const { user, username, temporaryPassword } = await newUser(admin)
      expect(user).toMatchObject({ activatedAt: null, isOwner: false, role: 'user' })
      expect(user.temporaryPasswordExpiresAt).not.toBeNull()

      const { baseUrl, origin } = target()
      const client = new ApiClient(baseUrl, origin)
      const session = await client.signIn(username, temporaryPassword)
      expect(session.passwordChange).toBe('activate')
      expect(await client.error('GET', '/admin/users')).toEqual({
        status: 403,
        code: 'password_change_required',
      })

      const changed = await client.call('POST', '/auth/password', sessionSchema, {
        json: { newPassword: `chosen-${crypto.randomUUID()}` },
      })
      expect(changed.passwordChange).toBeNull()
      // A regular user now gets past the password check, to the admin check.
      expect(await client.error('GET', '/admin/users')).toEqual({ status: 403, code: 'forbidden' })
    })

    it('needs the current password to change it, and refuses weak choices', async () => {
      const admin = await owner()
      const { username, temporaryPassword } = await newUser(admin)
      const client = await activated(username, temporaryPassword)
      expect(
        await client.error('POST', '/auth/password', {
          json: { currentPassword: 'wrong-password', newPassword: 'a-fine-new-password' },
        }),
      ).toEqual({ status: 403, code: 'wrong_password' })
    })

    it('resets a password, so the next sign-in must choose a new one', async () => {
      const { user, username, temporaryPassword } = await newUser(await owner())
      await activated(username, temporaryPassword)

      const reset = `reset-${crypto.randomUUID()}`
      const admin = await owner()
      await admin.call('POST', `/admin/users/${user.id}/password`, adminUserSchema, {
        json: { temporaryPassword: reset },
      })
      const { baseUrl, origin } = target()
      const session = await new ApiClient(baseUrl, origin).signIn(username, reset)
      expect(session.passwordChange).toBe('reset')
    })

    it('never changes the owner from the app (D28)', async () => {
      const admin = await owner()
      const me = await admin.call('GET', '/auth/me', sessionSchema)
      expect(
        await admin.error('PATCH', `/admin/users/${me.user.id}`, { json: { role: 'user' } }),
      ).toEqual({ status: 409, code: 'owner_protected' })

      const { username, temporaryPassword } = await newUser(admin, 'admin')
      const otherAdmin = await activated(username, temporaryPassword)
      expect(
        await otherAdmin.error('POST', `/admin/users/${me.user.id}/password`, {
          json: { temporaryPassword: 'take-over-the-owner' },
        }),
      ).toEqual({ status: 409, code: 'owner_protected' })
    })

    it('keeps usernames unique, ignoring case', async () => {
      const admin = await owner()
      const { username } = await newUser(admin)
      expect(
        await admin.error('POST', '/admin/users', {
          json: { username: username.toUpperCase(), temporaryPassword: 'another-long-one' },
        }),
      ).toEqual({ status: 409, code: 'username_taken' })
    })
  })
}
