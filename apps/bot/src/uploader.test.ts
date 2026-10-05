import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  chunks,
  createDatabase,
  createPool,
  fileVersions,
  nodes,
  storageChannels,
  users,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordBlobStore, LocalBlobStore, Staging } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { dataChannels } from './storage.ts'
import { storeBlobs } from './uploader.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Database
let directory: string
let staging: Staging
let store: LocalBlobStore

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-uploader-test', onError: vi.fn() })
  db = createDatabase(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-uploader-'))
  staging = new Staging(path.join(directory, 'staging'))
  store = new LocalBlobStore(path.join(directory, 'stored'))
})

afterAll(async () => {
  await pool.end()
  await database.drop()
  await rm(directory, { recursive: true, force: true })
})

async function staged(bytes = new Uint8Array([1, 2, 3, 4])) {
  const stagedPath = staging.framePath(crypto.randomUUID(), 0)
  const hash = createHash('sha256').update(bytes).digest()
  const {
    rows: [blob],
  } = await db.execute<{ id: number }>(sql`
    INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, sha256, staged_path)
    VALUES ('solo', 'staged', ${bytes.length}, ${bytes.length}, 1, ${hash}, ${stagedPath})
    RETURNING id::float8 AS id`)
  if (!blob) throw new Error('No test blob created.')
  await staging.write(stagedPath, bytes)
  return { id: blob.id, stagedPath, bytes }
}

/** A file with one syncing version of `chunkCount` parts, owned by a new user. */
async function syncingVersion(chunkCount: number, sizeBytes: number) {
  const [owner] = await db
    .insert(users)
    .values({
      username: crypto.randomUUID(),
      displayName: 'Test',
      passwordHash: 'unused',
      quotaBytes: 1024,
    })
    .returning()
  if (!owner) throw new Error('No test owner.')
  const [root] = await db
    .insert(nodes)
    .values({ ownerId: owner.id, kind: 'folder', name: '', nameKey: '' })
    .returning()
  if (!root) throw new Error('No test root.')
  const [node] = await db
    .insert(nodes)
    .values({
      ownerId: owner.id,
      parentId: root.id,
      kind: 'file',
      name: 'file.bin',
      nameKey: 'file.bin',
      sizeBytes,
    })
    .returning()
  if (!node) throw new Error('No test node.')
  const [version] = await db
    .insert(fileVersions)
    .values({
      nodeId: node.id,
      versionNo: 1,
      state: 'syncing',
      sizeBytes,
      chunkSize: sizeBytes,
      chunkCount,
      wrappedDek: Buffer.alloc(60),
      keyId: 'k1',
      createdBy: owner.id,
    })
    .returning()
  if (!version) throw new Error('No test version.')
  await db.update(nodes).set({ currentVersionId: version.id }).where(eq(nodes.id, node.id))
  return version
}

