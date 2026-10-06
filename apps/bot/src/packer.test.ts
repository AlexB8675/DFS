import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createDatabase,
  createPool,
  fileVersions,
  liveBytesDrift,
  nodes,
  purgeVersions,
  users,
  type Database,
} from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { cleanUp } from './leader-work.ts'
import { Packer } from './packer.ts'

let database: TestDatabase
let pool: pg.Pool
let db: Database
let directory: string
let staging: Staging

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  pool = createPool(database.url, { applicationName: 'dfs-packer-test', onError: vi.fn() })
  db = createDatabase(pool)
  directory = await mkdtemp(path.join(tmpdir(), 'dfs-packer-'))
  staging = new Staging(path.join(directory, 'staging'))
})

afterAll(async () => {
  await pool.end()
  await database.drop()
  await rm(directory, { recursive: true, force: true })
})

beforeEach(async () => {
  // Each test packs only its own frames.
  await db.execute(sql`UPDATE chunks SET purged_at = now() WHERE blob_id IS NULL`)
})

const sizes = { blobMaxBytes: 1000, packTargetBytes: 900 }

/** One file per frame, each a completed upload (or `state`) whose frame waits in staging. */
async function waiting(frameSizes: number[], state: 'syncing' | 'uploading' = 'syncing') {
  const [owner] = await db
    .insert(users)
    .values({
      username: crypto.randomUUID(),
      displayName: 'Test',
      passwordHash: '-',
      quotaBytes: 1e9,
    })
    .returning()
  if (!owner) throw new Error('No test owner.')
  const [root] = await db
    .insert(nodes)
    .values({ ownerId: owner.id, kind: 'folder', name: '', nameKey: '' })
    .returning()
  if (!root) throw new Error('No test root.')
  const frames: { versionId: string; stagedPath: string; bytes: Uint8Array }[] = []
  for (const [index, size] of frameSizes.entries()) {
    const [node] = await db
      .insert(nodes)
      .values({
        ownerId: owner.id,
        parentId: root.id,
        kind: 'file',
        name: `${String(index)}.bin`,
        nameKey: `${String(index)}.bin`,
        sizeBytes: size,
      })
      .returning()
    if (!node) throw new Error('No test node.')
    const [version] = await db
      .insert(fileVersions)
      .values({
        nodeId: node.id,
        versionNo: 1,
        state,
        sizeBytes: size,
        chunkSize: 4096,
        chunkCount: 1,
        wrappedDek: Buffer.alloc(60),
        keyId: 'k1',
        createdBy: owner.id,
      })
      .returning()
    if (!version) throw new Error('No test version.')
    const bytes = new Uint8Array(randomBytes(size))
    const stagedPath = staging.framePath(version.id, 0)
    await staging.write(stagedPath, bytes)
    const hash = createHash('sha256').update(bytes).digest()
    await db.execute(sql`
      INSERT INTO chunks (version_id, idx, plain_size, frame_size, plain_sha256, frame_sha256, staged_path)
      VALUES (${version.id}, 0, ${size}, ${size}, ${hash}, ${hash}, ${stagedPath})`)
    frames.push({ versionId: version.id, stagedPath, bytes })
  }
  return frames
}

/** Where each of these versions' frames went: its pack and offset. */
async function placement(versionIds: string[]) {
  const { rows } = await db.execute<{
    version_id: string
    blob_id: number | null
    blob_offset: number | null
    staged_path: string | null
  }>(sql`
    SELECT version_id, blob_id::float8 AS blob_id, blob_offset, staged_path FROM chunks
    WHERE version_id = ANY(${`{${versionIds.join(',')}}`}::uuid[]) ORDER BY id`)
  return rows
}

async function pack(blobId: number) {
  const { rows } = await db.execute<{
    kind: string
    state: string
    size_bytes: number
    live_bytes: number
    frame_count: number
    sha256: Buffer
    staged_path: string
  }>(sql`
    SELECT kind, state, size_bytes, live_bytes, frame_count, sha256, staged_path
    FROM blobs WHERE id = ${blobId}`)
  const blob = rows[0]
  if (!blob) throw new Error(`No blob ${String(blobId)}.`)
  return { ...blob, data: await staging.read(blob.staged_path) }
}

