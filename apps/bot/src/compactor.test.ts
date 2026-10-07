import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appendJournal,
  compactionCandidates,
  compactionGroups,
  createDatabase,
  createPool,
  liveBytesDrift,
  Metrics,
  purgeVersions,
  storageChannels,
  uuidArray,
  type CompactionRule,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordBlobStore, LocalBlobStore, Staging, type BlobStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { collectGarbage } from './collector.ts'
import { Compactor, dropStalePacks } from './compactor.ts'
import { reconcileOrphans } from './reconciler.ts'
import { dataChannels, instanceId } from './storage.ts'
import { postJournal, settleBlobs, uploadedFiles, waitingForALock } from './testing.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Database
let directory: string
let staging: Staging
let store: LocalBlobStore

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-compactor-test', onError: vi.fn() })
  db = createDatabase(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-compactor-'))
  staging = new Staging(path.join(directory, 'staging'))
  store = new LocalBlobStore(path.join(directory, 'stored'))
})

afterAll(async () => {
  await pool.end()
  await database.drop()
  await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  // Each test merges only its own packs.
  await db.execute(sql`UPDATE blobs SET state = 'deleted' WHERE state <> 'deleted'`)
})

/** A full pack is 9 frames of 100 bytes; 30% of it is 270 bytes. */
const sizes = { blobMaxBytes: 1000, packTargetBytes: 900 }
const rule: CompactionRule = { threshold: 0.3, packTargetBytes: 900, minAgeDays: 7 }

const where = (id: number) => ({ id, channelId: null, messageId: null, attachmentId: null })

/**
 * `count` packs of `perPack` files of 100 bytes each, stored `days` ago, in
 * `blobs`. Returns their files in pack order, and the packs' IDs.
 */
async function packs(
  count: number,
  {
    days = 8,
    perPack = 9,
    blobs = store,
  }: { days?: number; perPack?: number; blobs?: BlobStore } = {},
) {
  const { ownerId, files } = await uploadedFiles(
    db,
    staging,
    Array.from({ length: count * perPack }, () => 100),
  )
  await settleBlobs({ db, staging, store: blobs, sizes })
  const placed = await placement(files.map((file) => file.versionId))
  const packIds = [...new Set(placed.map((chunk) => chunk.blob_id))]
  expect(packIds).toHaveLength(count)
  await db.execute(sql`
    UPDATE blobs SET stored_at = now() - make_interval(days => ${days})
    WHERE id IN (SELECT blob_id FROM chunks WHERE version_id = ANY(${uuidArray(files.map((file) => file.versionId))}))`)
  return { ownerId, versionIds: files.map((file) => file.versionId), packIds }
}

/** Deletes these files' versions for good, as emptying the trash does. */
async function purge(ownerId: string, versionIds: readonly string[]) {
  await db.transaction(async (tx) => {
    await appendJournal(tx, await purgeVersions(tx, ownerId, versionIds))
  })
}

/** Where each of these versions' frame is, in chunk order. */
async function placement(versionIds: readonly string[]) {
  const { rows } = await db.execute<{
    version_id: string
    blob_id: number
    blob_offset: number
    frame_size: number
  }>(sql`
    SELECT version_id, blob_id::float8 AS blob_id, blob_offset, frame_size FROM chunks
    WHERE version_id = ANY(${uuidArray(versionIds)}) ORDER BY id`)
  return rows
}

/** Each version's frame, read from the store where its chunk says. */
async function frames(versionIds: readonly string[], blobs: BlobStore = store) {
  return Promise.all(
    (await placement(versionIds)).map((chunk) =>
      blobs.read(where(chunk.blob_id), chunk.blob_offset, chunk.frame_size),
    ),
  )
}

async function blob(id: number) {
  const { rows } = await db.execute<{
    state: string
    size_bytes: number
    live_bytes: number
    frame_count: number
    sha256: Buffer | null
    stored_at: Date | null
    released_at: Date | null
    staged_path: string | null
    attempts: number
    last_error: string | null
  }>(sql`
    SELECT state, size_bytes, live_bytes, frame_count, sha256, stored_at, released_at,
      staged_path, attempts, last_error
    FROM blobs WHERE id = ${id}`)
  const row = rows[0]
  if (!row) throw new Error(`No blob ${String(id)}.`)
  return row
}

async function lastRecords(count: number) {
  const { rows } = await db.execute<{ kind: string; record: Record<string, unknown> }>(sql`
    SELECT kind, record FROM journal ORDER BY id DESC LIMIT ${count}`)
  return rows.toReversed()
}

