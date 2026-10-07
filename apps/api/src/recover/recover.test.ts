import { collectGarbage } from '@dfs/bot/collector'
import { JournalUploader } from '@dfs/bot/journal-uploader'
import { dataChannels } from '@dfs/bot/storage'
import { settleBlobs } from '@dfs/bot/testing'
import {
  createDatabase,
  createPool,
  foldAllFolderStats,
  purgeUnneededVersions,
  storageChannels,
  users,
  type Database,
} from '@dfs/db'
import { createTestDatabase } from '@dfs/db/testing'
import {
  DiscordBlobStore,
  DiscordJournalStore,
  LocalBlobStore,
  LocalJournalStore,
  type BlobStore,
  type JournalStore,
} from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { moderate } from '../admin/browse.ts'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { readVersion, type ReadableVersion } from '../content/reader.ts'
import { flushJournal } from '../journal.ts'
import { deleteForever } from '../nodes/trash.ts'
import { createFolder, moveNodes, restoreNode, trashNodes, updateNode } from '../nodes/write.ts'
import { createShare, deleteShare, updateShare } from '../shares/shares.ts'
import { testConfig } from '../testing/config.ts'
import { completeUpload, createUploads, receivePart } from '../uploads/uploads.ts'
import { updateUserAsAdmin } from '../users/admin-users.ts'
import { createUser } from '../users/users.ts'
import { drillCommand } from './commands.ts'
import { compareDatabases } from './compare.ts'
import { foldJournal, settle as settleState } from './fold.ts'
import {
  categoryChannels,
  DiscordJournalSource,
  LocalJournalSource,
  type CategoryChannel,
  type FoundBatch,
  type JournalSource,
} from './journal-source.ts'
import { readJournal, RecoveryError } from './read-journal.ts'
import { highestLocalBlob, highestPostedBlob, recover } from './recover.ts'
import { writeRecovered } from './write.ts'

// The recovery drill (DESIGN.md §8, §17): a drive used every way the journal
// records, then rebuilt from the journal alone into an empty database, which
// must match the original column for column and read back byte for byte;
// once with the local blob store, and once with Discord (a Discord in
// memory), whose channels, messages and attachments recovery reads back.

/** Small parts and packs, so a file of a few hundred KB is several frames. */
const SIZES = {
  DISCORD_ATTACHMENT_LIMIT: '192KiB',
  PACK_THRESHOLD_BYTES: '16KiB',
  PACK_TARGET_BYTES: '120KiB',
}

interface Recovery {
  source: JournalSource
  channels: CategoryChannel[]
  blobIdFloor: (instanceId: string) => Promise<number>
}

/** An API on its database, with a blob store and a journal store, as the bot would use them. */
interface Stack {
  app: FastifyInstance
  store: BlobStore
  journal: JournalStore
  owner: Auth
  sam: Auth
  /** Where recovery reads this stack's journal and blobs. */
  recovery: () => Promise<Recovery>
  /** A new, migrated, empty database to recover into. */
  emptyDatabase: () => Promise<Database>
  close: () => Promise<void>
}