describe('blob pipeline', () => {
  it('clears a stored version from staging, with files an interrupted attempt left', async () => {
    const bytes = new Uint8Array([7, 7, 7, 7])
    const hash = createHash('sha256').update(bytes).digest()
    const version = await syncingVersion(1, bytes.length)
    const stagedPath = staging.framePath(version.id, 0)
    // A crash between writing a part and recording it leaves its file behind.
    const leftover = `${stagedPath}.${crypto.randomUUID()}`
    const {
      rows: [blob],
    } = await db.execute<{ id: number }>(sql`
      INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, sha256, staged_path)
      VALUES ('solo', 'staged', ${bytes.length}, ${bytes.length}, 1, ${hash}, ${stagedPath})
      RETURNING id::float8 AS id`)
    if (!blob) throw new Error('No test blob created.')
    await staging.write(stagedPath, bytes)
    await staging.write(leftover, bytes)
    await db.insert(chunks).values({
      versionId: version.id,
      idx: 0,
      plainSize: bytes.length,
      frameSize: bytes.length,
      plainSha256: hash,
      frameSha256: hash,
      blobId: blob.id,
      blobOffset: 0,
      stagedPath,
    })

    expect(await storeBlobs({ db, staging, store }, [blob.id])).toEqual(new Map())
    const { rows } = await db.execute(sql`SELECT state FROM file_versions WHERE id = ${version.id}`)
    expect(rows).toEqual([{ state: 'stored' }])
    await expect(readdir(path.join(staging.root, 'frames', version.id))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('counts concurrent parts once and notifies completion even when final staging cleanup fails', async () => {
    const blobs = await Promise.all(Array.from({ length: 4 }, () => staged()))
    const [owner] = await db
      .insert(users)
      .values({
        username: crypto.randomUUID(),
        displayName: 'Test',
        passwordHash: 'unused',
        quotaBytes: 1024,
      })
      .returning()
    if (!owner) throw new Error('No test owner.')
    const [root] = await db
      .insert(nodes)
      .values({ ownerId: owner.id, kind: 'folder', name: '', nameKey: '' })
      .returning()
    if (!root) throw new Error('No test root.')
    const [node] = await db
      .insert(nodes)
      .values({
        ownerId: owner.id,
        parentId: root.id,
        kind: 'file',
        name: 'parallel.bin',
        nameKey: 'parallel.bin',
        sizeBytes: 16,
      })
      .returning()
    if (!node) throw new Error('No test node.')
    const [version] = await db
      .insert(fileVersions)
      .values({
        nodeId: node.id,
        versionNo: 1,
        state: 'syncing',
        sizeBytes: 16,
        chunkSize: 4,
        chunkCount: 4,
        wrappedDek: Buffer.alloc(60),
        keyId: 'k1',
        createdBy: owner.id,
      })
      .returning()
    if (!version) throw new Error('No test version.')
    await db.update(nodes).set({ currentVersionId: version.id }).where(eq(nodes.id, node.id))
    await db.insert(chunks).values(
      blobs.map((blob, index) => ({
        versionId: version.id,
        idx: index,
        plainSize: 4,
        frameSize: 4,
        plainSha256: createHash('sha256').update(blob.bytes).digest(),
        frameSha256: createHash('sha256').update(blob.bytes).digest(),
        blobId: blob.id,
        blobOffset: 0,
        stagedPath: blob.stagedPath,
      })),
    )
    const listener = new pg.Client({ connectionString: database.url })
    const events: unknown[] = []
    listener.on('notification', (message) => {
      if (message.payload) events.push(JSON.parse(message.payload))
    })
    await listener.connect()
    const last = blobs.at(-1)
    if (!last) throw new Error('Missing final test blob.')
    const release = Promise.withResolvers<undefined>()
    const cleanupError = new Error('Staging file is temporarily locked.')
    const put = store.put.bind(store)
    const remove = staging.remove.bind(staging)
    const log = { warn: vi.fn() }
    let cleaned = 0
    const writing = vi.spyOn(store, 'put').mockImplementation(async (blob, data) => {
      if (blob.id === last.id) await release.promise
      return put(blob, data)
    })
    const cleanup = vi.spyOn(staging, 'remove').mockImplementation(async (file) => {
      if (file === last.stagedPath) throw cleanupError
      await remove(file)
      if (++cleaned === 3) release.resolve(undefined)
    })
    try {
      await listener.query('LISTEN dfs_events')
      const ids = blobs.map((blob) => blob.id)
      expect(await storeBlobs({ db, staging, store, log }, ids, 4)).toEqual(new Map())
      expect(await storeBlobs({ db, staging, store, log }, ids, 4)).toEqual(new Map())
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        { err: cleanupError, blobId: last.id, stagedPath: last.stagedPath },
        'could not remove a staged file after storing its blob',
      )
      const { rows } = await db.execute(
        sql`SELECT state, chunks_stored FROM file_versions WHERE id = ${version.id}`,
      )
      expect(rows).toEqual([{ state: 'stored', chunks_stored: 4 }])
      const { rows: records } = await db.execute(
        sql`SELECT count(*)::int AS count FROM journal WHERE kind = 'version.stored' AND record->>'id' = ${version.id}`,
      )
      expect(records).toEqual([{ count: 1 }])
      await vi.waitFor(() => {
        expect(events).toHaveLength(1)
      })
      expect(events[0]).toMatchObject({
        userId: owner.id,
        type: 'nodes.synced',
        payload: { nodes: [{ id: node.id, syncState: 'stored' }] },
      })
      const { rows: receipts } = await db.execute(
        sql`SELECT staged_path FROM chunks WHERE version_id = ${version.id}`,
      )
      expect(receipts).toEqual(Array.from({ length: 4 }, () => ({ staged_path: null })))
      expect(await staging.read(last.stagedPath)).toEqual(last.bytes)
      await remove(last.stagedPath)
    } finally {
      release.resolve(undefined)
      writing.mockRestore()
      cleanup.mockRestore()
      await listener.end()
    }
  })

  it('bounds concurrency, deduplicates jobs, and retries only failures without losing bytes', async () => {
    const blobs = await Promise.all(
      Array.from({ length: 5 }, (_, index) => staged(new Uint8Array(128).fill(index))),
    )
    const failed = blobs[1]
    const duplicate = blobs[0]
    if (!failed || !duplicate) throw new Error('Missing test blob.')
    const release = Promise.withResolvers<undefined>()
    const put = store.put.bind(store)
    const error = new Error('Temporary store failure.')
    let active = 0
    let maximum = 0
    const spy = vi.spyOn(store, 'put').mockImplementation(async (blob, data) => {
      active += 1
      maximum = Math.max(maximum, active)
      try {
        await release.promise
        if (blob.id === failed.id) throw error
        return await put(blob, data)
      } finally {
        active -= 1
      }
    })
    const storing = storeBlobs(
      { db, staging, store },
      [...blobs.map((blob) => blob.id), duplicate.id],
      2,
    )
    try {
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(2)
      })
      expect(active).toBe(2)
      release.resolve(undefined)
      expect(await storing).toEqual(new Map([[failed.id, error]]))
      expect(maximum).toBe(2)
      expect(spy).toHaveBeenCalledTimes(5)
      expect(await staging.read(failed.stagedPath)).toEqual(failed.bytes)
      for (const blob of blobs.filter((blob) => blob !== failed)) {
        expect(
          await store.read(
            { id: blob.id, channelId: null, messageId: null, attachmentId: null },
            0,
            blob.bytes.length,
          ),
        ).toEqual(blob.bytes)
        await expect(staging.read(blob.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      release.resolve(undefined)
      await storing
      spy.mockRestore()
    }
    expect(
      await storeBlobs(
        { db, staging, store },
        blobs.map((blob) => blob.id),
      ),
    ).toEqual(new Map())
    const { rows } = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM journal
      WHERE kind = 'blob.stored' AND (record->>'id')::bigint IN (${sql.join(
        blobs.map((blob) => sql`${blob.id}`),
        sql`, `,
      )})`)
    expect(rows).toEqual([{ count: 5 }])
  })

  it('rejects invalid concurrency without consuming a staged blob', async () => {
    for (const concurrency of [0, -1, 1.5, Infinity]) {
      await expect(storeBlobs({ db, staging, store }, [], concurrency)).rejects.toThrow(
        /positive integer/,
      )
    }
    expect(await storeBlobs({ db, staging, store }, [], 2)).toEqual(new Map())
  })
})

describe('staged blob integrity', () => {
  it('keeps a same-size corrupt blob staged until the original bytes can be stored', async () => {
    const original = new Uint8Array([1, 2, 3, 4])
    const hash = createHash('sha256').update(original).digest()
    const stagedPath = staging.framePath(crypto.randomUUID(), 0)
    const {
      rows: [blob],
    } = await db.execute<{ id: number }>(sql`
      INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, sha256, staged_path)
      VALUES ('solo', 'staged', 4, 4, 1, ${hash}, ${stagedPath})
      RETURNING id::float8 AS id`)
    if (!blob) throw new Error('No test blob created.')
    const corrupt = new Uint8Array([1, 2, 3, 5])
    await staging.write(stagedPath, corrupt)
    const put = vi.spyOn(store, 'put')
    try {
      const failures = await storeBlobs({ db, staging, store }, [blob.id])
      expect(failures.get(blob.id)?.message).toMatch(/corrupt/)
      // The store asked for the bytes, and the check stopped them reaching it.
      const where = { id: blob.id, channelId: null, messageId: null, attachmentId: null }
      await expect(store.read(where, 0, 4)).rejects.toThrow()
      expect(await staging.read(stagedPath)).toEqual(corrupt)
      const { rows } = await db.execute<{ state: string; staged_path: string }>(sql`
        SELECT state, staged_path FROM blobs WHERE id = ${blob.id}`)
      expect(rows).toEqual([{ state: 'staged', staged_path: stagedPath }])

      await staging.write(stagedPath, original)
      expect(await storeBlobs({ db, staging, store }, [blob.id])).toEqual(new Map())
      expect(put).toHaveBeenCalledTimes(2)
      expect(await store.read(where, 0, 4)).toEqual(original)
      await expect(staging.read(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      put.mockRestore()
    }
  })

  it('journals where a blob went by Discord’s own IDs, which mean something without the database', async () => {
    const discord = new FakeDiscord()
    const channel = discord.addTextChannel('storage-00')
    await db.insert(storageChannels).values({ discordChannelId: channel.id, name: 'storage-00' })
    const inDiscord = new DiscordBlobStore({
      rest: discord,
      channels: () => dataChannels(db),
      maxBytes: 1024,
      instanceId: () => Promise.resolve('0123456789ab'),
      perChannel: 2,
      fetch: discord.fetch,
    })
    const blob = await staged()
    expect(await storeBlobs({ db, staging, store: inDiscord }, [blob.id])).toEqual(new Map())
    const { rows } = await db.execute<{ record: Record<string, unknown> }>(sql`
      SELECT record FROM journal WHERE kind = 'blob.stored' AND (record->>'id')::bigint = ${blob.id}`)
    const [message] = discord.messages
    expect(rows[0]?.record).toMatchObject({
      discordChannelId: channel.id,
      messageId: message?.id,
      attachmentId: message?.attachments[0]?.id,
    })
  })
})
