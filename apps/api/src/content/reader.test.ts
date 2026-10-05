import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { chunkContext, generateDek, importAesKey, sealFrame, sha256 } from '@dfs/crypto'
import type { Executor } from '@dfs/db'
import type { BlobStore, Staging } from '@dfs/storage'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { DataKeyCache } from '../keys.ts'
import { FrameCache, MemoryBudget } from './frame-cache.ts'
import { ContentError, readVersion, type ReadableVersion } from './reader.ts'

async function fixture() {
  const versionId = crypto.randomUUID()
  const key = await importAesKey(generateDek())
  const plaintext = Uint8Array.from({ length: 12 }, (_, index) => index)
  const frames = await Promise.all(
    [0, 1, 2].map((index) =>
      sealFrame(key, plaintext.subarray(index * 4, index * 4 + 4), chunkContext(versionId, index)),
    ),
  )
  const locations = await Promise.all(
    frames.map(async (frame, index) => ({
      idx: index,
      plain_size: 4,
      frame_size: frame.length,
      frame_sha256: Buffer.from(await sha256(frame)),
      staged_path: `frames/${versionId}/${String(index)}.dfs`,
      blob_id: null as number | null,
      blob_offset: null as number | null,
      blob_state: null as string | null,
      channel_id: null,
      message_id: null,
      attachment_id: null,
    })),
  )
  const execute = vi.fn<Executor['execute']>().mockResolvedValue({
    rows: locations,
    rowCount: locations.length,
    command: 'SELECT',
    fields: [],
    oid: 0,
  })
  const read = vi.fn<Staging['read']>((path) => {
    const index = locations.findIndex((chunk) => chunk.staged_path === path)
    const frame = frames[index]
    return frame ? Promise.resolve(frame) : Promise.reject(new Error('Missing staged frame.'))
  })
  const blobRead = vi.fn<BlobStore['read']>().mockResolvedValue(frames[0] ?? new Uint8Array())
  // Only the dependencies a reader uses; frames still use real AES-GCM and SHA-256.
  const app = {
    db: { execute },
    staging: { read },
    blobStore: { read: blobRead },
    dataKeys: new DataKeyCache(),
    keys: { unwrapDek: () => Promise.resolve(key) },
  } as unknown as FastifyInstance
  const version: ReadableVersion = {
    version_id: versionId,
    size_bytes: plaintext.length,
    chunk_size: 4,
    chunk_count: locations.length,
    wrapped_dek: Buffer.alloc(0),
    key_id: 'test',
  }
  return { app, version, plaintext, frames, locations, execute, read, blobRead }
}

