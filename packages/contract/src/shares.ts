import {
  publicShareSchema,
  shareLinkPageSchema,
  shareLinkSchema,
  sharedFolderPageSchema,
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

  describe('share links (§7.5)', () => {
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
