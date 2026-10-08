import { ApiClient, text, uploadFile, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { shareLinkSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

let database: TestDatabase
let app: FastifyInstance
let owner: ApiClient
let stranger: ApiClient
let fileId: string
let cleanup: () => Promise<void>

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password' })
  owner = new ApiClient(address, setup.config.publicBaseUrl)
  stranger = new ApiClient(address, setup.config.publicBaseUrl)
  await owner.signIn('owner', 'the-owner-password')
  const root = await workspace(owner)
  fileId = (await uploadFile(owner, root.id, 'report.txt', text('hello'))).nodeId
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

async function link(nodeId = fileId): Promise<string> {
  const share = await owner.call('POST', '/shares', shareLinkSchema, {
    json: { nodeId, expiresAt: null, password: null, maxDownloads: 1 },
  })
  const token = share.url?.split('/s/')[1]
  if (!token) throw new Error('No share token.')
  return `/s/${token}/files/${nodeId}/content`
}

describe('share download limits', () => {
  it.each(['bytes=-999', 'bytes=00-4', 'items=1-2', 'bytes=invalid'])(
    'counts a response starting at byte zero for Range: %s',
    async (range) => {
      const path = await link()
      const response = await stranger.fetch('GET', path, { headers: { Range: range } })
      expect(await response.text()).toBe('hello')
      expect(await stranger.error('GET', path)).toEqual({ status: 410, code: 'share_used_up' })
    },
  )

  it('does not consume a download for a HEAD request', async () => {
    const path = await link()
    expect((await stranger.fetch('HEAD', path)).status).toBe(200)
    const response = await stranger.fetch('GET', path, { headers: { Range: 'bytes=0-0' } })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('h')
  })

  it('does not consume a download for an unsatisfiable range of an empty file', async () => {
    const root = await workspace(owner)
    const empty = await uploadFile(owner, root.id, 'empty.txt', text(''))
    const path = await link(empty.nodeId)
    const response = await stranger.fetch('GET', path, { headers: { Range: 'bytes=0-0' } })
    expect(response.status).toBe(416)
    const download = await stranger.fetch('GET', path)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('')
  })

  it('answers a browser that has the file with 304 and nothing else, which is no download', async () => {
    const path = await link()
    const etag = (await owner.fetch('HEAD', `/files/${fileId}/content`)).headers.get('etag') ?? ''
    const revalidated = await stranger.fetch('GET', path, { headers: { 'If-None-Match': etag } })
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('etag')).toBe(etag)
    expect(revalidated.headers.get('content-length')).toBeNull()
    expect(revalidated.headers.get('content-type')).toBeNull()
    expect(revalidated.headers.get('content-disposition')).toBeNull()
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0)
    expect(await (await stranger.fetch('GET', path)).text()).toBe('hello')
    // Used up, the link refuses even a browser that has the file, and its previews.
    expect(await stranger.error('GET', path, { headers: { 'If-None-Match': etag } })).toEqual({
      status: 410,
      code: 'share_used_up',
    })
    expect(await stranger.error('GET', `${path}?preview=1`)).toEqual({
      status: 410,
      code: 'share_used_up',
    })
  })

  it('takes only ?preview=1 as a preview', async () => {
    const path = await link()
    expect(await stranger.error('GET', `${path}?preview=yes`)).toEqual({
      status: 400,
      code: 'invalid_request',
    })
    expect(await (await stranger.fetch('GET', `${path}?preview=1`)).text()).toBe('hello')
    expect(await (await stranger.fetch('GET', path)).text()).toBe('hello')
  })

  it('does not consume a download for archive HEAD requests', async () => {
    const path = await link()
    const archive = path.replace(/\/files\/[^/]+\/content$/, '/archive')
    expect((await stranger.fetch('HEAD', archive)).status).toBe(200)
    expect(await (await stranger.fetch('GET', path)).text()).toBe('hello')
  })
})