describe('Packer (DESIGN.md §6.6)', () => {
  it('packs waiting frames in order, never past BLOB_MAX_BYTES, and queues each pack', async () => {
    const frameSizes = Array.from({ length: 60 }, () => 1 + Math.floor(Math.random() * 300))
    const frames = await waiting(frameSizes)
    const queued: number[] = []
    const packer = new Packer({
      db,
      staging,
      sizes,
      maxWaitMs: 60_000,
      enqueue: (_tx, blobIds) => {
        queued.push(...blobIds)
        return Promise.resolve()
      },
    })
    const sealed = await packer.sealDue({ force: true })

    const placed = await placement(frames.map((frame) => frame.versionId))
    const packIds = [...new Set(placed.map((chunk) => chunk.blob_id))]
    expect(sealed).toBe(packIds.length)
    expect(queued).toEqual(packIds)
    for (const blobId of packIds) {
      if (blobId === null) throw new Error('A frame was left out.')
      const blob = await pack(blobId)
      expect(blob).toMatchObject({ kind: 'pack', state: 'staged' })
      expect(blob.size_bytes).toBeLessThanOrEqual(sizes.blobMaxBytes)
      expect(blob.live_bytes).toBe(blob.size_bytes)
      expect(blob.data.length).toBe(blob.size_bytes)
      expect(blob.sha256).toEqual(createHash('sha256').update(blob.data).digest())
      const inside = placed.filter((chunk) => chunk.blob_id === blobId)
      expect(blob.frame_count).toBe(inside.length)
    }
    // Each frame is where its chunk says, and its own file is gone.
    for (const [index, chunk] of placed.entries()) {
      const frame = frames[index]
      if (!frame || chunk.blob_id === null || chunk.blob_offset === null)
        throw new Error('Unplaced.')
      expect(chunk.staged_path).toBeNull()
      const { data } = await pack(chunk.blob_id)
      expect(data.subarray(chunk.blob_offset, chunk.blob_offset + frame.bytes.length)).toEqual(
        frame.bytes,
      )
      await expect(readdir(path.join(staging.root, 'frames', frame.versionId))).resolves.toEqual([])
    }
  })

  it('fills a pack with what fits, and keeps a frame that doesn’t for the next', async () => {
    const frames = await waiting([600, 600, 300])
    const packer = new Packer({
      db,
      staging,
      sizes: { blobMaxBytes: 1000, packTargetBytes: 1000 },
      maxWaitMs: 60_000,
    })
    // Nothing waiting fits in the 100 bytes left: due at once.
    expect(await packer.sealDue()).toBe(1)
    const placed = await placement(frames.map((frame) => frame.versionId))
    expect(placed.map((chunk) => chunk.blob_offset)).toEqual([0, null, 600])
    expect(placed[0]?.blob_id).toBe(placed[2]?.blob_id)
  })

  it('waits for more frames until the oldest has waited PACK_MAX_WAIT_MS', async () => {
    const frames = await waiting([100, 100])
    const packer = new Packer({ db, staging, sizes, maxWaitMs: 30_000 })
    const start = Date.now()
    expect(await packer.sealDue({ now: start })).toBe(0)
    await waiting([100])
    expect(await packer.sealDue({ now: start + 29_999 })).toBe(0)
    expect(await packer.sealDue({ now: start + 30_000 })).toBe(1)
    const placed = await placement(frames.map((frame) => frame.versionId))
    expect(placed.every((chunk) => chunk.blob_id !== null)).toBe(true)
  })

  it('seals a full pack at once, and leaves frames of unfinished uploads alone', async () => {
    const unfinished = await waiting([500], 'uploading')
    await waiting([500, 500])
    const packer = new Packer({ db, staging, sizes, maxWaitMs: 60_000 })
    expect(await packer.sealDue()).toBe(1)
    expect(await placement([unfinished[0]?.versionId ?? ''])).toMatchObject([{ blob_id: null }])
  })

  it('lets a purge during sealing count its frame out of the pack', async () => {
    const frames = await waiting([100, 100, 100])
    const victim = frames[1]
    if (!victim) throw new Error('No frame to purge.')
    const { rows: owners } = await db.execute<{ owner: string }>(sql`
      SELECT created_by AS owner FROM file_versions WHERE id = ${victim.versionId}`)
    const writing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const write = staging.write.bind(staging)
    const paused = vi.spyOn(staging, 'write').mockImplementation(async (file, data) => {
      if (file.startsWith('packs/')) {
        writing.resolve(undefined)
        await release.promise
      }
      await write(file, data)
    })
    try {
      const sealing = new Packer({ db, staging, sizes, maxWaitMs: 0 }).sealDue({ force: true })
      await writing.promise
      // The purge waits for the pack being sealed with its frame…
      const purging = db.transaction((tx) =>
        purgeVersions(tx, owners[0]?.owner ?? '', [victim.versionId]),
      )
      await vi.waitFor(async () => {
        const { rows } = await db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`)
        expect(rows[0]?.waiting).toBe(1)
      })
      release.resolve(undefined)
      await Promise.all([sealing, purging])
    } finally {
      paused.mockRestore()
    }
    // …then counts it out, so the pack's live bytes are exactly what is left in it.
    expect(await liveBytesDrift(db)).toEqual([])
    const placed = await placement([frames[0]?.versionId ?? '', frames[2]?.versionId ?? ''])
    const blobId = placed[0]?.blob_id ?? 0
    expect(await pack(blobId)).toMatchObject({ size_bytes: 300, live_bytes: 200, frame_count: 3 })
  })

  it('leaves out a frame whose staged file is gone, and packs the rest', async () => {
    const frames = await waiting([100, 100])
    await staging.remove(frames[0]?.stagedPath ?? '')
    const log = { warn: vi.fn() }
    const packer = new Packer({ db, staging, sizes, maxWaitMs: 0, log })
    expect(await packer.sealDue({ force: true })).toBe(1)
    expect(await packer.sealDue({ force: true })).toBe(0)
    expect(log.warn).toHaveBeenCalledOnce()
    const placed = await placement(frames.map((frame) => frame.versionId))
    expect(placed.map((chunk) => chunk.blob_id === null)).toEqual([true, false])
  })

  it('sweeps pack files that a crash left unrecorded', async () => {
    const stray = staging.packPath()
    await staging.write(stray, new Uint8Array([1]))
    await new Packer({ db, staging, sizes, maxWaitMs: 0 }).sealDue({ force: true })
    await waiting([100])
    await new Packer({ db, staging, sizes, maxWaitMs: 0 }).sealDue({ force: true })
    const recorded = (await staging.packFiles()).map((file) => file.path)
    expect(recorded).toContain(stray)

    await cleanUp(db, staging, Date.now())
    expect((await staging.packFiles()).map((file) => file.path)).toContain(stray)
    await cleanUp(db, staging, Date.now() + 2 * 60 * 60_000)
    const left = (await staging.packFiles()).map((file) => file.path)
    expect(left).not.toContain(stray)
    expect(left.length).toBeGreaterThan(0)
  })
})
