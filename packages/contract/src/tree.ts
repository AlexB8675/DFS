import {
  ensureFoldersResultSchema,
  nodeListSchema,
  nodePageSchema,
  nodePathSchema,
  nodeSchema,
  searchPageSchema,
  sessionSchema,
  trashPageSchema,
  type NodePage,
} from '@dfs/shared'
import type { ApiClient } from './client.ts'
import type { SuiteContext } from './context.ts'
import { createFolder as folder, workspace } from './files.ts'

/** Browsing and changing the tree, the trash and search (DESIGN.md §5.1, §6.3, §9). */
export function treeTests({ describe, it, expect, owner, newUser, activated }: SuiteContext): void {
  async function names(client: ApiClient, folderId: string, query = ''): Promise<string[]> {
    const page = await client.call('GET', `/nodes/${folderId}/children${query}`, nodePageSchema)
    return page.items.map((node) => node.name)
  }

  describe('the tree (§5.1, §6.3)', () => {
    it('lists folders in natural name order, either way', async () => {
      const client = await owner()
      const root = await workspace(client)
      for (const name of ['item10', 'item2', 'Item1']) await folder(client, root.id, name)
      expect(await names(client, root.id)).toEqual(['Item1', 'item2', 'item10'])
      expect(await names(client, root.id, '?order=desc')).toEqual(['item10', 'item2', 'Item1'])
    })

    it('pages through a folder without gaps or repeats', async () => {
      const client = await owner()
      const root = await workspace(client)
      for (let i = 0; i < 7; i += 1) await folder(client, root.id, `Folder ${String(i)}`)
      const seen: string[] = []
      const pageAfter = (cursor: string | null): Promise<NodePage> => {
        const query = `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        return client.call('GET', `/nodes/${root.id}/children${query}`, nodePageSchema)
      }
      let page = await pageAfter(null)
      for (;;) {
        expect(page.items.length).toBeGreaterThan(0)
        seen.push(...page.items.map((node) => node.id))
        if (!page.nextCursor) break
        page = await pageAfter(page.nextCursor)
      }
      expect(new Set(seen).size).toBe(7)
      expect(seen).toHaveLength(7)
    })

    it('refuses a name that is taken, ignoring case, and invalid names', async () => {
      const client = await owner()
      const root = await workspace(client)
      await folder(client, root.id, 'Report')
      const create = (name: string) =>
        client.error('POST', '/folders', { json: { parentId: root.id, name } })
      expect(await create('report')).toEqual({ status: 409, code: 'name_conflict' })
      expect(await create('a/b')).toEqual({ status: 400, code: 'invalid_name' })
      expect(await create('  ')).toEqual({ status: 400, code: 'invalid_name' })
    })

    it('renames and moves, but never a folder into itself', async () => {
      const client = await owner()
      const root = await workspace(client)
      const outer = await folder(client, root.id, 'Outer')
      const inner = await folder(client, outer.id, 'Inner')
      expect(
        await client.error('PATCH', `/nodes/${outer.id}`, { json: { parentId: inner.id } }),
      ).toEqual({ status: 400, code: 'invalid_move' })

      const renamed = await client.call('PATCH', `/nodes/${inner.id}`, nodeSchema, {
        json: { name: 'Moved', parentId: root.id },
      })
      expect(renamed).toMatchObject({ name: 'Moved', parentId: root.id })
      const path = await client.call('GET', `/nodes/${inner.id}/path`, nodePathSchema)
      expect(path.map((node) => node.name).slice(-2)).toEqual([root.name, 'Moved'])
      expect((await client.call('GET', `/nodes/${root.id}`, nodeSchema)).hasChildFolders).toBe(true)
    })

    it('moves several items at once, refusing a clash', async () => {
      const client = await owner()
      const root = await workspace(client)
      const target = await folder(client, root.id, 'Target')
      const a = await folder(client, root.id, 'A')
      const b = await folder(client, root.id, 'B')
      await client.send('POST', '/nodes/move', { json: { ids: [a.id, b.id], parentId: target.id } })
      expect(await names(client, target.id)).toEqual(['A', 'B'])

      const clash = await folder(client, root.id, 'a')
      expect(
        await client.error('POST', '/nodes/move', {
          json: { ids: [clash.id], parentId: target.id },
        }),
      ).toEqual({ status: 409, code: 'name_conflict' })
    })

    it('looks up several items at once, leaving out what the caller can’t see', async () => {
      // Another user's folder, made first: switching users signs the owner out of the mock.
      const { username, temporaryPassword } = await newUser(await owner())
      const other = await activated(username, temporaryPassword)
      const { user } = await other.call('GET', '/auth/me', sessionSchema)
      const theirs = await folder(other, user.rootFolderId, 'Theirs')

      const client = await owner()
      const root = await workspace(client)
      const kept = await folder(client, root.id, 'Kept')
      const trashed = await folder(client, root.id, 'Trashed')
      await client.send('POST', '/nodes/trash', { json: { ids: [trashed.id] } })
      const { items } = await client.call('POST', '/nodes/lookup', nodeListSchema, {
        json: { ids: [kept.id, trashed.id, theirs.id, crypto.randomUUID(), root.id, kept.id] },
      })
      expect(items.map((node) => node.id).sort()).toEqual([kept.id, root.id].sort())
      expect(items.find((node) => node.id === kept.id)).toMatchObject({ name: 'Kept' })
    })

    it('makes folder paths in one call, reusing what exists', async () => {
      const client = await owner()
      const root = await workspace(client)
      const ensure = (paths: string[]) =>
        client.call('POST', '/folders/ensure', ensureFoldersResultSchema, {
          json: { parentId: root.id, paths },
        })
      const first = await ensure(['Photos/2024/Summer', 'Photos/2025'])
      const again = await ensure(['photos/2024/summer'])
      expect(again['photos/2024/summer']).toBe(first['Photos/2024/Summer'])
      expect(await names(client, root.id)).toEqual(['Photos'])
    })

    it('trashes a folder with its contents, and restores it under a free name', async () => {
      const client = await owner()
      const root = await workspace(client)
      const trashed = await folder(client, root.id, 'Old')
      const inside = await folder(client, trashed.id, 'Inside')
      await client.send('POST', '/nodes/trash', { json: { ids: [trashed.id] } })

      expect(await names(client, root.id)).toEqual([])
      expect(await client.error('GET', `/nodes/${inside.id}`)).toEqual({
        status: 404,
        code: 'not_found',
      })
      const trash = await client.call('GET', '/trash?limit=500', trashPageSchema)
      expect(trash.items.map((item) => item.id)).toContain(trashed.id)
      expect(trash.items.map((item) => item.id)).not.toContain(inside.id)

      await folder(client, root.id, 'Old')
      const restored = await client.call('POST', `/nodes/${trashed.id}/restore`, nodeSchema)
      expect(restored.name).toBe('Old (1)')
      expect((await client.call('GET', `/nodes/${inside.id}`, nodeSchema)).name).toBe('Inside')
    })

    it('deletes from the trash for good', async () => {
      const client = await owner()
      const root = await workspace(client)
      const doomed = await folder(client, root.id, 'Doomed')
      await client.send('DELETE', `/nodes/${doomed.id}`)
      await client.send('DELETE', `/trash/${doomed.id}`)
      expect(await client.error('POST', `/nodes/${doomed.id}/restore`)).toEqual({
        status: 404,
        code: 'not_found',
      })
    })

    it('never changes or trashes the root folder', async () => {
      const client = await owner()
      const { user } = await client.call('GET', '/auth/me', sessionSchema)
      expect(
        await client.error('PATCH', `/nodes/${user.rootFolderId}`, { json: { name: 'Mine' } }),
      ).toEqual({ status: 403, code: 'forbidden' })
      expect(
        await client.error('POST', '/nodes/trash', { json: { ids: [user.rootFolderId] } }),
      ).toEqual({ status: 403, code: 'forbidden' })
    })

    it('searches names anywhere in the drive, outside the trash', async () => {
      const client = await owner()
      const root = await workspace(client)
      const unique = `needle-${crypto.randomUUID().slice(0, 8)}`
      const deep = await folder(client, (await folder(client, root.id, 'Deep')).id, `The ${unique}`)

      const found = await client.call('GET', `/search?q=${unique.toUpperCase()}`, searchPageSchema)
      expect(found.items.map((item) => item.id)).toEqual([deep.id])
      expect(found.items[0]?.location).toBe(`My Drive / ${root.name} / Deep`)

      await client.send('DELETE', `/nodes/${deep.id}`)
      const gone = await client.call('GET', `/search?q=${unique}`, searchPageSchema)
      expect(gone.items).toEqual([])
    })
  })
}