/** Sparse: 7 of each pack's 9 files deleted, leaving 200 live bytes. Returns the files kept. */
async function sparsePacks(count: number, options: { days?: number; blobs?: BlobStore } = {}) {
  const made = await packs(count, options)
  const gone = made.versionIds.filter((_, index) => index % 9 < 7)
  await purge(made.ownerId, gone)
  return { ...made, kept: made.versionIds.filter((_, index) => index % 9 >= 7) }
}

describe('Compactor (DESIGN.md §6.6)', () => {
  it('merges packs that hold little into one, and reads every frame back byte for byte', async () => {
    const { packIds, kept } = await sparsePacks(2)
    const before = await frames(kept)
    const metrics = new Metrics()
    const record = vi.spyOn(metrics, 'record')
    const compactor = new Compactor({ db, store, rule, metrics })

    expect(await compactor.compact()).toEqual({
      groups: 1,
      packs: 2,
      freedBytes: 2 * 900 - 400,
      failures: 0,
    })
    // One new pack, its frames in chunk order.
    const placed = await placement(kept)
    const newId = placed[0]?.blob_id ?? 0
    expect(newId).toBeGreaterThan(Math.max(...packIds))
    expect(placed.map((chunk) => [chunk.blob_id, chunk.blob_offset])).toEqual([
      [newId, 0],
      [newId, 100],
      [newId, 200],
      [newId, 300],
    ])
    expect(await frames(kept)).toEqual(before)
    const merged = await blob(newId)
    expect(merged).toMatchObject({
      state: 'stored',
      size_bytes: 400,
      live_bytes: 400,
      frame_count: 4,
      released_at: null,
      staged_path: null,
    })
    expect(merged.stored_at).not.toBeNull()
    expect(merged.sha256).toEqual(
      createHash('sha256')
        .update(await store.read(where(newId), 0, 400))
        .digest(),
    )
    for (const id of packIds) {
      expect(await blob(id)).toMatchObject({ state: 'deleting', live_bytes: 0 })
      expect((await blob(id)).released_at).not.toBeNull()
    }
    expect(await liveBytesDrift(db)).toEqual([])

    // Journaled last, in the move's transaction: the new pack, then what moved.
    expect(await lastRecords(2)).toEqual([
      {
        kind: 'blob.stored',
        record: {
          id: newId,
          kind: 'pack',
          sizeBytes: 400,
          frameCount: 4,
          sha256: merged.sha256?.toString('hex'),
          discordChannelId: null,
          messageId: null,
          attachmentId: null,
        },
      },
      {
        kind: 'blob.relocated',
        record: {
          id: newId,
          chunks: kept.map((versionId, index) => ({ versionId, idx: 0, offset: index * 100 })),
        },
      },
    ])
    expect(record).toHaveBeenCalledWith('discord.posted', 400)
    expect(record).toHaveBeenCalledWith('packs.compacted', 2)
    expect(record).toHaveBeenCalledWith('compaction.freed_bytes', 1400)

    // The old messages go once that journal is on Discord (§6.4).
    expect(await collectGarbage({ db, store, staging }, 10)).toBe(0)
    await postJournal(db)
    expect(await collectGarbage({ db, store, staging }, 10)).toBe(2)
    for (const id of packIds) {
      await expect(store.read(where(id), 0, 1)).rejects.toThrow()
    }
    expect(await frames(kept)).toEqual(before)
  })

  it('merges packs a week old holding under 30% of a full pack, whatever their size, two or more', async () => {
    const old = await sparsePacks(1)
    const young = await sparsePacks(1, { days: 6 })
    // 300 live bytes: a third of a full pack.
    const full = await packs(1)
    await purge(full.ownerId, full.versionIds.slice(0, 6))
    // Sealed half empty by a lone upload: all live, but little.
    const small = await packs(1, { perPack: 2 })

    const ids = async (minAgeDays: number) =>
      (await compactionCandidates(db, { ...rule, minAgeDays })).map((pack) => pack.id)
    expect(await ids(7)).toEqual([...old.packIds, ...small.packIds])
    expect(await ids(0)).toEqual([...old.packIds, ...young.packIds, ...small.packIds])

    const compactor = new Compactor({ db, store, rule })
    expect(await compactor.compact()).toMatchObject({ groups: 1, packs: 2 })
    // The merged pack holds 400 bytes, and the young one is alone: nothing to do.
    expect(await ids(7)).toEqual([])
    expect(await compactor.compact()).toMatchObject({ groups: 0, packs: 0 })
    expect(await compactor.compact({ force: true })).toMatchObject({ groups: 0, packs: 0 })
    expect((await blob(young.packIds[0] ?? 0)).state).toBe('stored')
    expect((await blob(full.packIds[0] ?? 0)).state).toBe('stored')
  })

  it('groups whole packs in ID order while their live bytes fit in a full pack', () => {
    const groups = (lives: number[]) =>
      compactionGroups(
        lives.map((live, index) => ({ id: index + 1, live_bytes: live })),
        900,
      ).map((group) => group.map((pack) => pack.id))
    expect(groups([250, 250, 250, 250, 100])).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
    // A group of one is left: rewriting one pack saves no message.
    expect(groups([250, 250, 250, 250])).toEqual([[1, 2, 3]])
    expect(groups([100])).toEqual([])
    expect(groups([])).toEqual([])
  })

  it('merges every group at once when forced, as Compact packs now does', async () => {
    // 200 live bytes each: four to a group.
    const { packIds } = await sparsePacks(6, { days: 0 })
    const compactor = new Compactor({ db, store, rule })
    expect(await compactor.compact()).toMatchObject({ groups: 0 })
    expect(await compactor.compact({ force: true })).toMatchObject({ groups: 2, packs: 6 })
    for (const id of packIds) expect((await blob(id)).state).toBe('deleting')
    expect(await liveBytesDrift(db)).toEqual([])
  })

  it('waits for a purge holding a version, and leaves its frame behind as dead space', async () => {
    const { ownerId, packIds, kept } = await sparsePacks(2)
    const [victim, ...moved] = kept
    if (!victim) throw new Error('Nothing kept.')
    const put = store.put.bind(store)
    const release = Promise.withResolvers<undefined>()
    let purging: Promise<void> = Promise.resolve()
    // Once the new pack is posted, a purge takes one of its frames' versions
    // and holds it while the move begins.
    const spy = vi.spyOn(store, 'put').mockImplementation(async (blob, read) => {
      const posted = await put(blob, read)
      const holding = Promise.withResolvers<undefined>()
      purging = db.transaction(async (tx) => {
        await appendJournal(tx, await purgeVersions(tx, ownerId, [victim]))
        holding.resolve(undefined)
        await release.promise
      })
      await holding.promise
      return posted
    })
    try {
      const compacting = new Compactor({ db, store, rule }).compact()
      await waitingForALock(db, compacting)
      release.resolve(undefined)
      await purging
      expect(await compacting).toMatchObject({ groups: 1, packs: 2 })
    } finally {
      spy.mockRestore()
    }
    const placed = await placement(moved)
    const newId = placed[0]?.blob_id ?? 0
    // Its 100 bytes stay in the new pack, counted out of it.
    expect(await blob(newId)).toMatchObject({
      state: 'stored',
      size_bytes: 400,
      live_bytes: 300,
      frame_count: 4,
    })
    expect(placed.map((chunk) => chunk.blob_offset)).toEqual([100, 200, 300])
    for (const id of packIds) expect((await blob(id)).state).toBe('deleting')
    expect(await liveBytesDrift(db)).toEqual([])
    const [relocated] = await lastRecords(1)
    expect(relocated).toEqual({
      kind: 'blob.relocated',
      record: {
        id: newId,
        chunks: moved.map((versionId, index) => ({
          versionId,
          idx: 0,
          offset: (index + 1) * 100,
        })),
      },
    })
  })

  it('leaves out a pack that fails its check, and doesn’t try it again', async () => {
    const { packIds, kept } = await sparsePacks(3)
    const [first, damaged, third] = packIds
    if (first === undefined || damaged === undefined || third === undefined) {
      throw new Error('Three packs expected.')
    }
    // The same size, other bytes.
    await store.put({ id: damaged, kind: 'pack', frameCount: 9 }, () =>
      Promise.resolve(new Uint8Array(900)),
    )
    const log = { info: vi.fn(), warn: vi.fn() }
    const metrics = new Metrics()
    const record = vi.spyOn(metrics, 'record')
    const compactor = new Compactor({ db, store, rule, log, metrics })

    expect(await compactor.compact()).toEqual({
      groups: 1,
      packs: 2,
      freedBytes: 2 * 900 - 400,
      failures: 1,
    })
    expect(log.warn).toHaveBeenCalledOnce()
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ blobId: damaged, reason: 'wrong SHA-256' })
    expect(record).toHaveBeenCalledWith('compaction.failures')
    // Never the garbage collector's counts, which Admin → Storage shows as deletions failing.
    expect(await blob(damaged)).toMatchObject({ state: 'stored', attempts: 0, last_error: null })
    expect((await placement(kept)).map((chunk) => chunk.blob_id)).toEqual([
      expect.any(Number),
      expect.any(Number),
      damaged,
      damaged,
      expect.any(Number),
      expect.any(Number),
    ])

    expect(await compactor.compact({ force: true })).toMatchObject({ groups: 0, failures: 0 })
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('drops the new pack and deletes its file when the move fails', async () => {
    const { packIds, kept } = await sparsePacks(2)
    const before = await placement(kept)
    const failing = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('connection lost'))
    try {
      await expect(new Compactor({ db, store, rule }).compact()).rejects.toThrow('connection lost')
    } finally {
      failing.mockRestore()
    }
    const { rows } = await db.execute<{ id: number; state: string }>(sql`
      SELECT id::float8 AS id, state FROM blobs WHERE id > ${Math.max(...packIds)}`)
    expect(rows.map((row) => row.state)).toEqual(['deleted'])
    await expect(store.read(where(rows[0]?.id ?? 0), 0, 1)).rejects.toThrow()
    expect(await placement(kept)).toEqual(before)
    for (const id of packIds) expect((await blob(id)).state).toBe('stored')
  })

  it('gives up a move whose reservation is over half an hour old, and deletes what it posted', async () => {
    const { packIds, kept } = await sparsePacks(2)
    const before = await placement(kept)
    const put = store.put.bind(store)
    const posted = { id: 0 }
    // A post that took its time: the janitor's hour draws near.
    const spy = vi.spyOn(store, 'put').mockImplementation(async (blob, read) => {
      posted.id = blob.id
      const result = await put(blob, read)
      await db.execute(sql`
        UPDATE blobs SET created_at = now() - interval '31 minutes' WHERE id = ${blob.id}`)
      return result
    })
    try {
      expect(await new Compactor({ db, store, rule }).compact()).toMatchObject({
        groups: 0,
        packs: 0,
      })
    } finally {
      spy.mockRestore()
    }
    const newId = posted.id
    expect(newId).toBeGreaterThan(Math.max(...packIds))
    expect((await blob(newId)).state).toBe('deleted')
    await expect(store.read(where(newId), 0, 1)).rejects.toThrow()
    expect(await placement(kept)).toEqual(before)
    for (const id of packIds) expect((await blob(id)).state).toBe('stored')
    expect(await liveBytesDrift(db)).toEqual([])
  })

  it('leaves what a crash after posting left to the janitor and the reconciler', async () => {
    const discord = new FakeDiscord()
    const channel = discord.addTextChannel('storage-00')
    await db.insert(storageChannels).values({ discordChannelId: channel.id, name: 'storage-00' })
    const blobs = new DiscordBlobStore({
      rest: discord,
      channels: () => dataChannels(db),
      maxBytes: sizes.blobMaxBytes,
      instanceId: () => instanceId(db),
      perChannel: 2,
      fetch: discord.fetch,
    })
    const { packIds, kept } = await sparsePacks(2, { blobs })
    const before = await placement(kept)
    const put = blobs.put.bind(blobs)
    // Posted, then the bot is gone before the move.
    const spy = vi.spyOn(blobs, 'put').mockImplementation(async (blob, read) => {
      await put(blob, read)
      return new Promise(() => undefined)
    })
    void new Compactor({ db, store: blobs, rule }).compact()
    try {
      await vi.waitFor(() => {
        expect(discord.messages).toHaveLength(3)
      })
    } finally {
      spy.mockRestore()
    }
    const { rows: building } = await db.execute<{ id: number }>(sql`
      SELECT id::float8 AS id FROM blobs WHERE state = 'building'`)
    expect(building).toHaveLength(1)
    const posted = discord.messages.at(-1)

    // The hour isn't over: both leave it.
    expect(await dropStalePacks(db, blobs)).toBe(0)
    await db.execute(sql`
      UPDATE blobs SET created_at = now() - interval '61 minutes' WHERE state = 'building'`)
    expect(await dropStalePacks(db, blobs)).toBe(1)
    expect((await blob(building[0]?.id ?? 0)).state).toBe('deleted')
    const report = await reconcileOrphans({
      db,
      rest: discord,
      instanceId: await instanceId(db),
      now: Date.now() + 2 * 60 * 60_000,
    })
    expect(report.deleted).toBe(1)
    expect(discord.messages.map((message) => message.id)).not.toContain(posted?.id)
    // Nothing moved: the files are where they were.
    expect(await placement(kept)).toEqual(before)
    for (const id of packIds) expect((await blob(id)).state).toBe('stored')
  })
})
