import { dataChannels, refreshBlobUrls, refreshedUrls } from '@dfs/bot/storage'
import { settleBlobs } from '@dfs/bot/testing'
import { defineContractSuite, type ContractTarget } from '@dfs/contract'
import { foldAllFolderStats, liveBytesDrift, purgeUnneededVersions, storageChannels } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { refreshUrlsSchema } from '@dfs/shared'
import { DiscordBlobStore, LocalBlobStore, type BlobReader, type BlobStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from './app.ts'
import { CdnBlobReader } from './content/cdn-reader.ts'
import { testConfig } from './testing/config.ts'
import { standInMediaFetch } from './testing/media-stand-in.ts'
import { seedUser } from './testing/seed.ts'

// The contract suite (BACKEND.md §5) against the real API, over real HTTP,
// once on local storage and once on Discord: a Discord in memory, with the
// bot's uploader, its URL signing and the API's CDN reader, and a stand-in
// for the media service. `settle` does what the bot would: delete versions no
// link serves, store staged blobs, fold folder sizes.

for (const storage of ['local', 'discord'] as const) {
  describe(`with ${storage} storage`, () => {
    let database: TestDatabase
    let app: FastifyInstance
    let cleanup: () => Promise<void>
    let target: ContractTarget
    const discord = new FakeDiscord()

    beforeAll(async () => {
      database = await createTestDatabase(inject('testPostgres'))
      // A stand-in media service: every file it is asked about is a video.
      const setup = await testConfig({
        DATABASE_URL: database.url,
        MEDIA_INTERNAL_URL: 'http://media.test',
      })
      cleanup = setup.cleanup
      let store: BlobStore = new LocalBlobStore(setup.config.localBlobDir)
      let reader: BlobReader | undefined
      if (storage === 'discord') {
        store = new DiscordBlobStore({
          rest: discord,
          channels: () => dataChannels(app.db),
          maxBytes: setup.config.sizes.blobMaxBytes,
          instanceId: () => Promise.resolve('0123456789ab'),
          perChannel: setup.config.uploadChannelConcurrency,
          fetch: discord.fetch,
        })
        // The bot's `POST /internal/urls/refresh`, and the CDN behind it.
        const bot = 'http://bot.test/internal/urls/refresh'
        reader = new CdnBlobReader({
          botUrl: 'http://bot.test',
          secret: setup.config.internalRpcSecret,
          fetch: async (input, init) => {
            const url = input instanceof Request ? input.url : input.toString()
            if (url !== bot) return discord.fetch(input, init)
            const { blobIds } = refreshUrlsSchema.parse(JSON.parse(init?.body as string))
            return Response.json(refreshedUrls(await refreshBlobUrls(app.db, store, blobIds)))
          },
        })
      }
      // Only server errors are logged: a 500 in the suite should say why.
      app = await buildApp({
        config: setup.config,
        logger: { level: 'error' },
        blobStore: reader,
        mediaFetch: standInMediaFetch,
      })
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const owner = { username: 'owner', password: 'the-owner-password' }
      await seedUser(app.db, { ...owner, role: 'admin', isOwner: true })
      for (const name of ['storage-00', 'storage-01']) {
        const channel = discord.addTextChannel(name)
        await app.db.insert(storageChannels).values({ discordChannelId: channel.id, name })
      }
      target = {
        name: 'api',
        baseUrl: address,
        origin: setup.config.publicBaseUrl,
        owner,
        settle: async () => {
          for (const versionId of await purgeUnneededVersions(app.db)) {
            await app.staging.removeVersion(versionId)
          }
          await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
          await foldAllFolderStats(app.db)
          // Purges, packs and uploads have kept every blob's live bytes exact.
          expect(await liveBytesDrift(app.db)).toEqual([])
          // As if a day had passed: every read must have its URL signed again.
          discord.revokeUrls()
        },
      }
    })

    afterAll(async () => {
      await app.close()
      await database.drop()
      await cleanup()
    })

    defineContractSuite({ describe, it, expect }, () => target)

    if (storage === 'discord') {
      it('packed small files, stored the blobs in Discord, and read them back through newly signed URLs', () => {
        expect(discord.messages.some((message) => message.content.includes(' k=pack '))).toBe(true)
        expect(discord.requests).toContain('POST /attachments/refresh-urls')
      })
    }
  })
}
