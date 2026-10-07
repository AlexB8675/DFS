import { collectGarbage } from '@dfs/bot/collector'
import { JournalUploader } from '@dfs/bot/journal-uploader'
import { settleBlobs } from '@dfs/bot/testing'
import {
  createDatabase,
  createPool,
  foldAllFolderStats,
  purgeUnneededVersions,
  users,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordJournalStore, LocalBlobStore, LocalJournalStore } from '@dfs/storage'
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
import {
  DiscordJournalSource,
  LocalJournalSource,
  type FoundBatch,
  type JournalSource,
} from './journal-source.ts'
import { readJournal, RecoveryError } from './read-journal.ts'
import { highestLocalBlob, recover } from './recover.ts'

// The recovery drill (DESIGN.md §8, §17): a drive used every way the journal
// records, then rebuilt from the journal alone into an empty database, which
// must match the original column for column and read back byte for byte.

let source: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let owner: Auth
let sam: Auth
const opened: { pool: { end: () => Promise<void> }; database: TestDatabase }[] = []

/** Small parts and packs, so a file of a few hundred KB is several frames. */
const SIZES = {
  DISCORD_ATTACHMENT_LIMIT: '192KiB',
  PACK_THRESHOLD_BYTES: '16KiB',
  PACK_TARGET_BYTES: '120KiB',
}

beforeAll(async () => {
  source = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: source.url, ...SIZES })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  owner = await account('owner', 'admin', true)
  sam = await account('sam', 'user', false)
  await useTheDrive()
  await settle()
})

afterAll(async () => {
  await app.close()
  for (const { pool, database } of opened) {
    await pool.end()
    await database.drop()
  }
  await source.drop()
  await cleanup()
})

