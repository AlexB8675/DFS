import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { nodes, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { nameKey, type CreateUploadInput } from '@dfs/shared'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { readVersion, type ReadableVersion } from '../content/reader.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { cancelUpload, createUploads, receivePart } from './uploads.ts'

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
    limited: false,
  }
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

async function folders(count: number) {
  return app.db
    .insert(nodes)
    .values(
      Array.from({ length: count }, () => {
        const name = crypto.randomUUID()
        return {
          ownerId: auth.user.id,
          parentId: auth.user.rootNodeId,
          kind: 'folder' as const,
          name,
          nameKey: nameKey(name),
        }
      }),
    )
    .returning()
}

function input(parentId: string, name = 'same.txt'): CreateUploadInput {
  return { parentId, name, sizeBytes: 3, mimeType: 'text/plain' }
}

async function start(sizeBytes: number) {
  if (!auth.user.rootNodeId) throw new Error('Missing root folder.')
  const [result] = await createUploads(app, auth, [
    {
      ...input(auth.user.rootNodeId, `${crypto.randomUUID()}.bin`),
      sizeBytes,
    },
  ])
  if (!result?.ok) throw new Error('Could not start test upload.')
  return result.session
}

async function readPart(versionId: string, size: number): Promise<Buffer> {
  const {
    rows: [version],
  } = await app.db.execute<ReadableVersion>(sql`
    SELECT id AS version_id, size_bytes::float8 AS size_bytes, chunk_size, chunk_count,
      wrapped_dek, key_id FROM file_versions WHERE id = ${versionId}`)
  if (!version) throw new Error('Missing test version.')
  const stream = readVersion(app, version, 0, size - 1)
  try {
    const part = await stream.next()
    if (part.done) throw new Error('No bytes read.')
    return Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength)
  } finally {
    await stream.return(undefined)
  }
}

