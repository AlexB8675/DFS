import { dataChannels, refreshBlobUrls, refreshedUrls } from '@dfs/bot/storage'
import { storeAllStagedBlobs } from '@dfs/bot/uploader'
import { defineContractSuite, type ContractTarget } from '@dfs/contract'
import { foldAllFolderStats, storageChannels } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { refreshUrlsSchema } from '@dfs/shared'
import { DiscordBlobStore, LocalBlobStore, type BlobReader, type BlobStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from './app.ts'
import { CdnBlobReader } from './content/cdn-reader.ts'
import { testConfig } from './testing/config.ts'
import { seedUser } from './testing/seed.ts'

// The contract suite (BACKEND.md §5) against the real API, over real HTTP,
// once on local storage and once on Discord: a Discord in memory, with the
// bot's uploader, its URL signing and the API's CDN reader. `settle` does what
// the bot would: store staged blobs, fold folder sizes.

for (const storage of ['local', 'discord'] as const) {
  describe(`with ${storage} storage`, () => {
    let database: TestDatabase
    let app: FastifyInstance
    let cleanup: () => Promise<void>
    let target: ContractTarget
    const discord = new FakeDiscord()

    beforeAll(async () => {
      database = await createTestDatabase(inject('testPostgres'))
      const setup = await testConfig({ DATABASE_URL: database.url })
      cleanup = setup.cleanup
      let store: BlobStore = new LocalBlobStore(setup.config.localBlobDir)
      let reader: BlobReader | undefined
      if (storage === 'discord') {
        store = new DiscordBlobStore({
          rest: discord,
          channels: () => dataChannels(app.db),
          maxBytes: setup.config.sizes.blobMaxBytes,
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
          await storeAllStagedBlobs({ db: app.db, staging: app.staging, store })
          await foldAllFolderStats(app.db)
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
      it('stored the blobs in Discord and read them back through newly signed URLs', () => {
        expect(discord.messages.length).toBeGreaterThan(10)
        expect(discord.requests).toContain('POST /attachments/refresh-urls')
      })
    }
  })
}
