import { createHash, randomBytes } from 'node:crypto'
import { settleBlobs } from '@dfs/bot/testing'
import { liveBytesDrift, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { LocalBlobStore } from '@dfs/storage'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { createUploads, receivePart } from '../uploads/uploads.ts'
import { copyNodes } from './copy.ts'
import { deleteForever } from './trash.ts'
import { trashNodes } from './write.ts'

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

/** A one-part file in the root, stored in its blob. */
async function storedFile(name: string): Promise<string> {
  const rootId = auth.user.rootNodeId ?? ''
  const bytes = randomBytes(app.config.sizes.packThresholdBytes + 100)
  const [result] = await createUploads(app, auth, [
    { parentId: rootId, name, sizeBytes: bytes.length, mimeType: 'application/octet-stream' },
  ])
  if (!result?.ok) throw new Error('The upload did not start.')
  const hash = createHash('sha256').update(bytes).digest('hex')
  await receivePart(app, auth, result.session.uploadId, 0, bytes, hash)
  await settleBlobs({
    db: app.db,
    staging: app.staging,
    store: new LocalBlobStore(app.config.localBlobDir),
    sizes: app.config.sizes,
  })
  return result.session.nodeId
}

async function blobOf(nodeId: string) {
  const { rows } = await app.db.execute<{ state: string; live_bytes: number; frame: number }>(sql`
    SELECT blob.state::text AS state, blob.live_bytes::float8 AS live_bytes,
      chunk.frame_size AS frame
    FROM nodes node
    JOIN chunks chunk ON chunk.version_id = node.current_version_id
    JOIN blobs blob ON blob.id = chunk.blob_id
    WHERE node.id = ${nodeId}`)
  const [blob] = rows
  if (!blob) throw new Error('No blob for that file.')
  return blob
}

async function purge(nodeId: string): Promise<void> {
  await trashNodes(app, auth, [nodeId])
  await deleteForever(app, auth, nodeId)
}

describe('copies (D31)', () => {
  it('keep their frames’ blob until the original and every copy are gone', async () => {
    const original = await storedFile('shared.bin')
    const { frame } = await blobOf(original)
    const rootId = auth.user.rootNodeId ?? ''
    const [copy] = (await copyNodes(app, auth, [original], rootId)).items
    const [second] = (await copyNodes(app, auth, [copy?.id ?? ''], rootId)).items
    expect(await blobOf(original)).toMatchObject({ state: 'stored', live_bytes: 3 * frame })
    expect(await liveBytesDrift(app.db)).toEqual([])

    await purge(original)
    await purge(copy?.id ?? '')
    expect(await blobOf(second?.id ?? '')).toMatchObject({ state: 'stored', live_bytes: frame })

    const { rows: last } = await app.db.execute<{ id: number }>(sql`
      SELECT chunk.blob_id::float8 AS id FROM nodes node
      JOIN chunks chunk ON chunk.version_id = node.current_version_id
      WHERE node.id = ${second?.id ?? ''}`)
    await purge(second?.id ?? '')
    const { rows } = await app.db.execute<{ state: string; live_bytes: number }>(sql`
      SELECT state::text AS state, live_bytes::float8 AS live_bytes FROM blobs
      WHERE id = ${last[0]?.id ?? 0}`)
    // Nothing uses it any more: the GC deletes its message.
    expect(rows[0]).toEqual({ state: 'deleting', live_bytes: 0 })
    expect(await liveBytesDrift(app.db)).toEqual([])
  })
})
