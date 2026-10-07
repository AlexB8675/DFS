import { archiveTicketSchema, nodeSchema } from '@dfs/shared'
import type { ApiClient } from './client.ts'
import type { SuiteContext } from './context.ts'
import { createFolder, startUpload, text, uploadFile, workspace } from './files.ts'
import { readZip, readZipTimes } from './zip-reader.ts'

/** Fast for megabytes, unlike a deep `toEqual` of typed arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** Downloads: files byte for byte, ranges, ZIPs of folders and selections (DESIGN.md §6.2). */
export function downloadTests({ describe, it, expect, owner, target }: SuiteContext): void {
  async function download(client: ApiClient, path: string, headers: Record<string, string> = {}) {
    const response = await client.fetch('GET', path, { headers })
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) }
  }

  describe('downloads (§6.2)', () => {
    it('gives a file back byte for byte, while it syncs and after', async () => {
      const client = await owner()
      const root = await workspace(client)
      const probe = await startUpload(client, root.id, 'probe.bin', 1)
      const bytes = new Uint8Array(probe.chunkSize + 5000).map((_, i) => (i * 7) % 256)
      const session = await uploadFile(client, root.id, 'data.bin', bytes)

      const syncing = await download(client, `/files/${session.nodeId}/content`)
      expect(syncing.response.status).toBe(200)
      expect(syncing.response.headers.get('content-disposition')).toMatch(/^attachment;/)
      expect(sameBytes(syncing.bytes, bytes)).toBe(true)

      await target().settle()
      const stored = await download(client, `/files/${session.nodeId}/content`)
      expect(sameBytes(stored.bytes, bytes)).toBe(true)
    })

    it('serves a byte range, across chunks too, and refuses one past the end', async () => {
      const client = await owner()
      const root = await workspace(client)
      const probe = await startUpload(client, root.id, 'probe.bin', 1)
      const bytes = new Uint8Array(probe.chunkSize + 100).map((_, i) => i % 199)
      const session = await uploadFile(client, root.id, 'video.mp4', bytes)
      const path = `/files/${session.nodeId}/content`

      const from = probe.chunkSize - 10
      const partial = await download(client, path, {
        Range: `bytes=${String(from)}-${String(from + 19)}`,
      })
      expect(partial.response.status).toBe(206)
      expect(partial.response.headers.get('content-range')).toBe(
        `bytes ${String(from)}-${String(from + 19)}/${String(bytes.length)}`,
      )
      expect(sameBytes(partial.bytes, bytes.slice(from, from + 20))).toBe(true)

      const tail = await download(client, path, { Range: 'bytes=-5' })
      expect(sameBytes(tail.bytes, bytes.slice(-5))).toBe(true)
      const beyond = await download(client, path, { Range: `bytes=${String(bytes.length)}-` })
      expect(beyond.response.status).toBe(416)
    })

    it('zips a folder with its subfolders, empty ones included', async () => {
      const client = await owner()
      const root = await workspace(client)
      const folder = await createFolder(client, root.id, 'Trip')
      await createFolder(client, folder.id, 'Empty')
      await uploadFile(client, folder.id, 'Grüße.txt', text('hello'))

      const { response, bytes } = await download(client, `/folders/${folder.id}/archive`)
      expect(response.headers.get('content-type')).toBe('application/zip')
      const entries = readZip(bytes)
      expect([...entries.keys()].sort()).toEqual(['Trip/', 'Trip/Empty/', 'Trip/Grüße.txt'])
      expect(new TextDecoder().decode(entries.get('Trip/Grüße.txt'))).toBe('hello')
    })

    it('keeps a file’s own modification date, through a rename and a move, and in a ZIP', async () => {
      const client = await owner()
      const root = await workspace(client)
      const from = await createFolder(client, root.id, 'From')
      const to = await createFolder(client, root.id, 'To')
      const modifiedAt = '2024-03-05T06:07:08.000Z'
      const session = await uploadFile(client, from.id, 'old.txt', text('dated'), { modifiedAt })
      const modified = async () =>
        Date.parse((await client.call('GET', `/nodes/${session.nodeId}`, nodeSchema)).updatedAt)
      expect(await modified()).toBe(Date.parse(modifiedAt))

      await client.send('PATCH', `/nodes/${session.nodeId}`, { json: { name: 'renamed.txt' } })
      await client.send('POST', '/nodes/move', { json: { ids: [session.nodeId], parentId: to.id } })
      expect(await modified()).toBe(Date.parse(modifiedAt))

      const { bytes } = await download(client, `/folders/${to.id}/archive?tz=Europe/Rome`)
      expect(readZipTimes(bytes).get('To/renamed.txt')?.unix).toBe(Date.parse(modifiedAt) / 1000)
    })

    it('zips a selection through a link that works once', async () => {
      const client = await owner()
      const root = await workspace(client)
      const a = await uploadFile(client, root.id, 'a.txt', text('aaa'))
      const b = await uploadFile(client, root.id, 'b.txt', text('bbbb'))
      const ticket = await client.call('POST', '/archive', archiveTicketSchema, {
        json: { ids: [a.nodeId, b.nodeId] },
      })
      expect(ticket.fileName).toBe(`${root.name} (2 items).zip`)

      const path = ticket.url.replace(/^\/api/, '')
      const entries = readZip((await download(client, path)).bytes)
      expect([...entries.keys()].sort()).toEqual(['a.txt', 'b.txt'])
      expect(await client.error('GET', path)).toEqual({ status: 404, code: 'archive_expired' })
    })
  })
}
