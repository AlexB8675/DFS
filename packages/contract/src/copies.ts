import {
  adminUserSchema,
  copyResultSchema,
  nodePageSchema,
  nodeSchema,
  sessionSchema,
} from '@dfs/shared'
import type { ApiClient } from './client.ts'
import type { SuiteContext } from './context.ts'
import { createFolder, text, uploadFile, workspace } from './files.ts'
import { readZip } from './zip-reader.ts'

/** Copying files and folders (DESIGN.md §6.3, D31). */
export function copyTests({
  describe,
  it,
  expect,
  owner,
  newUser,
  activated,
  target,
}: SuiteContext): void {
  async function names(client: ApiClient, folderId: string): Promise<string[]> {
    const page = await client.call('GET', `/nodes/${folderId}/children`, nodePageSchema)
    return page.items.map((node) => node.name).sort()
  }

  async function content(client: ApiClient, nodeId: string): Promise<string> {
    const response = await client.fetch('GET', `/files/${nodeId}/content`)
    return new TextDecoder().decode(await response.arrayBuffer())
  }

  async function usedBytes(client: ApiClient): Promise<number> {
    return (await client.call('GET', '/auth/me', sessionSchema)).user.usedBytes
  }

  function copy(client: ApiClient, ids: string[], parentId: string) {
    return client.call('POST', '/nodes/copy', copyResultSchema, { json: { ids, parentId } })
  }

  describe('copies (§6.3, D31)', () => {
    it('copies a file at once; the copy counts toward the quota and outlives the original', async () => {
      const client = await owner()
      const root = await workspace(client)
      const from = await createFolder(client, root.id, 'From')
      const to = await createFolder(client, root.id, 'To')
      const original = await uploadFile(client, from.id, 'notes.txt', text('hello copies'))
      await target().settle()
      const before = await usedBytes(client)

      const copied = await copy(client, [original.nodeId], to.id)
      expect(copied.skipped).toBe(0)
      expect(copied.items).toHaveLength(1)
      const [copyOfIt] = copied.items
      expect(copyOfIt).toMatchObject({
        name: 'notes.txt',
        parentId: to.id,
        kind: 'file',
        sizeBytes: 12,
        syncState: 'stored',
      })
      expect(await content(client, copyOfIt?.id ?? '')).toBe('hello copies')
      expect(await usedBytes(client)).toBe(before + 12)

      // Into its own folder, the copy takes the next free name.
      const again = await copy(client, [original.nodeId], from.id)
      expect(again.items[0]?.name).toBe('notes (1).txt')

      // The original goes for good; the copy still reads.
      await client.send('POST', '/nodes/trash', { json: { ids: [original.nodeId] } })
      await client.send('DELETE', `/trash/${original.nodeId}`)
      await target().settle()
      expect(await content(client, copyOfIt?.id ?? '')).toBe('hello copies')

      // A copy of a copy reads too, and takes the name freed in the first folder.
      const twice = await copy(client, [copyOfIt?.id ?? ''], from.id)
      expect(twice.items[0]?.name).toBe('notes.txt')
      expect(await content(client, twice.items[0]?.id ?? '')).toBe('hello copies')
      await target().settle()
    })

    it('copies a folder with what it holds, leaving out what is in the trash', async () => {
      const client = await owner()
      const root = await workspace(client)
      const source = await createFolder(client, root.id, 'Source')
      const inside = await createFolder(client, source.id, 'Inside')
      const loose = await uploadFile(client, source.id, 'a.txt', text('a'))
      await uploadFile(client, inside.id, 'b.txt', text('bb'))
      const trashed = await uploadFile(client, source.id, 'gone.txt', text('gone'))
      await target().settle()
      await client.send('POST', '/nodes/trash', { json: { ids: [trashed.nodeId] } })

      // The file inside the folder comes with it, once.
      const copied = await copy(client, [source.id, loose.nodeId], root.id)
      expect(copied.items.map((node) => node.name)).toEqual(['Source (1)'])
      const folder = copied.items[0]?.id ?? ''
      expect(await names(client, folder)).toEqual(['Inside', 'a.txt'])
      const children = await client.call('GET', `/nodes/${folder}/children`, nodePageSchema)
      const copiedInside = children.items.find((node) => node.name === 'Inside')
      const deeper = await client.call(
        'GET',
        `/nodes/${copiedInside?.id ?? ''}/children`,
        nodePageSchema,
      )
      expect(deeper.items.map((node) => node.name)).toEqual(['b.txt'])
      expect(await content(client, deeper.items[0]?.id ?? '')).toBe('bb')
      await target().settle()
      const sized = await client.call('GET', `/nodes/${folder}`, nodeSchema)
      expect(sized.sizeBytes).toBe(3)

      // With the source gone for good, the copy still downloads as a ZIP.
      await client.send('POST', '/nodes/trash', { json: { ids: [source.id] } })
      await client.send('DELETE', `/trash/${source.id}`)
      await target().settle()
      const zip = await client.fetch('GET', `/folders/${folder}/archive`)
      const entries = readZip(new Uint8Array(await zip.arrayBuffer()))
      expect(new TextDecoder().decode(entries.get('Source (1)/Inside/b.txt'))).toBe('bb')
      expect(new TextDecoder().decode(entries.get('Source (1)/a.txt'))).toBe('a')
    })

    it('refuses a copy into itself, of a file still syncing, or of another’s file', async () => {
      const client = await owner()
      const root = await workspace(client)
      const outer = await createFolder(client, root.id, 'Outer')
      const inner = await createFolder(client, outer.id, 'Inner')
      for (const into of [outer.id, inner.id]) {
        expect(
          await client.error('POST', '/nodes/copy', { json: { ids: [outer.id], parentId: into } }),
        ).toEqual({ status: 400, code: 'invalid_copy' })
      }
      // Until it is on Discord, a file can't be copied (the mock syncs a few seconds later).
      const fresh = await uploadFile(client, root.id, 'fresh.txt', text('fresh'))
      expect(
        await client.error('POST', '/nodes/copy', {
          json: { ids: [fresh.nodeId], parentId: outer.id },
        }),
      ).toEqual({ status: 409, code: 'still_syncing' })
      await target().settle()
      expect((await copy(client, [fresh.nodeId], outer.id)).items).toHaveLength(1)

      const { username, temporaryPassword } = await newUser(client)
      const other = await activated(username, temporaryPassword)
      const theirs = await workspace(other)
      expect(
        await other.error('POST', '/nodes/copy', {
          json: { ids: [fresh.nodeId], parentId: theirs.id },
        }),
      ).toEqual({ status: 404, code: 'not_found' })
    })

    it('refuses a copy that doesn’t fit the quota', async () => {
      const admin = await owner()
      const username = `user-${crypto.randomUUID().slice(0, 8)}`
      const temporaryPassword = `temp-${crypto.randomUUID()}`
      await admin.call('POST', '/admin/users', adminUserSchema, {
        json: { username, temporaryPassword, quotaBytes: 30 },
      })
      const client = await activated(username, temporaryPassword)
      const root = await workspace(client)
      const file = await uploadFile(client, root.id, 'twenty.txt', text('x'.repeat(20)))
      await target().settle()
      expect(
        await client.error('POST', '/nodes/copy', {
          json: { ids: [file.nodeId], parentId: root.id },
        }),
      ).toEqual({ status: 507, code: 'quota_exceeded' })
      expect(await usedBytes(client)).toBe(20)
    })
  })
}