/** An account made as the API makes one, journaled. */
async function account(username: string, role: 'admin' | 'user', isOwner: boolean): Promise<Auth> {
  await app.db.transaction((tx) =>
    createUser(tx, {
      username,
      displayName: username === 'sam' ? 'Sam Rivera' : 'The Owner',
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

function root(auth: Auth): string {
  if (!auth.user.rootNodeId) throw new Error('Missing root folder.')
  return auth.user.rootNodeId
}

function bytes(size: number, seed: number): Buffer {
  return Buffer.from(Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) % 251))
}

/** An upload as the web app makes one: every part, then completion when there are several. */
async function upload(
  auth: Auth,
  parentId: string,
  name: string,
  content: Buffer,
  modifiedAt?: string,
) {
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
async function useTheDrive(): Promise<void> {
  const photos = await createFolder(app, owner, root(owner), 'Photos')
  const year = await createFolder(app, owner, photos.id, '2024')
  const docs = await createFolder(app, owner, root(owner), 'Docs')
  const archive = await createFolder(app, owner, root(owner), 'Archive')

  // Small files go into packs, larger ones into blobs of their own.
  await upload(owner, year.id, 'beach.jpg', bytes(9_000, 1), '2024-07-01T10:00:00.000Z')
  await upload(owner, year.id, 'tram.jpg', bytes(12_000, 2))
  await upload(owner, docs.id, 'empty.txt', Buffer.alloc(0))
  await upload(owner, docs.id, 'thesis.pdf', bytes(150_000, 3), '2023-05-05T05:05:05.000Z')
  await upload(owner, archive.id, 'old-backup.zip', bytes(140_000, 4))

  // Renamed, moved; a folder moved with what is in it.
  const notes = await upload(owner, docs.id, 'notes.txt', bytes(2_000, 5))
  await updateNode(app, owner, notes.nodeId, { name: 'Notes 2024.txt' })
  await moveNodes(app, owner, [year.id], docs.id)

  // Replaced with a link serving the first version, and without one.
  const report = await upload(owner, docs.id, 'report.txt', bytes(3_000, 6))
  const pinned = await createShare(app, owner, {
    nodeId: report.nodeId,
    expiresAt: null,
    password: null,
    maxDownloads: 10,
  })
  await upload(owner, docs.id, 'report.txt', bytes(3_500, 7))
  await upload(owner, docs.id, 'draft.txt', bytes(1_000, 8))
  await upload(owner, docs.id, 'draft.txt', bytes(1_100, 9))
  const kept = await upload(owner, docs.id, 'contract.txt', bytes(800, 10))
  const keptLink = await createShare(app, owner, {
    nodeId: kept.nodeId,
    expiresAt: '2030-01-01T00:00:00.000Z',
    password: 'a link password',
    maxDownloads: null,
  })
  await upload(owner, docs.id, 'contract.txt', bytes(900, 11))
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
  const song = await upload(sam, music.id, 'song.mp3', bytes(70_000, 12))
  await upload(sam, root(sam), 'cv.txt', bytes(4_000, 13))
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
async function settle(): Promise<void> {
  const store = new LocalBlobStore(app.config.localBlobDir)
  await settleBlobs({ db: app.db, staging: app.staging, store, sizes: app.config.sizes })
  for (const versionId of await purgeUnneededVersions(app.db)) {
    await app.staging.removeVersion(versionId)
  }
  while ((await collectGarbage({ db: app.db, store, staging: app.staging }, 100)) > 0);
  await foldAllFolderStats(app.db)
  // Small batches, so a record too large for one is cut into pieces.
  await flushJournal(app, { maxBytes: 1500 })
  await new JournalUploader({
    db: app.db,
    journal: new LocalJournalStore(app.config.localBlobDir),
  }).run()
}

/** A new, migrated, empty database to recover into. */
async function emptyDatabase(): Promise<Database> {
  const database = await createTestDatabase(inject('testPostgres'))
  const pool = createPool(database.url, {
    applicationName: 'dfs-recover-test',
    onError: () => undefined,
  })
  opened.push({ pool, database })
  return createDatabase(pool)
}

function recoverFrom(db: Database, journal: JournalSource, instanceId?: string) {
  return recover({
    db,
    keys: app.keys,
    source: journal,
    instanceId,
    channels: [],
    blobIdFloor: () => highestLocalBlob(app.config.localBlobDir),
  })
}

async function databases(): Promise<string[]> {
  const { rows } = await app.db.execute<{ name: string }>(sql`
    SELECT datname AS name FROM pg_database WHERE datname LIKE 'dfs_drill_%' ORDER BY datname`)
  return rows.map((row) => row.name)
}

/** Every version's bytes, as an app on `db` reads them. */
async function contents(reader: FastifyInstance, db: Database): Promise<Map<string, string>> {
  const { rows } = await db.execute<ReadableVersion>(sql`
    SELECT id AS version_id, size_bytes::float8 AS size_bytes, chunk_size, chunk_count,
      wrapped_dek, key_id FROM file_versions ORDER BY id`)
  const read = new Map<string, string>()
  for (const version of rows) {
    const parts: Uint8Array[] = []
    for await (const part of readVersion(reader, version, 0, version.size_bytes - 1))
      parts.push(part)
    read.set(version.version_id, Buffer.concat(parts).toString('hex'))
  }
  return read
}

describe('recovery from the journal alone (§8)', () => {
  it('rebuilds the database column for column, and every file byte for byte', async () => {
    const target = await emptyDatabase()
    const report = await recoverFrom(target, new LocalJournalSource(app.config.localBlobDir))
    expect(report.settled).toEqual({
      droppedFiles: [],
      rolledBack: [],
      lostVersions: [],
      orphans: [],
    })
    expect(report.batches).toBeGreaterThan(1)
    expect(await compareDatabases(app.db, target)).toEqual([])

    // An app on the rebuilt database reads every file from the blobs as they are.
    const setup = await testConfig({
      DATABASE_URL: opened.at(-1)?.database.url ?? '',
      LOCAL_BLOB_DIR: app.config.localBlobDir,
      MASTER_KEY_FILE: app.config.masterKeyFile,
      ...SIZES,
    })
    const reader = await buildApp({ config: setup.config, logger: false })
    try {
      const recovered = await contents(reader, target)
      expect(recovered.size).toBeGreaterThan(5)
      expect(recovered).toEqual(await contents(app, app.db))
    } finally {
      await reader.close()
      await setup.cleanup()
    }
  })

  it('runs as `dfs drill`: into a database of its own, compared, then dropped', async () => {
    const before = await databases()
    expect(
      await drillCommand(app.config, { from: 'local', keyFile: app.config.masterKeyFile }),
    ).toBe(true)
    expect(await databases()).toEqual(before)
  })

  it('reads a batch posted twice once, and refuses one missing or changed', async () => {
    const local = new LocalJournalSource(app.config.localBlobDir)
    const batches: FoundBatch[] = []
    for await (const batch of local.batches()) batches.push(batch)
    const second = batches.find((batch) => batch.batchNo === 2)
    if (!second) throw new Error('No second batch.')
    const twice: JournalSource = {
      describe: 'a test',
      *batches() {
        yield* batches
        yield second
      },
    }
    expect((await readJournal(app.keys, twice)).duplicates).toEqual([2])

    const changed: JournalSource = {
      describe: 'a test',
      *batches() {
        yield* batches
        yield {
          ...second,
          bytes: Uint8Array.from(second.bytes, (byte, index) => (index === 0 ? byte : byte ^ 1)),
        }
      },
    }
    await expect(readJournal(app.keys, changed)).rejects.toThrow(
      /found twice with different contents/,
    )

    const gap: JournalSource = {
      describe: 'a test',
      *batches() {
        yield* batches.filter((batch) => batch.batchNo !== 2)
      },
    }
    await expect(readJournal(app.keys, gap)).rejects.toThrow(/missing: 2\./)
    await expect(readJournal(app.keys, gap)).rejects.toBeInstanceOf(RecoveryError)
  })

  it('reads the journal from Discord as from the folder, one database among several', async () => {
    const discord = new FakeDiscord()
    const category = discord.addCategory('DFS Test')
    const channel = discord.addTextChannel('dfs-journal', category.id)
    const posting = (instanceId: string) =>
      new DiscordJournalStore({
        rest: discord,
        channel: () => Promise.resolve({ id: 'local', discordChannelId: channel.id }),
        instanceId: () => Promise.resolve(instanceId),
      })
    const { rows } = await app.db.execute<{ id: string }>(sql`SELECT id FROM instance`)
    const mine = rows[0]?.id ?? ''
    const local = new LocalJournalSource(app.config.localBlobDir)
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
    await posting('0123456789ab').put({ batchNo: 1, firstId: 1, lastId: 1 }, Uint8Array.of(1, 2, 3))

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
    expect(fromDiscord.batches.every((batch) => batch.message?.messageId)).toBe(true)
  })

  it('drops, and lists, a file whose version never reached Discord', async () => {
    const pending = await upload(owner, root(owner), 'unsynced.bin', bytes(30_000, 14))
    // Journaled as the current version, its blob never stored: the VPS was lost first.
    await flushJournal(app)
    await new JournalUploader({
      db: app.db,
      journal: new LocalJournalStore(app.config.localBlobDir),
    }).run()
    const report = await recoverFrom(
      await emptyDatabase(),
      new LocalJournalSource(app.config.localBlobDir),
    )
    expect(report.settled.droppedFiles).toEqual([
      { id: pending.nodeId, ownerId: owner.user.id, name: 'unsynced.bin' },
    ])
  })

  it('refuses a database that isn’t empty', async () => {
    await expect(
      recoverFrom(app.db, new LocalJournalSource(app.config.localBlobDir)),
    ).rejects.toThrow(/isn’t empty/)
  })
})
