import {
  publicShareSchema,
  sessionSchema,
  shareCountSchema,
  shareLinkPageSchema,
  shareLinkSchema,
  sharedFolderPageSchema,
  uploadBatchResultSchema,
} from '@dfs/shared'
import { ApiClient } from './client.ts'
import type { SuiteContext } from './context.ts'
import { createFolder, text, uploadFile, workspace } from './files.ts'

/** Share links and the public share page's API (DESIGN.md §7.5, D18). */
export function shareTests({ describe, it, expect, owner, target }: SuiteContext): void {
  function share(client: ApiClient, nodeId: string, options: Record<string, unknown> = {}) {
    return client.call('POST', '/shares', shareLinkSchema, {
      json: { nodeId, expiresAt: null, password: null, maxDownloads: null, ...options },
    })
  }

  /** The token from a link, and a client with no session to open it, as a stranger would. */
  function visitor(url: string | null) {
    const token = url?.split('/s/')[1]
    if (!token) throw new Error(`Not a share link: ${String(url)}`)
    const { baseUrl, origin } = target()
    return { token, client: new ApiClient(baseUrl, origin) }
  }

  async function usedBytes(client: ApiClient): Promise<number> {
    return (await client.call('GET', '/auth/me', sessionSchema)).user.usedBytes
  }

  async function listed(client: ApiClient, id: string) {
    const { items } = await client.call('GET', '/shares', shareLinkPageSchema)
    return items.find((item) => item.id === id)
  }

  describe('share links (§7.5)', () => {
    it('keeps a file link on its version when the file is replaced, and that version while the link works', async () => {
      const client = await owner()
      const root = await workspace(client)
      const before = await usedBytes(client)
      const first = await uploadFile(client, root.id, 'draft.txt', text('a'))
      const link = await share(client, first.nodeId)
      expect(link.version).toBe('current')
      await uploadFile(client, root.id, 'draft.txt', text('bb'))
      await uploadFile(client, root.id, 'draft.txt', text('ccc'))
      // The current 3 bytes and the first byte the link serves: the second went.
      expect((await usedBytes(client)) - before).toBe(4)

      const { token, client: stranger } = visitor(link.url)
      const opened = await stranger.call('GET', `/s/${token}`, publicShareSchema)
      expect(opened).toMatchObject({ locked: false, root: { name: 'draft.txt', sizeBytes: 1 } })
      const served = await stranger.fetch('GET', `/s/${token}/files/${first.nodeId}/content`)
      expect(await served.text()).toBe('a')
      const own = await client.fetch('GET', `/files/${first.nodeId}/content`)
      expect(await own.text()).toBe('ccc')
      expect(await listed(client, link.id)).toMatchObject({ version: 'earlier' })

      // A new link shares the file as it is now.
      expect(await share(client, first.nodeId)).toMatchObject({ version: 'current' })
      // Once the old link stops working, its version goes.
      await client.send('DELETE', `/shares/${link.id}`)
      await target().settle()
      expect((await usedBytes(client)) - before).toBe(3)
      expect(await listed(client, link.id)).toMatchObject({ version: 'deleted' })
    })

    it('ends a file link whose version was deleted, for good', async () => {
      const client = await owner()
      const root = await workspace(client)
      const first = await uploadFile(client, root.id, 'once.txt', text('one'))
      const link = await share(client, first.nodeId, { maxDownloads: 1 })
      const { token, client: stranger } = visitor(link.url)
      await stranger.fetch('GET', `/s/${token}/files/${first.nodeId}/content`)
      // Used up, the link serves nothing, so replacing the file deletes the version.
      await uploadFile(client, root.id, 'once.txt', text('two'))
      expect(await listed(client, link.id)).toMatchObject({ version: 'deleted' })
      expect(
        await client.error('PATCH', `/shares/${link.id}`, { json: { maxDownloads: 5 } }),
      ).toEqual({ status: 409, code: 'share_version_deleted' })
    })

    it('counts the links deleting would stop: to an item, inside a folder, in the trash', async () => {
      const client = await owner()
      const root = await workspace(client)
      const folder = await createFolder(client, root.id, 'Album')
      const inside = await uploadFile(client, folder.id, 'a.txt', text('a'))
      const outside = await uploadFile(client, root.id, 'b.txt', text('b'))
      await share(client, folder.id)
      await share(client, inside.nodeId)
      const revoked = await share(client, outside.nodeId)
      await client.send('DELETE', `/shares/${revoked.id}`)
      const count = async (body: Record<string, unknown>) =>
        (await client.call('POST', '/shares/count', shareCountSchema, { json: body })).links

      expect(await count({ ids: [folder.id] })).toBe(2)
      expect(await count({ ids: [inside.nodeId] })).toBe(1)
      // Revoked, it is no longer outstanding.
      expect(await count({ ids: [outside.nodeId] })).toBe(0)

      // In the trash, they would come back with it; deleting it forever deletes them.
      const trashed = await count({ trash: true })
      await client.send('POST', '/nodes/trash', { json: { ids: [folder.id] } })
      expect((await count({ trash: true })) - trashed).toBe(2)
    })

    it('can’t share a file before its upload completes', async () => {
      const client = await owner()
      const root = await workspace(client)
      const { results } = await client.call('POST', '/uploads/batch', uploadBatchResultSchema, {
        json: {
          uploads: [
            { parentId: root.id, name: 'pending.bin', sizeBytes: 5, mimeType: 'text/plain' },
          ],
        },
      })
      const [started] = results
      if (!started?.ok) throw new Error('The upload was refused.')
      expect(
        await client.error('POST', '/shares', {
          json: {
            nodeId: started.session.nodeId,
            expiresAt: null,
            password: null,
            maxDownloads: null,
          },
        }),
      ).toEqual({ status: 409, code: 'not_ready' })
    })

    it('shows a new link once, and lists it without it', async () => {
      const client = await owner()
      const root = await workspace(client)
      const created = await share(client, root.id)
      expect(created).toMatchObject({ nodeId: root.id, nodeName: root.name, hasPassword: false })
      expect(created.url).toMatch(/\/s\/[\w-]+$/)

      const { items } = await client.call('GET', '/shares', shareLinkPageSchema)
      const listed = items.find((item) => item.id === created.id)
      expect(listed).toMatchObject({ url: null, downloadCount: 0, revokedAt: null })
    })

    it('opens a shared folder without signing in, and never reaches outside it', async () => {
      const client = await owner()
      const root = await workspace(client)
      const shared = await createFolder(client, root.id, 'Shared')
      const inside = await createFolder(client, shared.id, 'Inside')
      const outside = await createFolder(client, root.id, 'Outside')
      const { token, client: stranger } = visitor((await share(client, shared.id)).url)

      const opened = await stranger.call('GET', `/s/${token}`, publicShareSchema)
      expect(opened).toMatchObject({
        locked: false,
        root: { id: shared.id, name: 'Shared', parentId: null },
        downloadsLeft: null,
      })
      const top = await stranger.call('GET', `/s/${token}/children`, sharedFolderPageSchema)
      expect(top.items.map((node) => node.name)).toEqual(['Inside'])
      const below = await stranger.call(
        'GET',
        `/s/${token}/children?parentId=${inside.id}`,
        sharedFolderPageSchema,
      )
      expect(below.path.map((node) => node.name)).toEqual(['Shared', 'Inside'])
      expect(await stranger.error('GET', `/s/${token}/children?parentId=${outside.id}`)).toEqual({
        status: 404,
        code: 'not_found',
      })
    })

    it('reveals nothing behind a password until unlocked; a new password locks it again', async () => {
      const client = await owner()
      const root = await workspace(client)
      const created = await share(client, root.id, { password: 'open sesame' })
      const { token, client: stranger } = visitor(created.url)

      expect(await stranger.call('GET', `/s/${token}`, publicShareSchema)).toEqual({ locked: true })
      expect(await stranger.error('GET', `/s/${token}/children`)).toEqual({
        status: 403,
        code: 'share_locked',
      })
      expect(
        await stranger.error('POST', `/s/${token}/unlock`, { json: { password: 'wrong' } }),
      ).toEqual({ status: 403, code: 'wrong_password' })
      await stranger.send('POST', `/s/${token}/unlock`, { json: { password: 'open sesame' } })
      expect((await stranger.call('GET', `/s/${token}`, publicShareSchema)).locked).toBe(false)

      await client.call('PATCH', `/shares/${created.id}`, shareLinkSchema, {
        json: { password: 'new secret' },
      })
      expect(await stranger.call('GET', `/s/${token}`, publicShareSchema)).toEqual({ locked: true })
    })

    it('counts downloads from byte 0 only, and turns off when used up', async () => {
      const client = await owner()
      const root = await workspace(client)
      const file = await uploadFile(client, root.id, 'report.txt', text('the whole report'))
      const { token, client: stranger } = visitor(
        (await share(client, file.nodeId, { maxDownloads: 2 })).url,
      )
      const path = `/s/${token}/files/${file.nodeId}/content`
      const left = async () => {
        const opened = await stranger.call('GET', `/s/${token}`, publicShareSchema)
        return opened.locked ? null : opened.downloadsLeft
      }

      const seek = await stranger.fetch('GET', path, { headers: { Range: 'bytes=4-8' } })
      expect(new TextDecoder().decode(await seek.arrayBuffer())).toBe('whole')
      expect(await left()).toBe(2)
      await (await stranger.fetch('GET', path)).arrayBuffer()
      expect(await left()).toBe(1)
      const last = await stranger.fetch('GET', path)
      expect(new TextDecoder().decode(await last.arrayBuffer())).toBe('the whole report')
      expect(await stranger.error('GET', `/s/${token}`)).toEqual({
        status: 410,
        code: 'share_used_up',
      })
    })

    it('says why a link is dead: revoked, expired, unknown', async () => {
      const client = await owner()
      const root = await workspace(client)
      const revoked = await share(client, root.id)
      await client.send('DELETE', `/shares/${revoked.id}`)
      const expired = await share(client, root.id, {
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      const open = (url: string | null) => {
        const { token, client: stranger } = visitor(url)
        return stranger.error('GET', `/s/${token}`)
      }
      expect(await open(revoked.url)).toEqual({ status: 410, code: 'share_revoked' })
      expect(await open(expired.url)).toEqual({ status: 410, code: 'share_expired' })
      expect(await open(`${target().baseUrl}/s/no-such-link`)).toEqual({
        status: 404,
        code: 'share_not_found',
      })
    })
  })
}