describe('readVersion', () => {
  it('verifies and streams ranges across chunk boundaries', async () => {
    const { app, version, plaintext } = await fixture()
    const parts: Uint8Array[] = []
    for await (const part of readVersion(app, version, 2, 9)) parts.push(part)
    expect(Buffer.concat(parts)).toEqual(Buffer.from(plaintext.subarray(2, 10)))
  })

  it('reads ahead only once the consumer keeps up, and never past the range', async () => {
    const { app, version, plaintext, read, execute, locations } = await fixture()
    const stream = readVersion(app, version, 0, 11)
    expect((await stream.next()).value).toEqual(plaintext.subarray(0, 4))
    await setImmediate()
    // A reader that stops here, as a seek often does, cost one chunk.
    expect(read).toHaveBeenCalledTimes(1)
    expect((await stream.next()).value).toEqual(plaintext.subarray(4, 8))
    // It kept up: the next chunk was read while this one was sent.
    expect(read).toHaveBeenCalledTimes(3)
    expect((await stream.next()).value).toEqual(plaintext.subarray(8, 12))
    expect((await stream.next()).done).toBe(true)
    expect(read).toHaveBeenCalledTimes(3)

    read.mockClear()
    const firstTwo = locations.slice(0, 2)
    execute.mockResolvedValueOnce({
      rows: firstTwo,
      rowCount: firstTwo.length,
      command: 'SELECT',
      fields: [],
      oid: 0,
    })
    for await (const part of readVersion(app, version, 0, 7)) expect(part).toHaveLength(4)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads one chunk at a time when the memory for reading ahead is taken', async () => {
    const { app, version, read } = await fixture()
    Object.assign(app, { readBudget: new MemoryBudget(0) })
    const stream = readVersion(app, version, 0, 11)
    await stream.next()
    await stream.next()
    expect(read).toHaveBeenCalledTimes(2)
    await stream.return(undefined)
  })

  it('delivers a read-ahead failure when the consumer resumes', async () => {
    const { app, version, frames, read } = await fixture()
    const error = new Error('Blob unavailable.')
    read
      .mockResolvedValueOnce(frames[0] ?? new Uint8Array())
      .mockResolvedValueOnce(frames[1] ?? new Uint8Array())
      .mockRejectedValueOnce(error)
    const stream = readVersion(app, version, 0, 11)
    await stream.next()
    await stream.next()
    // Let the rejection read ahead settle while backpressure holds the generator.
    await setImmediate()
    await expect(stream.next()).rejects.toBe(error)
  })

  it('handles an outstanding read-ahead failure after the consumer disconnects', async () => {
    const { app, version, frames, read } = await fixture()
    const pending = Promise.withResolvers<Uint8Array>()
    read
      .mockResolvedValueOnce(frames[0] ?? new Uint8Array())
      .mockResolvedValueOnce(frames[1] ?? new Uint8Array())
      .mockReturnValueOnce(pending.promise)
    const stream = readVersion(app, version, 0, 11)
    await stream.next()
    await stream.next()
    await stream.return(undefined)
    pending.reject(new Error('Read failed after disconnect.'))
    await setImmediate()
  })

  it('checks prefetched frames for corruption', async () => {
    const { app, version, frames } = await fixture()
    const frame = frames[1]
    if (!frame) throw new Error('Missing test frame.')
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 1
    const stream = readVersion(app, version, 0, 11)
    await stream.next()
    await expect(stream.next()).rejects.toThrow(/corrupt/)
  })

  it('rejects plaintext whose length differs from the chunk metadata', async () => {
    const { app, version, locations } = await fixture()
    const chunk = locations[0]
    if (!chunk) throw new Error('Missing test chunk.')
    chunk.plain_size = 3
    await expect(readVersion(app, version, 0, 11).next()).rejects.toThrow(/wrong size/)
  })

  it('looks up a frame again if the bot removes it from staging during a read', async () => {
    const { app, version, locations, execute, read, blobRead } = await fixture()
    const chunk = locations[0]
    if (!chunk) throw new Error('Missing test chunk.')
    execute
      .mockResolvedValueOnce({
        rows: [chunk],
        rowCount: 1,
        command: 'SELECT',
        fields: [],
        oid: 0,
      })
      .mockResolvedValueOnce({
        rows: [{ ...chunk, staged_path: null, blob_id: 1, blob_offset: 0, blob_state: 'stored' }],
        rowCount: 1,
        command: 'SELECT',
        fields: [],
        oid: 0,
      })
    read.mockRejectedValueOnce(
      Object.assign(new Error('Staging file removed.'), { code: 'ENOENT' }),
    )
    const stream = readVersion(app, version, 0, 3)
    expect((await stream.next()).value).toEqual(new Uint8Array([0, 1, 2, 3]))
    expect(blobRead).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
    await stream.return(undefined)
  })

  it('rejects missing chunk metadata before streaming', async () => {
    const { app, version, execute } = await fixture()
    execute.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', fields: [], oid: 0 })
    await expect(readVersion(app, version, 0, 11).next()).rejects.toBeInstanceOf(ContentError)
  })

  it('serves cached frames when the bot can’t sign their URLs', async () => {
    const { app, version, plaintext, frames, locations, execute } = await fixture()
    const dir = await mkdtemp(path.join(tmpdir(), 'dfs-reader-cache-'))
    const cache = new FrameCache({ dir, maxBytes: 10_000 })
    try {
      await cache.ready()
      locations.forEach((chunk, index) => {
        Object.assign(chunk, {
          staged_path: null,
          blob_id: index + 1,
          blob_offset: 0,
          blob_state: 'stored',
        })
        const frame = frames[index]
        if (frame) cache.put(chunk.frame_sha256, frame)
      })
      execute.mockResolvedValue({
        rows: locations,
        rowCount: locations.length,
        command: 'SELECT',
        fields: [],
        oid: 0,
      })
      const unreachable = () => Promise.reject(new Error('The bot is restarting.'))
      Object.assign(app, {
        frameCache: cache,
        blobStore: { read: unreachable, signUrls: unreachable },
      })
      const parts: Uint8Array[] = []
      for await (const part of readVersion(app, version, 0, 11)) parts.push(part)
      expect(Buffer.concat(parts)).toEqual(Buffer.from(plaintext))
    } finally {
      await cache.idle()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