describe('receiving parts', () => {
  it('hashes a frame while writing, and publishes only after the write is durable', async () => {
    const session = await start(app.config.sizes.chunkSize + 3)
    const release = Promise.withResolvers<undefined>()
    const hashing = Promise.withResolvers<undefined>()
    const write = app.staging.write.bind(app.staging)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const written = vi.spyOn(app.staging, 'write').mockImplementation(async (path, frame) => {
      await release.promise
      await write(path, frame)
    })
    const hash = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (data.byteLength === 41) hashing.resolve(undefined)
      return digest(algorithm, data)
    })
    const transaction = vi.spyOn(app.db, 'transaction')
    const received = receivePart(
      app,
      auth,
      session.uploadId,
      1,
      new Uint8Array([1, 2, 3]),
      undefined,
    )
    try {
      await hashing.promise
      expect(written).toHaveBeenCalledOnce()
      expect(transaction).not.toHaveBeenCalled()
      release.resolve(undefined)
      await received
      expect(transaction).toHaveBeenCalledOnce()
    } finally {
      release.resolve(undefined)
      await received.catch(() => undefined)
      written.mockRestore()
      hash.mockRestore()
      transaction.mockRestore()
    }
  })

  it('waits for an ongoing write before cleaning up a failed frame hash', async () => {
    const session = await start(app.config.sizes.chunkSize + 3)
    const release = Promise.withResolvers<undefined>()
    const hashing = Promise.withResolvers<undefined>()
    const write = app.staging.write.bind(app.staging)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const error = new Error('Hash failed.')
    let stagedPath = ''
    const written = vi.spyOn(app.staging, 'write').mockImplementation(async (path, frame) => {
      stagedPath = path
      await release.promise
      await write(path, frame)
    })
    const hash = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (data.byteLength !== 41) return digest(algorithm, data)
      hashing.resolve(undefined)
      return Promise.reject(error)
    })
    const remove = vi.spyOn(app.staging, 'remove')
    const received = receivePart(
      app,
      auth,
      session.uploadId,
      1,
      new Uint8Array(3),
      undefined,
    ).catch((failure: unknown) => failure)
    try {
      await hashing.promise
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      expect(remove).not.toHaveBeenCalled()
      release.resolve(undefined)
      expect(await received).toBe(error)
      expect(remove).toHaveBeenCalledExactlyOnceWith(stagedPath)
      await expect(app.staging.read(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const { rows } = await app.db.execute(
        sql`SELECT idx FROM chunks WHERE version_id = ${session.versionId}`,
      )
      expect(rows).toEqual([])
    } finally {
      release.resolve(undefined)
      await received
      written.mockRestore()
      hash.mockRestore()
      remove.mockRestore()
    }
  })

  it('settles the hash before returning a failed write', async () => {
    const session = await start(app.config.sizes.chunkSize + 3)
    const hashing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const error = new Error('Disk full.')
    const write = vi.spyOn(app.staging, 'write').mockRejectedValueOnce(error)
    const hash = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      if (data.byteLength === 41) {
        hashing.resolve(undefined)
        await release.promise
      }
      return digest(algorithm, data)
    })
    const settled = vi.fn()
    const received = receivePart(
      app,
      auth,
      session.uploadId,
      1,
      new Uint8Array(3),
      undefined,
    ).catch((failure: unknown) => {
      settled()
      return failure
    })
    try {
      await hashing.promise
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      expect(settled).not.toHaveBeenCalled()
      release.resolve(undefined)
      expect(await received).toBe(error)
    } finally {
      release.resolve(undefined)
      await received
      write.mockRestore()
      hash.mockRestore()
    }
  })

  it('accepts a matching retry without rewriting its frame, even when staging is full', async () => {
    const session = await start(app.config.sizes.chunkSize + 1)
    const bytes = new Uint8Array(session.chunkSize).fill(9)
    await receivePart(app, auth, session.uploadId, 0, bytes, undefined)
    const write = vi.spyOn(app.staging, 'write')
    const full = vi.spyOn(app.stagingLimit, 'isFull').mockResolvedValue(true)
    try {
      await receivePart(app, auth, session.uploadId, 0, bytes, undefined)
      expect(write).not.toHaveBeenCalled()
      expect(full).not.toHaveBeenCalled()
      bytes[0] = 8
      await expect(
        receivePart(app, auth, session.uploadId, 0, bytes, undefined),
      ).rejects.toMatchObject({ status: 409, code: 'part_conflict' })
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
      full.mockRestore()
    }
  })

  it('keeps a published frame if the database loses the response to its commit', async () => {
    const session = await start(app.config.sizes.chunkSize + 1)
    const bytes = new Uint8Array(session.chunkSize).fill(5)
    const error = new Error('Commit response lost.')
    const transaction = app.db.transaction.bind(app.db)
    const spy = vi.spyOn(app.db, 'transaction').mockImplementationOnce(async (work, config) => {
      await transaction(work, config)
      throw error
    })
    try {
      await expect(receivePart(app, auth, session.uploadId, 0, bytes, undefined)).rejects.toBe(
        error,
      )
      expect((await readPart(session.versionId, bytes.length)).equals(bytes)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('rolls a single part back with its completion, and removes its frame', async () => {
    const session = await start(3)
    const bytes = new Uint8Array([4, 5, 6])
    const queue = await app.queue.get()
    const insert = vi
      .spyOn(queue, 'insert')
      .mockRejectedValueOnce(new Error('The job queue is unavailable.'))
    try {
      await expect(receivePart(app, auth, session.uploadId, 0, bytes, undefined)).rejects.toThrow(
        'The job queue is unavailable.',
      )
    } finally {
      insert.mockRestore()
    }
    const { rows: chunks } = await app.db.execute(sql`
      SELECT 1 FROM chunks WHERE version_id = ${session.versionId}`)
    expect(chunks).toHaveLength(0)
    await expect(
      readdir(path.join(app.staging.root, 'frames', session.versionId)),
    ).resolves.toEqual([])

    // The part and its completion go through together on the retry.
    await receivePart(app, auth, session.uploadId, 0, bytes, undefined)
    const { rows: sessions } = await app.db.execute<{ state: string }>(sql`
      SELECT state FROM upload_sessions WHERE id = ${session.uploadId}`)
    expect(sessions[0]?.state).toBe('completed')
    expect((await readPart(session.versionId, bytes.length)).equals(bytes)).toBe(true)
  })

  it('keeps ciphertext and its hash together when two copies arrive concurrently', async () => {
    const session = await start(app.config.sizes.chunkSize + 1)
    const bytes = new Uint8Array(session.chunkSize).fill(7)
    const written = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const write = app.staging.write.bind(app.staging)
    let attempts = 0
    const spy = vi.spyOn(app.staging, 'write').mockImplementation(async (path, frame) => {
      const attempt = ++attempts
      await write(path, frame)
      if (attempt === 1) {
        written.resolve(undefined)
        await release.promise
      }
    })
    const first = receivePart(app, auth, session.uploadId, 0, bytes, undefined)
    try {
      await written.promise
      await receivePart(app, auth, session.uploadId, 0, bytes, undefined)
      release.resolve(undefined)
      await first
      expect((await readPart(session.versionId, bytes.length)).equals(bytes)).toBe(true)
    } finally {
      release.resolve(undefined)
      await first.catch(() => undefined)
      spy.mockRestore()
    }
  })

  it('does not overwrite a completed upload when an older retry finishes writing late', async () => {
    const session = await start(3)
    const bytes = new Uint8Array([1, 2, 3])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const write = app.staging.write.bind(app.staging)
    let attempts = 0
    const spy = vi.spyOn(app.staging, 'write').mockImplementation(async (path, frame) => {
      if (++attempts === 1) {
        entered.resolve(undefined)
        await release.promise
      }
      await write(path, frame)
    })
    const first = receivePart(app, auth, session.uploadId, 0, bytes, undefined)
    try {
      await entered.promise
      await receivePart(app, auth, session.uploadId, 0, bytes, undefined)
      release.resolve(undefined)
      await first
      expect((await readPart(session.versionId, bytes.length)).equals(bytes)).toBe(true)
    } finally {
      release.resolve(undefined)
      await first.catch(() => undefined)
      spy.mockRestore()
    }
  })

  it('cleans up a part cancelled while it was being written and reports an expired upload', async () => {
    const session = await start(3)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const write = app.staging.write.bind(app.staging)
    let stagedPath = ''
    const spy = vi.spyOn(app.staging, 'write').mockImplementation(async (path, frame) => {
      stagedPath = path
      entered.resolve(undefined)
      await release.promise
      await write(path, frame)
    })
    // Observe the failure immediately while another request cancels the upload.
    const received = receivePart(
      app,
      auth,
      session.uploadId,
      0,
      new Uint8Array(3),
      undefined,
    ).catch((error: unknown) => error)
    try {
      await entered.promise
      await cancelUpload(app, auth, session.uploadId)
      release.resolve(undefined)
      expect(await received).toMatchObject({ status: 404, code: 'upload_not_found' })
      await expect(app.staging.read(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release.resolve(undefined)
      await received
      spy.mockRestore()
    }
  })
})

describe('upload batches', () => {
  it('uses a fixed number of database queries across many destination folders', async () => {
    const destinations = await folders(16)
    const first = destinations[0]
    if (!first) throw new Error('Missing destination folder.')
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    try {
      await createUploads(app, auth, [input(first.id, 'single.txt')])
      const single = queries.mock.calls.length
      queries.mockClear()
      const results = await createUploads(
        app,
        auth,
        destinations.map((folder) => input(folder.id)),
      )
      const multiple = queries.mock.calls.length
      expect(results.every((result) => result.ok)).toBe(true)
      expect(multiple).toBeLessThanOrEqual(single + 1)
    } finally {
      queries.mockRestore()
    }
  })

  it('matches existing names to their own folders and numbers repeated names in order', async () => {
    const destinations = await folders(2)
    const initial = await createUploads(
      app,
      auth,
      destinations.map((folder) => input(folder.id)),
    )
    const sessions = initial.flatMap((result) => (result.ok ? [result.session] : []))
    expect(sessions).toHaveLength(2)
    expect(sessions[0]?.nodeId).not.toBe(sessions[1]?.nodeId)

    const inputs = destinations.flatMap((folder) => [
      input(folder.id, 'SAME.TXT'),
      input(folder.id),
    ])
    const results = await createUploads(app, auth, inputs)
    const repeated = results.flatMap((result) => (result.ok ? [result.session] : []))
    expect(repeated.map((session) => session.nodeId)).toEqual([
      sessions[0]?.nodeId,
      sessions[0]?.nodeId,
      sessions[1]?.nodeId,
      sessions[1]?.nodeId,
    ])
    expect(repeated.every((session) => session.isNewVersion)).toBe(true)
    const versions = await app.db.execute<{ version_no: number }>(
      // The first and both repeated names each got their own version.
      sql`SELECT version_no FROM file_versions
        WHERE node_id = ${sessions[0]?.nodeId} ORDER BY version_no`,
    )
    expect(versions.rows.map((version) => version.version_no)).toEqual([1, 2, 3])
  })

  it('keeps per-file errors for missing, trashed, foreign and non-folder destinations', async () => {
    const [visible, trashed] = await folders(2)
    if (!visible || !trashed) throw new Error('Missing test folders.')
    await app.db.update(nodes).set({ deletedAt: new Date() }).where(eq(nodes.id, trashed.id))
    await seedUser(app.db, { username: 'other', password: 'the-other-password' })
    const [other] = await app.db.select().from(users).where(eq(users.username, 'other'))
    if (!other?.rootNodeId) throw new Error('Missing other user.')
    const [file] = await createUploads(app, auth, [input(visible.id)])
    if (!file?.ok) throw new Error('Could not create test file.')

    const results = await createUploads(app, auth, [
      input(visible.id, 'valid.txt'),
      input(crypto.randomUUID()),
      input(trashed.id),
      input(other.rootNodeId),
      input(file.session.nodeId),
    ])
    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual([
      'ok',
      'not_found',
      'not_found',
      'not_found',
      'not_a_folder',
    ])
  })
})
