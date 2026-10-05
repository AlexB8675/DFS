import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sha256 } from '@dfs/crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameCache, MemoryBudget } from './frame-cache.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dfs-frame-cache-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function frame(fill: number, size = 100) {
  const bytes = new Uint8Array(size).fill(fill)
  return { bytes, hash: new Uint8Array(await sha256(bytes)) }
}

async function files(): Promise<string[]> {
  const found: string[] = []
  for (const shard of await readdir(dir)) {
    for (const name of await readdir(path.join(dir, shard))) found.push(name)
  }
  return found.sort()
}

describe('FrameCache (DESIGN.md §6.2)', () => {
  it('fetches a frame once, then serves it from the disk', async () => {
    const cache = new FrameCache({ dir, maxBytes: 10_000 })
    await cache.ready()
    const { bytes, hash } = await frame(1)
    const fetch = vi.fn(() => Promise.resolve(bytes))
    expect(await cache.load(hash, fetch)).toEqual(bytes)
    await cache.idle()
    expect(await cache.load(hash, fetch)).toEqual(bytes)
    expect(fetch).toHaveBeenCalledOnce()
    expect(cache.stats).toEqual({ hits: 1, misses: 1 })
    expect(await files()).toEqual([`${Buffer.from(hash).toString('hex')}.frame`])
  })

  it('shares one fetch among readers of the same frame', async () => {
    const cache = new FrameCache({ dir, maxBytes: 10_000 })
    await cache.ready()
    const { bytes, hash } = await frame(2)
    const release = Promise.withResolvers<Uint8Array>()
    const fetch = vi.fn(() => release.promise)
    const readers = [cache.load(hash, fetch), cache.load(hash, fetch), cache.load(hash, fetch)]
    release.resolve(bytes)
    expect(await Promise.all(readers)).toEqual([bytes, bytes, bytes])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('fetches again when its copy fails the check, and keeps nothing a fetch failed', async () => {
    const cache = new FrameCache({ dir, maxBytes: 10_000 })
    await cache.ready()
    const { bytes, hash } = await frame(3)
    await cache.load(hash, () => Promise.resolve(bytes))
    await cache.idle()
    const [name] = await files()
    await writeFile(path.join(dir, name?.slice(0, 2) ?? '', name ?? ''), new Uint8Array(100))
    const fetch = vi.fn(() => Promise.resolve(bytes))
    expect(await cache.load(hash, fetch)).toEqual(bytes)
    expect(fetch).toHaveBeenCalledOnce()

    const other = await frame(4)
    await expect(
      cache.load(other.hash, () => Promise.reject(new Error('CDN down'))),
    ).rejects.toThrow('CDN down')
    const again = vi.fn(() => Promise.resolve(other.bytes))
    expect(await cache.load(other.hash, again)).toEqual(other.bytes)
    expect(again).toHaveBeenCalledOnce()
  })

  it('lets the least recently used frames go past its size, and finds the rest after a restart', async () => {
    const cache = new FrameCache({ dir, maxBytes: 250 })
    await cache.ready()
    const a = await frame(5)
    const b = await frame(6)
    const c = await frame(7)
    for (const { bytes, hash } of [a, b]) {
      await cache.load(hash, () => Promise.resolve(bytes))
      await cache.idle()
    }
    // `a` is used again, so `b` is the one to go.
    await cache.load(a.hash, () => Promise.reject(new Error('not cached')))
    await cache.load(c.hash, () => Promise.resolve(c.bytes))
    await cache.idle()
    const hex = (hash: Uint8Array) => `${Buffer.from(hash).toString('hex')}.frame`
    expect(await files()).toEqual([hex(a.hash), hex(c.hash)].sort())

    // A write a crash interrupted is cleared; what is cached is found again.
    await mkdir(path.join(dir, 'ff'), { recursive: true })
    await writeFile(path.join(dir, 'ff', 'ff00.frame.1234.tmp'), new Uint8Array(5))
    const restarted = new FrameCache({ dir, maxBytes: 150 })
    await restarted.ready()
    expect(await files()).toHaveLength(1)
    const fetch = vi.fn(() => Promise.resolve(c.bytes))
    const kept = (await files())[0] === hex(c.hash) ? c : a
    await restarted.load(kept.hash, fetch)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('MemoryBudget', () => {
  it('gives out room until it runs out, and takes it back once', () => {
    const budget = new MemoryBudget(100)
    const first = budget.tryTake(60)
    expect(first).not.toBeNull()
    expect(budget.tryTake(60)).toBeNull()
    first?.()
    first?.()
    const second = budget.tryTake(100)
    expect(second).not.toBeNull()
    expect(budget.tryTake(1)).toBeNull()
  })
})
