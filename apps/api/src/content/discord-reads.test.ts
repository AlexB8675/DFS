import { markLost } from '@dfs/bot/lost'
import { dataChannels } from '@dfs/bot/storage'
import { settleBlobs } from '@dfs/bot/testing'
import { ApiClient, createFolder, text, uploadFile, workspace } from '@dfs/contract'
import { storageChannels } from '@dfs/db'
import { nodePageSchema, systemHealthSchema } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordBlobStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { setTimeout } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// Reading back from Discord (DESIGN.md §6.2), over real HTTP: a ZIP of a
// folder of small files costs one CDN request per pack, not one per file, and
// nothing the second time; a download stalls with its client instead of
// fetching the whole file. Attachments of 4 MiB make a large file out of
// little test data.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let client: ApiClient
const discord = new FakeDiscord()

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({
    DATABASE_URL: database.url,
    DISCORD_ATTACHMENT_LIMIT: '4 MiB',
    PACK_THRESHOLD_BYTES: '1 MiB',
  })
  cleanup = setup.cleanup
  // The bot's signing, without the bot: the URLs the uploads saved stay fresh here.
  app = await buildApp({
    config: setup.config,
    logger: false,
    blobStore: new DiscordBlobStore({
      rest: discord,
      channels: () => dataChannels(app.db),
      maxBytes: setup.config.sizes.blobMaxBytes,
      instanceId: () => Promise.resolve('0123456789ab'),
      perChannel: 2,
      fetch: discord.fetch,
    }),
  })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const channel = discord.addTextChannel('storage-00')
  await app.db.insert(storageChannels).values({ discordChannelId: channel.id, name: 'storage-00' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password', role: 'admin' })
  client = new ApiClient(address, setup.config.publicBaseUrl)
  await client.signIn('owner', 'the-owner-password')
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

describe('reading from Discord', () => {
  it('fetch each pack whole once, then come from the frame cache', async () => {
    const folder = await createFolder(client, (await workspace(client)).id, 'Small')
    const names = Array.from({ length: 20 }, (_, index) => `file-${String(index)}.txt`)
    for (const name of names)
      await uploadFile(client, folder.id, name, text(`${name}\n`.repeat(50)))
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    expect(discord.messages).toHaveLength(1)
    await app.frameCache?.idle()

    discord.cdnRequests = 0
    const first = await client.fetch('GET', `/folders/${folder.id}/archive`)
    const zip = Buffer.from(await first.arrayBuffer())
    for (const name of names) expect(zip.includes(Buffer.from(name))).toBe(true)
    expect(discord.cdnRequests).toBe(1)

    await app.frameCache?.idle()
    const second = await client.fetch('GET', `/folders/${folder.id}/archive`)
    expect(Buffer.from(await second.arrayBuffer()).equals(zip)).toBe(true)
    expect(discord.cdnRequests).toBe(1)
  })

  it('stalls a download with its client instead of fetching the whole file', async () => {
    const chunks = 10
    const bytes = new Uint8Array(chunks * app.config.sizes.chunkSize).map((_, index) => index % 251)
    const folder = await createFolder(client, (await workspace(client)).id, 'Large')
    const session = await uploadFile(client, folder.id, 'large.bin', bytes)
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })

    discord.cdnRequests = 0
    const response = await client.fetch('GET', `/files/${session.nodeId}/content`, {
      headers: { Range: 'bytes=0-' },
    })
    const body = response.body?.getReader()
    try {
      await body?.read()
      // The client stops reading. The connection's buffers take a few chunks
      // (how many depends on the OS), then the server must stop fetching too.
      await setTimeout(500)
      const stalled = discord.cdnRequests
      await setTimeout(500)
      expect(discord.cdnRequests).toBe(stalled)
      expect(stalled).toBeLessThan(chunks)
    } finally {
      await body?.cancel()
    }
  })

  it('shows a file whose message was deleted by hand as lost, until it is purged', async () => {
    const folder = await createFolder(client, (await workspace(client)).id, 'Lost')
    const session = await uploadFile(client, folder.id, 'gone.txt', text('soon gone'))
    const store = app.blobStore as DiscordBlobStore
    await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
    const { rows } = await app.db.execute<{ channel: string; message: string; blob: string }>(sql`
      SELECT channel.discord_channel_id AS channel, blob.message_id AS message, blob.id::text AS blob
      FROM chunks chunk JOIN blobs blob ON blob.id = chunk.blob_id
      JOIN storage_channels channel ON channel.id = blob.channel_id
      WHERE chunk.version_id = ${session.versionId}`)
    const stored = rows[0]
    if (!stored) throw new Error('Nothing stored.')

    await markLost(app.db, stored.channel, [stored.message])
    const listing = await client.call('GET', `/nodes/${folder.id}/children`, nodePageSchema)
    expect(listing.items.map((item) => item.syncState)).toEqual(['lost'])
    expect(await client.error('GET', `/files/${session.nodeId}/content`)).toEqual({
      status: 409,
      code: 'file_lost',
    })
    const lostBlobs = async () =>
      (await client.call('GET', '/admin/health', systemHealthSchema)).lostBlobs.map((blob) => ({
        blobId: blob.blobId,
        affectedFiles: blob.affectedFiles,
      }))
    expect(await lostBlobs()).toEqual([{ blobId: stored.blob, affectedFiles: 1 }])

    await client.send('POST', '/nodes/trash', { json: { ids: [session.nodeId] } })
    await client.send('DELETE', `/trash/${session.nodeId}`)
    expect(await lostBlobs()).toEqual([])
  })
})