async function startStack(storage: 'local' | 'discord'): Promise<Stack> {
  const database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url, ...SIZES })
  const app = await buildApp({ config: setup.config, logger: false })
  const opened: { end: () => Promise<void>; drop: () => Promise<void> }[] = []
  const { rows } = await app.db.execute<{ id: string }>(sql`SELECT id FROM instance`)
  const instanceId = rows[0]?.id ?? ''

  let store: BlobStore = new LocalBlobStore(app.config.localBlobDir)
  let journal: JournalStore = new LocalJournalStore(app.config.localBlobDir)
  let recovery = (): Promise<Recovery> =>
    Promise.resolve({
      source: new LocalJournalSource(app.config.localBlobDir),
      channels: [],
      blobIdFloor: () => highestLocalBlob(app.config.localBlobDir),
    })
  if (storage === 'discord') {
    const discord = new FakeDiscord()
    const { categoryName } = app.config.discord
    const category = discord.addCategory(categoryName)
    for (const [name, kind] of [
      ['storage-00', 'data'],
      ['storage-01', 'data'],
      ['dfs-journal', 'journal'],
    ] as const) {
      const channel = discord.addTextChannel(name, category.id)
      await app.db.insert(storageChannels).values({ discordChannelId: channel.id, name, kind })
    }
    const [journalChannel] = await app.db
      .select()
      .from(storageChannels)
      .where(eq(storageChannels.kind, 'journal'))
    if (!journalChannel) throw new Error('No journal channel.')
    store = new DiscordBlobStore({
      rest: discord,
      channels: () => dataChannels(app.db),
      maxBytes: app.config.sizes.blobMaxBytes,
      instanceId: () => Promise.resolve(instanceId),
      perChannel: app.config.uploadChannelConcurrency,
      fetch: discord.fetch,
    })
    journal = new DiscordJournalStore({
      rest: discord,
      channel: () => Promise.resolve(journalChannel),
      instanceId: () => Promise.resolve(instanceId),
    })
    recovery = async () => {
      const channels = await categoryChannels(discord, discord.guildId, categoryName)
      return {
        source: new DiscordJournalSource({ rest: discord, channels, fetch: discord.fetch }),
        channels,
        blobIdFloor: (instance: string) => highestPostedBlob(discord, channels, instance),
      }
    }
  }

  const account = async (username: string, role: 'admin' | 'user', isOwner: boolean) => {
    // Made as the API makes one, journaled.
    await app.db.transaction((tx) =>
      createUser(tx, {
        username,
        displayName: `${username[0]?.toUpperCase() ?? ''}${username.slice(1)}`,
        passwordHash: 'not-a-real-hash',
        passwordExpiresAt: new Date(Date.now() + 86_400_000),
        role,
        quotaBytes: 10 * 1024 ** 3,
        isOwner,
      }),
    )
    const [user] = await app.db.select().from(users).where(eq(users.username, username))
    if (!user) throw new Error('Missing test user.')
    return {
      user,
      sessionId: 'test',
      csrfToken: 'test',
      expiresAt: new Date(Date.now() + 60_000),
      seenAt: null,
      limited: false,
    }
  }
  const owner = await account('owner', 'admin', true)
  const sam = await account('sam', 'user', false)
  // Never uploads anything: a root folder never folded, as production has.
  await account('quiet', 'user', false)

  return {
    app,
    store,
    journal,
    owner,
    sam,
    recovery,
    emptyDatabase: async () => {
      const target = await createTestDatabase(inject('testPostgres'))
      const pool = createPool(target.url, {
        applicationName: 'dfs-recover-test',
        onError: () => undefined,
      })
      opened.push({ end: () => pool.end(), drop: () => target.drop() })
      return createDatabase(pool)
    },
    close: async () => {
      await app.close()
      for (const entry of opened) {
        await entry.end()
        await entry.drop()
      }
      await database.drop()
      await setup.cleanup()
    },
  }
}

function root(auth: Auth): string {
  if (!auth.user.rootNodeId) throw new Error('Missing root folder.')
  return auth.user.rootNodeId
}

function bytes(size: number, seed: number): Buffer {
  return Buffer.from(Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) % 251))
}

/** An upload as the web app makes one: every part, then completion when there are several. */
async function upload(
  stack: Stack,
  auth: Auth,
  parentId: string,
  name: string,
  content: Buffer,
  modifiedAt?: string,
) {
  const { app } = stack
  const [result] = await createUploads(app, auth, [
    { parentId, name, sizeBytes: content.length, mimeType: 'application/octet-stream', modifiedAt },
  ])
  if (!result?.ok) throw new Error(`Upload of ${name} refused: ${JSON.stringify(result)}`)
  const { session } = result
  for (let index = 0; index < session.chunkCount; index += 1) {
    const start = index * session.chunkSize
    await receivePart(
      app,
      auth,
      session.uploadId,
      index,
      content.subarray(start, start + session.chunkSize),
      undefined,
    )
  }
  if (session.chunkCount !== 1) await completeUpload(app, auth, session.uploadId)
  return session
}

