import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDatabase, createPool, storageChannels, type Database } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { channelsInCategory, DiscordBlobStore, Staging } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { ChannelType } from '@discordjs/core'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { reconcileOrphans } from './reconciler.ts'
import { instanceId, placeableChannels } from './storage.ts'
import { settleBlobs, uploadedFiles } from './testing.ts'

// Development and production share one Discord server and bot (D25). Neither
// may post to, read, delete or take over the other's messages: each keeps to
// its own category, and every message names the database that posted it.

interface Environment {
  database: TestDatabase
  pool: pg.Pool
  db: Database
  staging: Staging
  instance: string
  category: string
}

const discord = new FakeDiscord()
const environments: Environment[] = []
let directory: string

async function environment(category: string, instance: string): Promise<Environment> {
  const database = await createTestDatabase(inject('testPostgres'))
  const pool = createPool(database.url, { applicationName: 'dfs-separation', onError: vi.fn() })
  const db = createDatabase(pool)
  // Test databases copy one template: give each its own instance ID.
  await db.execute(sql`UPDATE instance SET id = ${instance}`)
  const env = {
    database,
    pool,
    db,
    staging: new Staging(path.join(directory, instance)),
    instance,
    category,
  }
  environments.push(env)
  return env
}

function storeFor(env: Environment): DiscordBlobStore {
  return new DiscordBlobStore({
    rest: discord,
    channels: () => placeableChannels(env.db, discord, discord.guildId, env.category),
    maxBytes: 4096,
    instanceId: () => instanceId(env.db),
    perChannel: 2,
    fetch: discord.fetch,
  })
}

async function messageOf(env: Environment): Promise<{ channel: string; message: string }> {
  const { rows } = await env.db.execute<{ channel: string; message: string }>(sql`
    SELECT channel.discord_channel_id AS channel, blob.message_id AS message
    FROM blobs blob JOIN storage_channels channel ON channel.id = blob.channel_id
    WHERE blob.state = 'stored'`)
  const [stored] = rows
  if (!stored) throw new Error('Nothing stored.')
  return stored
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-separation-'))
})

afterAll(async () => {
  for (const env of environments) {
    await env.pool.end()
    await env.database.drop()
  }
  await rm(directory, { recursive: true, force: true })
})

describe('two environments on one server (D25)', () => {
  it('neither posts to, reads, deletes nor takes the other’s messages', async () => {
    const start = Date.now()
    discord.clock = () => start - 2 * 60 * 60_000
    const devCategory = discord.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
    const prodCategory = discord.addChannel({ name: 'DFS', type: ChannelType.GuildCategory })
    const devChannel = discord.addChannel({
      name: 'storage-00',
      type: ChannelType.GuildText,
      parent_id: devCategory.id,
    })
    const prodChannel = discord.addChannel({
      name: 'storage-00',
      type: ChannelType.GuildText,
      parent_id: prodCategory.id,
    })
    const loose = discord.addTextChannel('general')
    const dev = await environment('DFS Dev', 'dddddddddddd')
    const prod = await environment('DFS', 'eeeeeeeeeeee')
    await prod.db
      .insert(storageChannels)
      .values({ discordChannelId: prodChannel.id, name: 'storage-00' })
    // Development registers production's channel too, by mistake.
    await dev.db.insert(storageChannels).values([
      { discordChannelId: devChannel.id, name: 'storage-00' },
      { discordChannelId: prodChannel.id, name: 'theirs' },
    ])

    for (const env of [dev, prod]) {
      await uploadedFiles(env.db, env.staging, [100])
      await settleBlobs({
        db: env.db,
        staging: env.staging,
        store: storeFor(env),
        sizes: { blobMaxBytes: 4096, packTargetBytes: 4000 },
      })
    }
    // Each posted in its own category only.
    const devStored = await messageOf(dev)
    const prodStored = await messageOf(prod)
    expect(devStored.channel).toBe(devChannel.id)
    expect(prodStored.channel).toBe(prodChannel.id)

    // Planted: development's data messages where it never looks, and a
    // production orphan.
    const plant = (channelId: string, instance: string) =>
      discord.addMessage(channelId, `dfs1 b=424242 k=solo n=1 i=${instance}`)
    const devInLoose = plant(loose.id, dev.instance)
    const devInProd = plant(prodChannel.id, dev.instance)
    const prodOrphan = plant(prodChannel.id, prod.instance)

    discord.requests.length = 0
    const devReport = await reconcileOrphans({
      db: dev.db,
      rest: discord,
      instanceId: dev.instance,
      inCategory: await channelsInCategory(discord, discord.guildId, dev.category),
      now: start,
    })
    expect(devReport).toEqual({ checked: 1, deleted: 0, failed: 0 })
    const read = discord.requests.filter((request) => request.includes('/messages'))
    expect(read).toEqual([`GET /channels/${devChannel.id}/messages`])

    const prodReport = await reconcileOrphans({
      db: prod.db,
      rest: discord,
      instanceId: prod.instance,
      inCategory: await channelsInCategory(discord, discord.guildId, prod.category),
      now: start,
    })
    expect(prodReport).toEqual({ checked: 2, deleted: 1, failed: 0 })
    const left = discord.messages.map((message) => message.id)
    expect(left).toEqual(
      expect.arrayContaining([devStored.message, prodStored.message, devInLoose.id, devInProd.id]),
    )
    expect(left).not.toContain(prodOrphan.id)
  })
})
