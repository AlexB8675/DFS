import {
  nodePageSchema,
  nodeSchema,
  sessionSchema,
  uploadBatchResultSchema,
  uploadStatusSchema,
} from '@dfs/shared'
import type { SuiteContext } from './context.ts'
import { createFolder, sendPart, startUpload, text, uploadFile, workspace } from './files.ts'

/** Multipart uploads and versions (DESIGN.md §6.1, D20, D24). */
export function uploadTests({ describe, it, expect, owner, target }: SuiteContext): void {
  describe('uploads (§6.1)', () => {
    it('uploads a small file in one request; it syncs and counts toward its folder', async () => {
      const client = await owner()
      const root = await workspace(client)
      const session = await uploadFile(client, root.id, 'hello.txt', text('hello world'))
      expect(session).toMatchObject({ chunkCount: 1, isNewVersion: false })

      const file = await client.call('GET', `/nodes/${session.nodeId}`, nodeSchema)
      expect(file).toMatchObject({ name: 'hello.txt', kind: 'file', sizeBytes: 11 })
      await target().settle()
      expect((await client.call('GET', `/nodes/${session.nodeId}`, nodeSchema)).syncState).toBe(
        'stored',
      )
      expect((await client.call('GET', `/nodes/${root.id}`, nodeSchema)).sizeBytes).toBe(11)
    })

    it('rejects a corrupted part, and takes it when it arrives intact', async () => {
      const client = await owner()
      const root = await workspace(client)
      const bytes = text('important')
      const session = await startUpload(client, root.id, 'important.txt', bytes.length)
      expect(
        await client.error('PUT', `/uploads/${session.uploadId}/parts/0`, {
          body: bytes,
          headers: { 'X-Part-SHA256': '0'.repeat(64) },
        }),
      ).toEqual({ status: 400, code: 'hash_mismatch' })
      await sendPart(client, session, 0, bytes)
      const status = await client.call('GET', `/uploads/${session.uploadId}`, uploadStatusSchema)
      expect(status).toMatchObject({ state: 'completed', receivedParts: [0] })
    })

    it('takes a large file in parts, in any order, and says which arrived', async () => {
      const client = await owner()
      const root = await workspace(client)
      const probe = await startUpload(client, root.id, 'probe.bin', 1)
      const bytes = new Uint8Array(probe.chunkSize * 2 + 1000).map((_, i) => i % 251)
      const session = await startUpload(client, root.id, 'large.bin', bytes.length)
      expect(session.chunkCount).toBe(3)

      await sendPart(client, session, 2, bytes)
      await sendPart(client, session, 0, bytes)
      const partial = await client.call('GET', `/uploads/${session.uploadId}`, uploadStatusSchema)
      expect(partial).toMatchObject({ state: 'receiving', receivedParts: [0, 2] })
      expect(await client.error('POST', `/uploads/${session.uploadId}/complete`)).toEqual({
        status: 409,
        code: 'incomplete_upload',
      })

      await sendPart(client, session, 1, bytes)
      await client.send('POST', `/uploads/${session.uploadId}/complete`)
      // A lost response is simply retried: the part and the completion again.
      await sendPart(client, session, 1, bytes)
      await client.send('POST', `/uploads/${session.uploadId}/complete`)
      const done = await client.call('GET', `/uploads/${session.uploadId}`, uploadStatusSchema)
      expect(done).toMatchObject({ state: 'completed', receivedParts: [0, 1, 2] })
      const file = await client.call('GET', `/nodes/${session.nodeId}`, nodeSchema)
      expect(file.sizeBytes).toBe(bytes.length)
    })

    it('makes a new version when the name matches a file, and keeps both in the quota (D20, D24)', async () => {
      const client = await owner()
      const root = await workspace(client)
      const before = (await client.call('GET', '/auth/me', sessionSchema)).user.usedBytes
      const first = await uploadFile(client, root.id, 'Notes.txt', text('first'))
      const second = await uploadFile(client, root.id, 'notes.TXT', text('second take'))
      expect(second).toMatchObject({ nodeId: first.nodeId, isNewVersion: true })
      expect(second.versionId).not.toBe(first.versionId)

      const file = await client.call('GET', `/nodes/${first.nodeId}`, nodeSchema)
      expect(file).toMatchObject({ name: 'Notes.txt', sizeBytes: 11 })
      const page = await client.call('GET', `/nodes/${root.id}/children`, nodePageSchema)
      expect(page.items.map((node) => node.name)).toEqual(['Notes.txt'])
      const after = (await client.call('GET', '/auth/me', sessionSchema)).user.usedBytes
      expect(after - before).toBe(16)
    })

    it('answers per upload in a batch: a folder’s name, an invalid name, too big', async () => {
      const client = await owner()
      const root = await workspace(client)
      await createFolder(client, root.id, 'Taken')
      const upload = (name: string, sizeBytes: number) => ({
        parentId: root.id,
        name,
        sizeBytes,
        mimeType: 'text/plain',
      })
      const { results } = await client.call('POST', '/uploads/batch', uploadBatchResultSchema, {
        json: {
          uploads: [
            upload('fine.txt', 4),
            upload('taken', 4),
            upload('bad/name', 4),
            upload('huge.bin', 2 ** 50),
          ],
        },
      })
      expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual([
        'ok',
        'name_conflict',
        'invalid_name',
        'quota_exceeded',
      ])
    })

    it('cancels an upload, taking a file that never completed with it', async () => {
      const client = await owner()
      const root = await workspace(client)
      const session = await startUpload(client, root.id, 'never.bin', 10)
      await client.send('DELETE', `/uploads/${session.uploadId}`)
      expect(await client.error('GET', `/nodes/${session.nodeId}`)).toEqual({
        status: 404,
        code: 'not_found',
      })
    })
  })
}
