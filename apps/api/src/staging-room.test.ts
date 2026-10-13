import { reservedStagingSql, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from './app.ts'
import type { Auth } from './auth/sessions.ts'
import { StagingRoom } from './staging.ts'
import { testConfig } from './testing/config.ts'
import { seedUser } from './testing/seed.ts'
import { createUploads } from './uploads/uploads.ts'

// Room in staging (DESIGN.md §6.1, D38), against a real database: streams
// reserve what they will send, the oldest waiting goes first, and what an
// API that stopped had reserved stops counting. Staging holds no frames
// here, so the room is the limit given to each StagingRoom.

let database: TestDatabase
let app: FastifyInstance
let auth: Auth
let cleanup: () => Promise<void>

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password' })
  const [user] = await app.db.select().from(users).where(eq(users.username, 'owner'))
  if (!user) throw new Error('Missing test user.')
  auth = {
    user,
    sessionId: 'test',
    csrfToken: 'test',
    expiresAt: new Date(Date.now() + 60_000),
    seenAt: null,
    limited: false,
  }
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

// Each test starts with nothing reserved and nobody waiting: a turn one test
// leaves would otherwise stand ahead of the next test's streams.
afterEach(async () => {
  await app.db.execute(sql`
    UPDATE upload_sessions SET staging_reserved_bytes = 0, staging_reserved_at = NULL,
      staging_waiting_since = NULL, staging_waiting_seen_at = NULL, staging_wanted_bytes = 0`)
  await app.db.execute(sql`DELETE FROM chunks`)
})

/** Puts `frameBytes` of a stream's frames in staging, as if it had sent a part. */
async function stage(uploadId: string, frameBytes: number) {
  await app.db.execute(sql`
    INSERT INTO chunks (version_id, idx, plain_size, frame_size, plain_sha256, frame_sha256, staged_path)
    SELECT version_id, 0, ${frameBytes}, ${frameBytes}, ${Buffer.alloc(32)}, ${Buffer.alloc(32)}, 'test'
    FROM upload_sessions WHERE id = ${uploadId}`)
}

/** What streams have reserved and still renew, as the upload limit counts it. */
async function reservedBytes(): Promise<number> {
  const { rows } = await app.db.execute<{ bytes: number }>(
    sql`SELECT ${reservedStagingSql()}::float8 AS bytes`,
  )
  return rows[0]?.bytes ?? -1
}

/** A fresh upload session to stand for a stream; its size doesn't matter here. */
async function stream(): Promise<string> {
  if (!auth.user.rootNodeId) throw new Error('Missing root folder.')
  const [result] = await createUploads(app, auth, [
    {
      parentId: auth.user.rootNodeId,
      name: `${crypto.randomUUID()}.bin`,
      sizeBytes: 3,
      mimeType: 'application/octet-stream',
    },
  ])
  if (!result?.ok) throw new Error('Could not start a test upload.')
  return result.session.uploadId
}

/** Moves a session's timestamps back, as if `seconds` had passed. */
async function age(
  uploadId: string,
  column: 'staging_reserved_at' | 'staging_waiting_seen_at',
  seconds: number,
) {
  await app.db.execute(sql`
    UPDATE upload_sessions SET ${sql.identifier(column)} = now() - make_interval(secs => ${seconds}::int)
    WHERE id = ${uploadId}`)
}

describe('StagingRoom (§6.1, D38)', () => {
  it('lets a stream in while there is room for all it will send, and counts what it reserved', async () => {
    const room = new StagingRoom(app.db, 1000)
    const [first, second] = [await stream(), await stream()]
    expect(await room.admit(first, 600)).toBe(true)
    expect(await room.isFull()).toBe(false)
    expect(await room.admit(second, 500)).toBe(false)
    await room.release(first)
    expect(await room.admit(second, 500)).toBe(true)
    await room.release(second)
  })

  it('keeps the oldest waiting stream’s turn: newer streams and single parts get in only around it', async () => {
    const room = new StagingRoom(app.db, 1000)
    const [holding, oldest, newer] = [await stream(), await stream(), await stream()]
    expect(await room.admit(holding, 600)).toBe(true)
    expect(await room.admit(oldest, 500)).toBe(false)
    // 600 held and 300 more would fit, but not with the 500 the oldest waits for.
    expect(await room.admit(newer, 300)).toBe(false)
    expect(await room.isFull()).toBe(true)
    await room.release(holding)
    // 300 and the oldest's 500 fit together: the newer one needn't wait behind it.
    expect(await room.admit(newer, 300)).toBe(true)
    expect(await room.admit(oldest, 500)).toBe(true)
    await room.release(newer)
    await room.release(oldest)
  })

  it('forgets a turn whose client stopped coming back', async () => {
    const room = new StagingRoom(app.db, 1000)
    const [holding, gone, newer] = [await stream(), await stream(), await stream()]
    expect(await room.admit(holding, 600)).toBe(true)
    expect(await room.admit(gone, 500)).toBe(false)
    await age(gone, 'staging_waiting_seen_at', 180)
    expect(await room.admit(newer, 300)).toBe(true)
    // Coming back, it queues anew rather than ahead of anyone.
    const before = await app.db.execute<{ since: number }>(sql`
      SELECT (extract(epoch FROM staging_waiting_since) * 1000)::float8 AS since
      FROM upload_sessions WHERE id = ${gone}`)
    expect(await room.admit(gone, 500)).toBe(false)
    const after = await app.db.execute<{ since: number }>(sql`
      SELECT (extract(epoch FROM staging_waiting_since) * 1000)::float8 AS since
      FROM upload_sessions WHERE id = ${gone}`)
    expect(after.rows[0]?.since).toBeGreaterThan(before.rows[0]?.since ?? Infinity)
    for (const id of [holding, newer]) await room.release(id)
  })

  it('stops counting a reservation its stream stopped renewing, as when its API died', async () => {
    const room = new StagingRoom(app.db, 1000)
    const [renewed, abandoned, next] = [await stream(), await stream(), await stream()]
    expect(await room.admit(renewed, 600)).toBe(true)
    await age(renewed, 'staging_reserved_at', 60)
    await room.renew(renewed)
    expect(await reservedBytes()).toBe(600)
    await room.release(renewed)
    expect(await room.admit(abandoned, 600)).toBe(true)
    await age(abandoned, 'staging_reserved_at', 120)
    expect(await reservedBytes()).toBe(0)
    // All of staging is free again, for a stream that needs every byte of it.
    expect(await room.admit(next, 1000)).toBe(true)
  })

  it('lets an upload that has started back in ahead of older waiting streams, so it can finish', async () => {
    const room = new StagingRoom(app.db, 1000)
    const [started, older] = [await stream(), await stream()]
    // It sent 600 before its connection dropped and its reservation lapsed.
    await stage(started, 600)
    // A stream waits for 900, which can't fit while those 600 are staged.
    expect(await room.admit(older, 900)).toBe(false)
    // Its frames leave staging only once it completes: made to wait behind that stream, neither would ever move.
    expect(await room.admit(started, 300)).toBe(true)
  })

  it('lets only one of two streams racing for the last room in', async () => {
    // Two API instances: each its own StagingRoom, one database.
    const [one, other] = [new StagingRoom(app.db, 1000), new StagingRoom(app.db, 1000)]
    const [a, b] = [await stream(), await stream()]
    const admitted = await Promise.all([one.admit(a, 600), other.admit(b, 600)])
    expect(admitted.filter(Boolean)).toHaveLength(1)
    await one.release(a)
    await one.release(b)
  })
})
