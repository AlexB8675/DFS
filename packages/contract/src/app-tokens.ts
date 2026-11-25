import {
  adminAppTokenListSchema,
  adminUserSchema,
  appTokenListSchema,
  madeAppTokenSchema,
  sessionSchema,
} from '@dfs/shared'
import type { ApiClient } from './client.ts'
import { chosenPassword, type SuiteContext } from './context.ts'
import { createFolder, text, uploadFile, workspace } from './files.ts'

/** App tokens, for an agent or a script that reaches one folder (DESIGN.md §7.8). */
export function appTokenTests({
  describe,
  it,
  expect,
  owner,
  newUser,
  activated,
  signIn,
}: SuiteContext): void {
  async function activatedUser(role: 'user' | 'admin' = 'user') {
    const { user, username, temporaryPassword } = await newUser(await owner(), role)
    const client = await activated(username, temporaryPassword)
    return { user, username, client }
  }

  function make(client: ApiClient, folderId: string, name: string, canWrite = false) {
    return client.call('POST', '/app-tokens', madeAppTokenSchema, {
      json: { name, folderId, canWrite },
    })
  }

  const notFound = { status: 404, code: 'not_found' }

  // The mock has no vault or Backups tree, so those refusals are tested only in apps/api/src/app-tokens/tokens.test.ts.

  describe('app tokens (§7.8)', () => {
    it('makes a token for a folder, shown once, with where the folder is', async () => {
      const { client } = await activatedUser()
      const root = await workspace(client)
      const notes = await createFolder(client, root.id, 'Notes')

      const { token, appToken } = await make(client, notes.id, '  Agent  ', true)
      expect(token).toMatch(/^dfs_app_[A-Za-z0-9_-]{43}$/)
      expect(appToken).toMatchObject({
        name: 'Agent',
        folderId: notes.id,
        folderPath: `My Drive / ${root.name} / Notes`,
        folderAvailable: true,
        canWrite: true,
        lastUsedAt: null,
      })

      const listed = await client.call('GET', '/app-tokens', appTokenListSchema)
      expect(listed).toEqual([appToken])
      expect(JSON.stringify(listed)).not.toContain(token)
    })

    it('needs a folder of the user’s own that isn’t in the trash', async () => {
      // The mock keeps one session: the user the test acts as signs in last.
      const other = await activatedUser()
      const theirs = await workspace(other.client)
      const { client } = await activatedUser()
      const root = await workspace(client)
      const file = await uploadFile(client, root.id, 'a.txt', text('hello'))
      const trashed = await createFolder(client, root.id, 'Gone')
      await client.send('POST', '/nodes/trash', { json: { ids: [trashed.id] } })
      const body = (folderId: string) => ({ json: { name: 'App', folderId, canWrite: false } })

      expect(await client.error('POST', '/app-tokens', body(file.nodeId))).toEqual({
        status: 400,
        code: 'not_a_folder',
      })
      expect(await client.error('POST', '/app-tokens', body(trashed.id))).toEqual(notFound)
      expect(await client.error('POST', '/app-tokens', body(theirs.id))).toEqual(notFound)
      expect(await client.error('POST', '/app-tokens', body(crypto.randomUUID()))).toEqual(notFound)
      expect(await client.call('GET', '/app-tokens', appTokenListSchema)).toEqual([])
    })

    it('lists newest first, and says when a folder is no longer there', async () => {
      const { client } = await activatedUser()
      const root = await workspace(client)
      const first = await createFolder(client, root.id, 'First')
      const second = await createFolder(client, root.id, 'Second')
      await make(client, first.id, 'Old')
      await make(client, second.id, 'New')

      const listed = await client.call('GET', '/app-tokens', appTokenListSchema)
      expect(listed.map((token) => token.name)).toEqual(['New', 'Old'])
      expect(listed.map((token) => token.folderAvailable)).toEqual([true, true])

      await client.send('POST', '/nodes/trash', { json: { ids: [second.id] } })
      const after = await client.call('GET', '/app-tokens', appTokenListSchema)
      expect(after.map((token) => [token.name, token.folderAvailable])).toEqual([
        ['New', false],
        ['Old', true],
      ])
    })

    it('removes a user’s own token, and no one else’s', async () => {
      const other = await activatedUser()
      const { client, username } = await activatedUser()
      const root = await workspace(client)
      const keep = await make(client, root.id, 'Keep')
      const drop = await make(client, root.id, 'Drop')

      const theirs = await signIn(other.username, chosenPassword(other.username))
      expect(await theirs.error('DELETE', `/app-tokens/${drop.appToken.id}`)).toEqual(notFound)
      const again = await signIn(username, chosenPassword(username))
      expect(await again.error('DELETE', `/app-tokens/${crypto.randomUUID()}`)).toEqual(notFound)

      await again.send('DELETE', `/app-tokens/${drop.appToken.id}`)
      const listed = await again.call('GET', '/app-tokens', appTokenListSchema)
      expect(listed.map((token) => token.id)).toEqual([keep.appToken.id])
      expect(await again.error('DELETE', `/app-tokens/${drop.appToken.id}`)).toEqual(notFound)
    })

    it('changing the password ends the user’s tokens', async () => {
      const { username, client } = await activatedUser()
      const root = await workspace(client)
      await make(client, root.id, 'Agent')

      await client.call('POST', '/auth/password', sessionSchema, {
        json: {
          currentPassword: chosenPassword(username),
          newPassword: `changed-${crypto.randomUUID()}`,
        },
      })
      expect(await client.call('GET', '/app-tokens', appTokenListSchema)).toEqual([])
    })

    it('admins list and remove anyone’s tokens; the owner’s only by the owner', async () => {
      const { user, username, client } = await activatedUser()
      const root = await workspace(client)
      const made = await make(client, root.id, 'Office')

      expect(await client.error('GET', '/admin/app-tokens')).toEqual({
        status: 403,
        code: 'forbidden',
      })

      const admin = await owner()
      const listed = await admin.call(
        'GET',
        `/admin/app-tokens?userId=${user.id}`,
        adminAppTokenListSchema,
      )
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id: made.appToken.id,
        userId: user.id,
        username,
        displayName: user.displayName,
        canRemove: true,
      })
      expect(JSON.stringify(listed)).not.toContain(made.token)

      // The owner's own are the owner's to remove.
      const mine = await workspace(admin)
      const ownersToken = await make(admin, mine.id, 'Owner app')
      const { client: otherAdmin } = await activatedUser('admin')
      const seen = await otherAdmin.call('GET', '/admin/app-tokens', adminAppTokenListSchema)
      expect(seen.find((token) => token.id === ownersToken.appToken.id)?.canRemove).toBe(false)
      expect(
        await otherAdmin.error('DELETE', `/admin/app-tokens/${ownersToken.appToken.id}`),
      ).toEqual({ status: 409, code: 'owner_protected' })

      // Signed in as the owner again, the mock's one session being the last one's.
      const again = await owner()
      await again.send('DELETE', `/admin/app-tokens/${ownersToken.appToken.id}`)
      await again.send('DELETE', `/admin/app-tokens/${made.appToken.id}`)
      expect(await again.error('DELETE', `/admin/app-tokens/${made.appToken.id}`)).toEqual(notFound)
      const theirs = await signIn(username, chosenPassword(username))
      expect(await theirs.call('GET', '/app-tokens', appTokenListSchema)).toEqual([])
    })

    it('answers invalid_request to an ID that isn’t a UUID', async () => {
      const { client } = await activatedUser()
      const invalid = { status: 400, code: 'invalid_request' }
      expect(await client.error('DELETE', '/app-tokens/not-an-id')).toEqual(invalid)
      const admin = await owner()
      expect(await admin.error('DELETE', '/admin/app-tokens/not-an-id')).toEqual(invalid)
    })

    it('allows 50 tokens a user, and refuses the 51st', async () => {
      const { client } = await activatedUser()
      const root = await workspace(client)
      for (let n = 1; n <= 50; n += 1) await make(client, root.id, `App ${String(n)}`)
      expect(
        await client.error('POST', '/app-tokens', {
          json: { name: 'One more', folderId: root.id, canWrite: false },
        }),
      ).toEqual({ status: 409, code: 'too_many_tokens' })
      expect(await client.call('GET', '/app-tokens', appTokenListSchema)).toHaveLength(50)
    })

    it('shows another admin the owner’s tokens as theirs alone to remove', async () => {
      const admin = await owner()
      const ownerFolder = await workspace(admin)
      const ownersToken = await make(admin, ownerFolder.id, 'Owner app')
      const { client: user } = await activatedUser()
      const userFolder = await workspace(user)
      const usersToken = await make(user, userFolder.id, 'User app')
      const { client: otherAdmin } = await activatedUser('admin')

      const seen = await otherAdmin.call('GET', '/admin/app-tokens', adminAppTokenListSchema)
      expect(seen.find((token) => token.id === usersToken.appToken.id)?.canRemove).toBe(true)
      expect(seen.find((token) => token.id === ownersToken.appToken.id)?.canRemove).toBe(false)
    })

    it('an admin’s disabling or password reset of a user ends their tokens', async () => {
      const ends = [
        (admin: ApiClient, userId: string) =>
          admin.call('POST', `/admin/users/${userId}/password`, adminUserSchema, {
            json: { temporaryPassword: `reset-${crypto.randomUUID()}` },
          }),
        (admin: ApiClient, userId: string) =>
          admin.call('PATCH', `/admin/users/${userId}`, adminUserSchema, {
            json: { disabled: true },
          }),
      ]
      for (const end of ends) {
        const { user, client } = await activatedUser()
        const root = await workspace(client)
        await make(client, root.id, 'Agent')

        const admin = await owner()
        await end(admin, user.id)
        expect(
          await admin.call('GET', `/admin/app-tokens?userId=${user.id}`, adminAppTokenListSchema),
        ).toEqual([])
      }
    })

    it('is a session’s to make: without the CSRF token it is refused', async () => {
      const { client } = await activatedUser()
      const root = await workspace(client)
      expect(
        await client.error('POST', '/app-tokens', {
          json: { name: 'App', folderId: root.id, canWrite: false },
          withoutCsrf: true,
        }),
      ).toEqual({ status: 403, code: 'csrf_failed' })
    })
  })
}
