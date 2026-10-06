import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sealPacks, settleBlobs } from '@dfs/bot/testing'
import { ApiClient, text, uploadFile } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import {
  adminTaskListSchema,
  adminTaskSchema,
  auditPageSchema,
  sessionSchema,
  storageStatusSchema,
  systemHealthSchema,
} from '@dfs/shared'
import { LocalBlobStore } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Admin → Storage (DESIGN.md §9): tasks go to the leading bot through the
// job queue, only while one leads; lost blobs come with the files they held.
// A stand-in bot answers the health check.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let bot: Server
let admin: ApiClient
let leading = false

beforeAll(async () => {
  bot = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify(
        leading ? { role: 'leader', queue: 'running' } : { role: 'standby', queue: 'stopped' },
      ),
    )
  })
  await new Promise<void>((resolve) => bot.listen(0, '127.0.0.1', resolve))
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({
    DATABASE_URL: database.url,
    BOT_INTERNAL_URL: `http://127.0.0.1:${String((bot.address() as AddressInfo).port)}`,
  })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password', role: 'admin' })
  admin = new ApiClient(address, setup.config.publicBaseUrl)
  await admin.signIn('owner', 'the-owner-password')
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
  await new Promise((resolve) => bot.close(resolve))
})

describe('Admin → Storage (§9)', () => {
  it('queues a task only while a bot leads, and shows it until the bot takes it', async () => {
    leading = false
    expect(await admin.error('POST', '/admin/tasks', { json: { kind: 'packs.seal' } })).toEqual({
      status: 503,
      code: 'bot_unavailable',
    })

    leading = true
    const queued = await admin.call('POST', '/admin/tasks', adminTaskSchema, {
      json: { kind: 'packs.seal' },
    })
    expect(queued).toMatchObject({
      kind: 'packs.seal',
      state: 'pending',
      requestedBy: 'owner',
      result: null,
    })
    expect(await admin.call('GET', `/admin/tasks/${queued.id}`, adminTaskSchema)).toEqual(queued)
    const tasks = await admin.call('GET', '/admin/tasks', adminTaskListSchema)
    expect(tasks[0]?.id).toBe(queued.id)
    const log = await admin.call('GET', '/admin/audit?limit=1', auditPageSchema)
    expect(log.items[0]).toMatchObject({ action: 'task.started', target: 'Seal packs now' })
  })

  it('queues one task of a kind at a time, even when asked twice at once', async () => {
    leading = true
    const start = async (kind: string) =>
      (await admin.fetch('POST', '/admin/tasks', { json: { kind } })).status
    // A double click: one goes, the other is told it is under way.
    const twice = await Promise.all([start('deletions.retry'), start('deletions.retry')])
    expect(twice.sort()).toEqual([202, 409])
    expect(
      await admin.error('POST', '/admin/tasks', { json: { kind: 'deletions.retry' } }),
    ).toEqual({ status: 409, code: 'task_running' })
    // Another kind isn't held back by it.
    expect(await start('uploads.retry')).toBe(202)
    const started = await admin.call('GET', '/admin/audit?actions=task.', auditPageSchema)
    expect(
      started.items.filter((entry) => entry.target === 'Retry failing deletions'),
    ).toHaveLength(1)
  })

  it('refuses Discord tasks while blobs are stored elsewhere, and unknown ones', async () => {
    leading = true
    expect(await admin.error('POST', '/admin/tasks', { json: { kind: 'channel.create' } })).toEqual(
      { status: 409, code: 'not_discord' },
    )
    expect(await admin.error('POST', '/admin/tasks', { json: { kind: 'blob.recover' } })).toEqual({
      status: 400,
      code: 'invalid_request',
    })
    expect(await admin.error('GET', `/admin/tasks/${crypto.randomUUID()}`)).toEqual({
      status: 404,
      code: 'not_found',
    })
  })

  it('lists a lost blob with the file it held, on this page and the overview', async () => {
    const me = await admin.call('GET', '/auth/me', sessionSchema)
    await uploadFile(admin, me.user.rootFolderId, 'gone.txt', text('lost in Discord'))
    await settleBlobs({
      db: app.db,
      staging: app.staging,
      store: new LocalBlobStore(app.config.localBlobDir),
      sizes: app.config.sizes,
    })
    await app.db.execute(
      sql`UPDATE blobs SET state = 'lost', lost_at = now() WHERE state = 'stored'`,
    )
    await app.db.execute(sql`UPDATE file_versions SET state = 'lost' WHERE state = 'stored'`)

    const status = await admin.call('GET', '/admin/storage', storageStatusSchema)
    expect(status.blobStore).toBe('local')
    expect(status.lost).toHaveLength(1)
    expect(status.lost[0]).toMatchObject({
      fileCount: 1,
      files: [{ name: 'gone.txt', ownerName: 'owner', current: true }],
    })

    leading = true
    const health = await admin.call('GET', '/admin/health', systemHealthSchema)
    expect(health.lostBlobs).toHaveLength(1)
    expect(health.alerts.find((alert) => alert.code === 'lost_blobs')?.detail).toMatch(/^1 file /)
  })

  it('lists each file of a lost blob once, and counts as lost only files whose current version is', async () => {
    const me = await admin.call('GET', '/auth/me', sessionSchema)
    const settle = () =>
      settleBlobs({
        db: app.db,
        staging: app.staging,
        store: new LocalBlobStore(app.config.localBlobDir),
        sizes: app.config.sizes,
      })
    // Two older versions of a file go to Discord together; its current one later.
    await uploadFile(admin, me.user.rootFolderId, 'kept.txt', text('first'))
    await uploadFile(admin, me.user.rootFolderId, 'kept.txt', text('second'))
    await settle()
    await uploadFile(admin, me.user.rootFolderId, 'kept.txt', text('third'))
    await settle()
    const { rows } = await app.db.execute<{ blob_id: string }>(sql`
      SELECT chunk.blob_id::text AS blob_id FROM chunks chunk
      JOIN file_versions version ON version.id = chunk.version_id
      JOIN nodes node ON node.id = version.node_id
      WHERE node.name = 'kept.txt' AND version.version_no = 1`)
    const blobId = rows[0]?.blob_id ?? ''
    await app.db.execute(sql`UPDATE blobs SET state = 'lost', lost_at = now() WHERE id = ${blobId}`)
    await app.db.execute(sql`
      UPDATE file_versions SET state = 'lost'
      WHERE id IN (SELECT version_id FROM chunks WHERE blob_id = ${blobId})`)

    const status = await admin.call('GET', '/admin/storage', storageStatusSchema)
    expect(status.lost.find((blob) => blob.blobId === blobId)).toMatchObject({
      fileCount: 1,
      files: [{ name: 'kept.txt', current: false }],
    })
    const health = await admin.call('GET', '/admin/health', systemHealthSchema)
    expect(health.lostBlobs.find((blob) => blob.blobId === blobId)?.affectedFiles).toBe(1)
    // gone.txt still can't be downloaded; kept.txt can, from its current version.
    const alert = health.alerts.find((candidate) => candidate.code === 'lost_blobs')
    expect(alert?.title).toBe('2 lost blobs')
    expect(alert?.detail).toMatch(/^1 file /)
  })

  it('counts sealed packs waiting for Discord as staging used, as the upload limit does', async () => {
    const me = await admin.call('GET', '/auth/me', sessionSchema)
    // A small file's frame waits alone, then in a sealed pack: staging holds it either way.
    await uploadFile(admin, me.user.rootFolderId, 'waiting.txt', text('waiting for Discord'))
    const before = await admin.call('GET', '/admin/health', systemHealthSchema)
    expect(await sealPacks({ db: app.db, staging: app.staging, sizes: app.config.sizes })).toBe(1)
    const { rows } = await app.db.execute<{ frames: number; packs: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM chunks WHERE staged_path IS NOT NULL) AS frames,
        (SELECT count(*)::int FROM blobs WHERE kind = 'pack' AND state = 'staged') AS packs`)
    expect(rows[0]).toEqual({ frames: 0, packs: 1 })
    const after = await admin.call('GET', '/admin/health', systemHealthSchema)
    expect(before.staging.usedBytes).toBeGreaterThan(0)
    // A pack is its frames, end to end: staging holds as much as before.
    expect(after.staging.usedBytes).toBe(before.staging.usedBytes)
    await settleBlobs({
      db: app.db,
      staging: app.staging,
      store: new LocalBlobStore(app.config.localBlobDir),
      sizes: app.config.sizes,
    })
    expect((await admin.call('GET', '/admin/health', systemHealthSchema)).staging.usedBytes).toBe(0)
  })
})
