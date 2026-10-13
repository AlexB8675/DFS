import {
  adminDeviceListSchema,
  adminUserSchema,
  auditPageSchema,
  deviceListSchema,
  deviceMeSchema,
  deviceTokenSchema,
  pairingCodeSchema,
  sessionSchema,
} from '@dfs/shared'
import { ApiClient, type RequestOptions } from './client.ts'
import { chosenPassword, type SuiteContext } from './context.ts'

/** Base64url without padding, the form PKCE and device tokens use (RFC 7636 S256). */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

/** A PKCE verifier: 64 characters of the allowed alphabet, as an app would make. */
function newVerifier(): string {
  return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** A device call's options: the token in the header, and no cookie, as an app sends it. */
function bearer(token: string): RequestOptions {
  return { headers: { authorization: `Bearer ${token}` } }
}

/** Device tokens, for the backup app on a computer (DESIGN.md §7.6). */
export function deviceTests({
  describe,
  it,
  expect,
  target,
  owner,
  newUser,
  activated,
  signIn,
}: SuiteContext): void {
  /** What the app is: a client with no session, which only ever sends a token. */
  function app(): ApiClient {
    const { baseUrl, origin } = target()
    return new ApiClient(baseUrl, origin)
  }

  /** A user who chose their password, signed in. */
  async function activatedUser(role: 'user' | 'admin' = 'user') {
    const { user, username, temporaryPassword } = await newUser(await owner(), role)
    const client = await activated(username, temporaryPassword)
    return { user, username, client }
  }

  /** The user approves a backup app, which then trades the code for its token. */
  async function pairDevice(user: ApiClient, name: string) {
    const verifier = newVerifier()
    const { code } = await user.call('POST', '/devices/pair', pairingCodeSchema, {
      json: { name, challenge: await challengeOf(verifier) },
    })
    return { code, verifier }
  }

  async function pairedToken(user: ApiClient, name: string) {
    const { code, verifier } = await pairDevice(user, name)
    return app().call('POST', '/devices/token', deviceTokenSchema, { json: { code, verifier } })
  }

  const unauthenticated = { status: 401, code: 'unauthenticated' }
  const invalidToken = { status: 401, code: 'invalid_token' }

  describe('device tokens (§7.6)', () => {
    it('pairs a device and reaches /devices/me with its token, which only device routes take', async () => {
      const { user, username, client } = await activatedUser()
      const { code, verifier } = await pairDevice(client, '  Studio PC ')
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

      // The app has no session and no CSRF token: the code and verifier are the proof.
      const paired = await app().call('POST', '/devices/token', deviceTokenSchema, {
        json: { code, verifier },
      })
      expect(paired.token).toMatch(/^dfs_[A-Za-z0-9_-]{43}$/)
      expect(paired.device.name).toBe('Studio PC')

      const device = app()
      expect(await device.call('GET', '/devices/me', deviceMeSchema, bearer(paired.token))).toEqual(
        {
          device: paired.device,
          user: { id: user.id, username, displayName: user.displayName },
        },
      )

      // A token and a session never stand in for each other.
      expect(await device.error('GET', '/devices', bearer(paired.token))).toEqual(unauthenticated)
      expect(await client.error('GET', '/devices/me')).toEqual(unauthenticated)
      expect(await device.error('GET', '/devices/me')).toEqual(unauthenticated)
      expect(
        await device.error('GET', '/devices/me', { headers: { authorization: 'Basic abc' } }),
      ).toEqual(unauthenticated)
    })

    it('a pairing code works once, and a wrong verifier uses it up', async () => {
      const { client } = await activatedUser()
      const invalidPairing = { status: 400, code: 'invalid_pairing' }

      const first = await pairDevice(client, 'Laptop')
      await app().call('POST', '/devices/token', deviceTokenSchema, { json: first })
      expect(await app().error('POST', '/devices/token', { json: first })).toEqual(invalidPairing)

      // A guess at the verifier gets no second try with the right one.
      const second = await pairDevice(client, 'Desktop')
      expect(
        await app().error('POST', '/devices/token', {
          json: { code: second.code, verifier: newVerifier() },
        }),
      ).toEqual(invalidPairing)
      expect(await app().error('POST', '/devices/token', { json: second })).toEqual(invalidPairing)

      // A code that was never made is no different.
      expect(
        await app().error('POST', '/devices/token', {
          json: {
            code: base64url(crypto.getRandomValues(new Uint8Array(32))),
            verifier: first.verifier,
          },
        }),
      ).toEqual(invalidPairing)
      expect(await client.call('GET', '/devices', deviceListSchema)).toHaveLength(1)
    })

    it('refuses an unknown token with invalid_token', async () => {
      const unknown = `dfs_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
      expect(await app().error('GET', '/devices/me', bearer(unknown))).toEqual(invalidToken)
      // Not even shaped like a token: nothing to look up.
      expect(await app().error('GET', '/devices/me', bearer('not-a-token'))).toEqual(
        unauthenticated,
      )
    })

    it('lists and removes a user’s own devices; removed, its token stops working', async () => {
      const { client, username } = await activatedUser()
      const laptop = await pairedToken(client, 'Laptop')
      const desktop = await pairedToken(client, 'Desktop')
      await app().call('GET', '/devices/me', deviceMeSchema, bearer(laptop.token))

      // Newest first; a device that was used says when, and one that wasn't says nothing.
      const listed = await client.call('GET', '/devices', deviceListSchema)
      expect(listed.map((device) => device.name)).toEqual(['Desktop', 'Laptop'])
      expect(listed[0]).toMatchObject({ id: desktop.device.id, lastUsedAt: null })
      expect(listed[1]?.lastUsedAt).not.toBeNull()
      expect(JSON.stringify(listed)).not.toContain(laptop.token)

      // Someone else's device, and one that isn't there, are alike.
      const other = await activatedUser()
      const othersDevice = await pairedToken(other.client, 'Theirs')
      const again = await signIn(username, chosenPassword(username))
      const notFound = { status: 404, code: 'not_found' }
      expect(await again.error('DELETE', `/devices/${othersDevice.device.id}`)).toEqual(notFound)
      expect(await again.error('DELETE', `/devices/${crypto.randomUUID()}`)).toEqual(notFound)
      await app().call('GET', '/devices/me', deviceMeSchema, bearer(othersDevice.token))

      await again.send('DELETE', `/devices/${laptop.device.id}`)
      expect(await app().error('GET', '/devices/me', bearer(laptop.token))).toEqual(invalidToken)
      expect((await again.call('GET', '/devices', deviceListSchema)).map((d) => d.name)).toEqual([
        'Desktop',
      ])
      await app().call('GET', '/devices/me', deviceMeSchema, bearer(desktop.token))
      expect(await again.error('DELETE', `/devices/${laptop.device.id}`)).toEqual(notFound)
    })

    it('admins list and remove anyone’s devices', async () => {
      const { user, username, client } = await activatedUser()
      const paired = await pairedToken(client, 'Office PC')
      const kept = await pairedToken(client, 'Kitchen PC')

      // Only admins reach the list.
      expect(await client.error('GET', '/admin/devices')).toEqual({
        status: 403,
        code: 'forbidden',
      })

      const admin = await owner()
      const listed = await admin.call(
        'GET',
        `/admin/devices?userId=${user.id}`,
        adminDeviceListSchema,
      )
      expect(listed.map((device) => device.name)).toEqual(['Kitchen PC', 'Office PC'])
      expect(listed[1]).toMatchObject({
        id: paired.device.id,
        userId: user.id,
        username,
        displayName: user.displayName,
        canRemove: true,
      })
      // Every user's, when no one is asked for.
      const everyone = await admin.call('GET', '/admin/devices', adminDeviceListSchema)
      expect(everyone.map((device) => device.id)).toContain(paired.device.id)
      expect(JSON.stringify(everyone)).not.toContain(paired.token)

      await admin.send('DELETE', `/admin/devices/${paired.device.id}`)
      expect(await app().error('GET', '/devices/me', bearer(paired.token))).toEqual(invalidToken)
      await app().call('GET', '/devices/me', deviceMeSchema, bearer(kept.token))
      expect(await admin.error('DELETE', `/admin/devices/${paired.device.id}`)).toEqual({
        status: 404,
        code: 'not_found',
      })

      // The log notes who paired it and who removed it, and whose it was.
      const log = await admin.call('GET', '/admin/audit?actions=device.', auditPageSchema)
      const entry = (action: string) =>
        log.items.find((item) => item.action === action && item.target === 'Office PC')
      expect(entry('device.paired')).toMatchObject({ actorName: user.displayName })
      const { user: signedIn } = await admin.call('GET', '/auth/me', sessionSchema)
      expect(entry('device.removed')).toMatchObject({
        actorName: signedIn.displayName,
        details: `@${username}`,
      })
    })

    it('keeps the owner’s devices from other admins', async () => {
      const admin = await owner()
      const mine = await pairedToken(admin, 'Owner PC')
      const { client: otherAdmin } = await activatedUser('admin')

      const seen = await otherAdmin.call('GET', '/admin/devices', adminDeviceListSchema)
      expect(seen.find((device) => device.id === mine.device.id)?.canRemove).toBe(false)
      expect(await otherAdmin.error('DELETE', `/admin/devices/${mine.device.id}`)).toEqual({
        status: 409,
        code: 'owner_protected',
      })
      await app().call('GET', '/devices/me', deviceMeSchema, bearer(mine.token))

      // The owner may remove their own.
      const again = await owner()
      const asOwner = await again.call('GET', '/admin/devices', adminDeviceListSchema)
      expect(asOwner.find((device) => device.id === mine.device.id)?.canRemove).toBe(true)
      await again.send('DELETE', `/admin/devices/${mine.device.id}`)
      expect(await app().error('GET', '/devices/me', bearer(mine.token))).toEqual(invalidToken)
    })

    it('changing the password ends the user’s devices', async () => {
      const { username, client } = await activatedUser()
      const device = await pairedToken(client, 'Studio PC')
      await app().call('GET', '/devices/me', deviceMeSchema, bearer(device.token))

      await client.call('POST', '/auth/password', sessionSchema, {
        json: {
          currentPassword: chosenPassword(username),
          newPassword: `changed-${crypto.randomUUID()}`,
        },
      })
      expect(await app().error('GET', '/devices/me', bearer(device.token))).toEqual(invalidToken)
      expect(await client.call('GET', '/devices', deviceListSchema)).toEqual([])
    })

    it('an admin’s reset, disabling or sign-out of a user ends their devices', async () => {
      const ends = [
        // Resets the password.
        (admin: ApiClient, userId: string) =>
          admin.call('POST', `/admin/users/${userId}/password`, adminUserSchema, {
            json: { temporaryPassword: `reset-${crypto.randomUUID()}` },
          }),
        // Disables the account.
        (admin: ApiClient, userId: string) =>
          admin.call('PATCH', `/admin/users/${userId}`, adminUserSchema, {
            json: { disabled: true },
          }),
        // Signs them out everywhere.
        (admin: ApiClient, userId: string) => admin.send('POST', `/admin/users/${userId}/sign-out`),
      ]
      for (const end of ends) {
        const { user, client } = await activatedUser()
        const device = await pairedToken(client, 'Studio PC')
        // A code not yet traded is a chance for a token, and goes too.
        const pending = await pairDevice(client, 'Not yet')
        await app().call('GET', '/devices/me', deviceMeSchema, bearer(device.token))

        await end(await owner(), user.id)
        expect(await app().error('GET', '/devices/me', bearer(device.token))).toEqual(invalidToken)
        expect(await app().error('POST', '/devices/token', { json: pending })).toEqual({
          status: 400,
          code: 'invalid_pairing',
        })
      }
    })
  })
}
