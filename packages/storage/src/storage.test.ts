import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlobStoreError } from './blob-store.ts'
import { ChaosBlobStore } from './chaos-blob-store.ts'
import { LocalBlobStore } from './local-blob-store.ts'
import { Staging } from './staging.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dfs-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const blob = (id: number) => ({ id, channelId: null, messageId: null, attachmentId: null })
const toStore = (id: number) => ({ id, kind: 'solo' as const, frameCount: 1 })
const bytes = (data: Uint8Array) => () => Promise.resolve(data)

describe('LocalBlobStore', () => {
  it('stores blobs and reads any range back', async () => {
    const store = new LocalBlobStore(dir)
    await store.put(toStore(300), bytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])))
    expect(await store.read(blob(300), 2, 3)).toEqual(new Uint8Array([2, 3, 4]))
    // Spread over subdirectories, and no temporary files left behind.
    expect(await readdir(path.join(dir, '2c'))).toEqual(['300.bin'])
  })

  it('refuses a read past the end, and deletes idempotently', async () => {
    const store = new LocalBlobStore(dir)
    await store.put(toStore(1), bytes(new Uint8Array(4)))
    await expect(store.read(blob(1), 2, 4)).rejects.toBeInstanceOf(BlobStoreError)
    await store.delete(blob(1))
    await store.delete(blob(1))
    await expect(store.read(blob(1), 0, 1)).rejects.toBeInstanceOf(BlobStoreError)
  })
})

describe('ChaosBlobStore', () => {
  it('fails on demand, and can lose the answer to a put that worked', async () => {
    const inner = new LocalBlobStore(dir)
    const rolls = [0.9, 0.01, 0.01]
    const chaos = new ChaosBlobStore(inner, {
      failureRate: 0.5,
      lostResponseRate: 0.5,
      random: () => rolls.shift() ?? 0.9,
    })
    // First roll passes, the second loses the answer: the blob is there anyway.
    await expect(chaos.put(toStore(7), bytes(new Uint8Array([7])))).rejects.toMatchObject({
      retryable: true,
    })
    expect(await inner.read(blob(7), 0, 1)).toEqual(new Uint8Array([7]))
    // The third roll fails the call outright.
    await expect(chaos.read(blob(7), 0, 1)).rejects.toMatchObject({ retryable: true })
  })
})

describe('Staging', () => {
  it('keeps frames by version and removes a version at once', async () => {
    const staging = new Staging(dir)
    const where = staging.framePath('v1', 0)
    expect(where).toBe('frames/v1/0.dfs')
    await staging.write(where, new Uint8Array([1, 2]))
    await staging.write(staging.framePath('v1', 1), new Uint8Array([3]))
    expect(await staging.read(where)).toEqual(new Uint8Array([1, 2]))
    await staging.removeVersion('v1')
    await expect(staging.read(where)).rejects.toThrow()
  })

  it('never resolves a path outside its root', async () => {
    const staging = new Staging(dir)
    await expect(staging.read('../escape')).rejects.toThrow(/outside staging/)
  })
})
