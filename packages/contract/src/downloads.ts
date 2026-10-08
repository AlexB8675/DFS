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

    it('answers a browser that has the version with 304 and no bytes, and another version in full', async () => {
      const client = await owner()
      const root = await workspace(client)
      const session = await uploadFile(client, root.id, 'notes.txt', text('first'))
      const path = `/files/${session.nodeId}/content`
      const first = await download(client, path)
      const etag = first.response.headers.get('etag') ?? ''
      expect(etag).toMatch(/^".+"$/)
      // The version, not its sync state: the same once stored.
      await target().settle()
      expect((await download(client, path)).response.headers.get('etag')).toBe(etag)

      for (const tag of [etag, `W/${etag}`, `"another", ${etag}`]) {
        const again = await download(client, path, { 'If-None-Match': tag })
        expect(again.response.status).toBe(304)
        expect(again.response.headers.get('etag')).toBe(etag)
        expect(again.bytes.length).toBe(0)
      }
      // Before any range: the browser has all of it.
      const ranged = await download(client, path, { 'If-None-Match': etag, Range: 'bytes=0-1' })
      expect(ranged.response.status).toBe(304)

      await uploadFile(client, root.id, 'notes.txt', text('second'))
      const replaced = await download(client, path, { 'If-None-Match': etag })
      expect(replaced.response.status).toBe(200)
      expect(new TextDecoder().decode(replaced.bytes)).toBe('second')
      expect(replaced.response.headers.get('etag')).not.toBe(etag)
    })

    it('serves a range only of the version it names (If-Range), and another whole', async () => {
      const client = await owner()
      const root = await workspace(client)
      const session = await uploadFile(client, root.id, 'grows.txt', text('first version'))
      const path = `/files/${session.nodeId}/content`
      const etag = (await download(client, path)).response.headers.get('etag') ?? ''
      const same = await download(client, path, { Range: 'bytes=6-12', 'If-Range': etag })
      expect(same.response.status).toBe(206)
      expect(new TextDecoder().decode(same.bytes)).toBe('version')

      await uploadFile(client, root.id, 'grows.txt', text('second version'))
      const other = await download(client, path, { Range: 'bytes=6-12', 'If-Range': etag })
      expect(other.response.status).toBe(200)
      expect(new TextDecoder().decode(other.bytes)).toBe('second version')
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