/** Everything the journal records: accounts, the tree, files, versions, links, trash, moderation. */
async function useTheDrive(stack: Stack): Promise<void> {
  const { app, owner, sam } = stack
  const photos = await createFolder(app, owner, root(owner), 'Photos')
  const year = await createFolder(app, owner, photos.id, '2024')
  const docs = await createFolder(app, owner, root(owner), 'Docs')
  const archive = await createFolder(app, owner, root(owner), 'Archive')

  // Small files go into packs, larger ones into blobs of their own.
  await upload(stack, owner, year.id, 'beach.jpg', bytes(9_000, 1), '2024-07-01T10:00:00.000Z')
  await upload(stack, owner, year.id, 'tram.jpg', bytes(12_000, 2))
  await upload(stack, owner, docs.id, 'empty.txt', Buffer.alloc(0))
  await upload(stack, owner, docs.id, 'thesis.pdf', bytes(150_000, 3), '2023-05-05T05:05:05.000Z')
  await upload(stack, owner, archive.id, 'old-backup.zip', bytes(140_000, 4))

  // Renamed, moved; a folder moved with what is in it.
  const notes = await upload(stack, owner, docs.id, 'notes.txt', bytes(2_000, 5))
  await updateNode(app, owner, notes.nodeId, { name: 'Notes 2024.txt' })
  await moveNodes(app, owner, [year.id], docs.id)

  // Replaced with a link serving the first version, and without one.
  const report = await upload(stack, owner, docs.id, 'report.txt', bytes(3_000, 6))
  const pinned = await createShare(app, owner, {
    nodeId: report.nodeId,
    expiresAt: null,
    password: null,
    maxDownloads: 10,
  })
  await upload(stack, owner, docs.id, 'report.txt', bytes(3_500, 7))
  await upload(stack, owner, docs.id, 'draft.txt', bytes(1_000, 8))
  await upload(stack, owner, docs.id, 'draft.txt', bytes(1_100, 9))
  const kept = await upload(stack, owner, docs.id, 'contract.txt', bytes(800, 10))
  const keptLink = await createShare(app, owner, {
    nodeId: kept.nodeId,
    expiresAt: '2030-01-01T00:00:00.000Z',
    password: 'a link password',
    maxDownloads: null,
  })
  await upload(stack, owner, docs.id, 'contract.txt', bytes(900, 11))
  await updateShare(app, owner, keptLink.id, { maxDownloads: 4 })
  // Turned off, the first link goes, and the version it kept goes with the janitor.
  await deleteShare(app, owner, pinned.id)
  const folderLink = await createShare(app, owner, {
    nodeId: photos.id,
    expiresAt: null,
    password: null,
    maxDownloads: null,
  })
  await updateShare(app, owner, folderLink.id, { expiresAt: '2031-02-03T04:05:06.000Z' })

  // The trash: a file and back, a folder with what is in it, and deleted for good.
  await trashNodes(app, owner, [notes.nodeId])
  await restoreNode(app, owner, notes.nodeId)
  await trashNodes(app, owner, [photos.id])
  await trashNodes(app, owner, [archive.id])
  await deleteForever(app, owner, archive.id)

  // Another user: files, a link, an item removed by the admin with its link.
  const music = await createFolder(app, sam, root(sam), 'Music')
  const song = await upload(stack, sam, music.id, 'song.mp3', bytes(70_000, 12))
  await upload(stack, sam, root(sam), 'cv.txt', bytes(4_000, 13))
  await createShare(app, sam, {
    nodeId: song.nodeId,
    expiresAt: null,
    password: null,
    maxDownloads: null,
  })
  await moderate(app, owner, music.id, 'Not allowed here.')
  await updateUserAsAdmin(app, owner, sam.user.id, { quotaBytes: 5 * 1024 ** 3 })
}

/** What the leading bot does over time: store blobs, drop what no link needs, delete released blobs, post the journal. */
async function settleStack({ app, store, journal }: Stack): Promise<void> {
  await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
  for (const versionId of await purgeUnneededVersions(app.db)) {
    await app.staging.removeVersion(versionId)
  }
  // Small batches, so a record too large for one is cut into pieces. Released
  // blobs are deleted once the journal saying why is posted, and that is posted too.
  const postJournal = async () => {
    await flushJournal(app, { maxBytes: 1500 })
    await new JournalUploader({ db: app.db, journal }).run()
  }
  await postJournal()
  while ((await collectGarbage({ db: app.db, store, staging: app.staging }, 100)) > 0);
  const { rows } = await app.db.execute<{ waiting: number }>(sql`
    SELECT count(*)::int AS waiting FROM blobs WHERE state = 'deleting'`)
  if (rows[0]?.waiting !== 0)
    throw new Error('Released blobs were left once the journal was posted.')
  await foldAllFolderStats(app.db)
  await postJournal()
}

/** Every version's bytes, as an app on `db` reads them. */
async function contents(reader: FastifyInstance, db: Database): Promise<Map<string, string>> {
  const { rows } = await db.execute<ReadableVersion>(sql`
    SELECT id AS version_id, size_bytes::float8 AS size_bytes, chunk_size, chunk_count,
      wrapped_dek, key_id FROM file_versions ORDER BY id`)
  const read = new Map<string, string>()
  for (const version of rows) {
    const parts: Uint8Array[] = []
    for await (const part of readVersion(reader, version, 0, version.size_bytes - 1)) {
      parts.push(part)
    }
    read.set(version.version_id, Buffer.concat(parts).toString('hex'))
  }
  return read
}

for (const storage of ['local', 'discord'] as const) {
  describe(`recovery from the journal alone, with ${storage} storage (§8)`, () => {
    let stack: Stack

    beforeAll(async () => {
      stack = await startStack(storage)
      await useTheDrive(stack)
      await settleStack(stack)
    })

    afterAll(async () => {
      await stack.close()
    })

    it('rebuilds the database column for column', async () => {
      const target = await stack.emptyDatabase()
      const report = await recover({
        db: target,
        keys: stack.app.keys,
        ...(await stack.recovery()),
      })
      expect(report.settled).toEqual({
        droppedFiles: [],
        rolledBack: [],
        unreadableVersions: [],
        orphans: [],
      })
      expect(report.batches).toBeGreaterThan(1)
      expect(await compareDatabases(stack.app.db, target)).toEqual([])

      if (storage === 'discord') return
      // An app on the rebuilt database reads every file from the blobs as they are.
      const { rows } = await target.execute<{ url: string }>(sql`SELECT current_database() AS url`)
      const url = new URL(stack.app.config.databaseUrl)
      url.pathname = `/${rows[0]?.url ?? ''}`
      const setup = await testConfig({
        DATABASE_URL: url.href,
        LOCAL_BLOB_DIR: stack.app.config.localBlobDir,
        MASTER_KEY_FILE: stack.app.config.masterKeyFile,
        ...SIZES,
      })
      const reader = await buildApp({ config: setup.config, logger: false })
      try {
        const recovered = await contents(reader, target)
        expect(recovered.size).toBeGreaterThan(5)
        expect(recovered).toEqual(await contents(stack.app, stack.app.db))
      } finally {
        await reader.close()
        await setup.cleanup()
      }
    })

    if (storage === 'discord') return

    it('runs as `dfs drill`: into a database of its own, compared, then dropped', async () => {
      const databases = async () => {
        const { rows } = await stack.app.db.execute<{ name: string }>(sql`
          SELECT datname AS name FROM pg_database WHERE datname LIKE 'dfs_drill_%'`)
        return rows.map((row) => row.name)
      }
      const before = await databases()
      expect(
        await drillCommand(stack.app.config, {
          from: 'local',
          keyFile: stack.app.config.masterKeyFile,
        }),
      ).toBe(true)
      expect(await databases()).toEqual(before)
    })

    it('rebuilds from records written before they said a version’s maker and frames', async () => {
      const { app } = stack
      const journal = await readJournal(app.keys, (await stack.recovery()).source)
      // As production's first records are.
      for (const entry of journal.entries) {
        if (entry.kind === 'blob.stored') delete entry.record.frameCount
        if (entry.kind === 'version.stored') {
          delete entry.record.createdBy
          delete entry.record.createdAt
        }
      }
      const state = foldJournal(journal.entries)
      settleState(state)
      const target = await stack.emptyDatabase()
      await writeRecovered(target, {
        state,
        instanceId: journal.instanceId,
        batches: journal.batches,
        channels: [],
        blobIdFloor: 0,
      })
      // A later version's making is unknown: it was journaled when stored. So
      // is how many frames a pack held once some went: those left are counted.
      const { rows: later } = await app.db.execute<{ id: string }>(sql`
        SELECT id FROM file_versions WHERE version_no > 1 ORDER BY id`)
      const { rows: thinned } = await app.db.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM blobs
        WHERE kind = 'pack' AND state <> 'deleted'
          AND frame_count <> (SELECT count(*) FROM chunks WHERE blob_id = blobs.id)
        ORDER BY id`)
      const differences = await compareDatabases(app.db, target)
      expect(differences.map(({ table, column, key }) => ({ table, column, key }))).toEqual([
        ...later.map((row) => ({ table: 'file_versions', column: 'created_at', key: row.id })),
        ...thinned.map((row) => ({ table: 'blobs', column: 'frame_count', key: row.id })),
      ])
    })

    it('reads a batch posted twice once, and refuses one missing or changed', async () => {
      const { app } = stack
      const { source } = await stack.recovery()
      const batches: FoundBatch[] = []
      for await (const batch of source.batches()) batches.push(batch)
      const second = batches.find((batch) => batch.batchNo === 2)
      if (!second) throw new Error('No second batch.')
      const from = (found: FoundBatch[]): JournalSource => ({
        describe: 'a test',
        batches: () => found,
      })
      expect((await readJournal(app.keys, from([...batches, second]))).duplicates).toEqual([2])

      const flipped = Uint8Array.from(second.bytes, (byte, index) =>
        index === 0 ? byte : byte ^ 1,
      )
      await expect(
        readJournal(app.keys, from([...batches, { ...second, bytes: flipped }])),
      ).rejects.toThrow(/found twice with different contents/)

      const gap = from(batches.filter((batch) => batch.batchNo !== 2))
      await expect(readJournal(app.keys, gap)).rejects.toThrow(/missing: 2\./)
      await expect(readJournal(app.keys, gap)).rejects.toBeInstanceOf(RecoveryError)
    })

    it('asks which database to recover when the journal channel holds another’s too', async () => {
      const { app } = stack
      const discord = new FakeDiscord()
      const channel = discord.addTextChannel('dfs-journal', discord.addCategory('DFS Test').id)
      const posting = (instanceId: string) =>
        new DiscordJournalStore({
          rest: discord,
          channel: () => Promise.resolve({ id: 'local', discordChannelId: channel.id }),
          instanceId: () => Promise.resolve(instanceId),
        })
      const { rows } = await app.db.execute<{ id: string }>(sql`SELECT id FROM instance`)
      const mine = rows[0]?.id ?? ''
      const local = (await stack.recovery()).source
      const fromFolder = await readJournal(app.keys, local)
      for await (const batch of local.batches()) {
        const read = fromFolder.batches.find((entry) => entry.batchNo === batch.batchNo)
        if (!read) continue
        await posting(mine).put(
          { batchNo: batch.batchNo, firstId: read.firstId, lastId: read.lastId },
          batch.bytes,
        )
      }
      // Another database's batch in the same channel, as development stacks share one.
      await posting('0123456789ab').put({ batchNo: 1, firstId: 1, lastId: 1 }, Uint8Array.of(1))

      const source = new DiscordJournalSource({
        rest: discord,
        channels: [{ discordChannelId: channel.id, name: 'dfs-journal', kind: 'journal' }],
        fetch: discord.fetch,
      })
      await expect(readJournal(app.keys, source)).rejects.toThrow(
        /Say which to recover with --instance/,
      )
      const fromDiscord = await readJournal(app.keys, source, { instanceId: mine })
      expect(fromDiscord.entries).toEqual(fromFolder.entries)
    })

    it('refuses a database that isn’t empty', async () => {
      await expect(
        recover({ db: stack.app.db, keys: stack.app.keys, ...(await stack.recovery()) }),
      ).rejects.toThrow(/isn’t empty/)
    })

    // Last: it leaves the drive with a file the journal can't rebuild.
    it('drops, and lists, a file whose version never reached Discord', async () => {
      const { app, owner, journal } = stack
      const pending = await upload(stack, owner, root(owner), 'unsynced.bin', bytes(30_000, 14))
      // Journaled as the current version, its blob never stored: the VPS was lost first.
      await flushJournal(app)
      await new JournalUploader({ db: app.db, journal }).run()
      const report = await recover({
        db: await stack.emptyDatabase(),
        keys: app.keys,
        ...(await stack.recovery()),
      })
      expect(report.settled.droppedFiles).toEqual([
        { id: pending.nodeId, ownerId: owner.user.id, name: 'unsynced.bin' },
      ])
    })
  })
}
