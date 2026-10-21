import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sha256 } from '@dfs/crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameCache, MemoryBudget } from './frame-cache.ts'

let dir: string
/** Caches a test opened: they finish writing before the folder goes. */
const opened: FrameCache[] = []

function open(maxBytes: number): FrameCache {
  const cache = new FrameCache({ dir, maxBytes })
  opened.push(cache)
  return cache
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dfs-frame-cache-'))
})

afterEach(async () => {
  await Promise.all(opened.splice(0).map((cache) => cache.idle()))
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
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await frame(1)
    const fetch = vi.fn(() => Promise.resolve(bytes))
    expect(await cache.load(hash, fetch)).toEqual(bytes)
    await cache.idle()
    expect(await cache.load(hash, fetch)).toEqual(bytes)
    expect(fetch).toHaveBeenCalledOnce()
    expect(cache.stats).toEqual({ hits: 1, misses: 1, bytesRead: 100 })
    expect(await files()).toEqual([`${Buffer.from(hash).toString('hex')}.frame`])
  })

  it('shares one fetch among readers of the same frame', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await frame(2)
    const release = Promise.withResolvers<Uint8Array>()
    const fetch = vi.fn(() => release.promise)
    const readers = [cache.load(hash, fetch), cache.load(hash, fetch), cache.load(hash, fetch)]
    release.resolve(bytes)
    expect(await Promise.all(readers)).toEqual([bytes, bytes, bytes])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('stops a fetch once every reader has given up on it, and keeps nothing of it', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await frame(5)
    let fetchSignal: AbortSignal | undefined
    const fetch = vi.fn((signal: AbortSignal) => {
      fetchSignal = signal
      return new Promise<Uint8Array>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error)
        })
      })
    })
    const first = new AbortController()
    const second = new AbortController()
    const firstRead = cache.load(hash, fetch, first.signal)
    const secondRead = cache.load(hash, fetch, second.signal)
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce()
    })
    first.abort()
    await expect(firstRead).rejects.toMatchObject({ name: 'AbortError' })
    // The other reader still waits for it.
    expect(fetchSignal?.aborted).toBe(false)
    second.abort()
    await expect(secondRead).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchSignal?.aborted).toBe(true)

    // A reader that comes later fetches it afresh.
    const again = vi.fn(() => Promise.resolve(bytes))
    expect(await cache.load(hash, again)).toEqual(bytes)
    expect(again).toHaveBeenCalledOnce()
  })

  it('goes on fetching for a reader that stays, and keeps the frame', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await frame(6)
    const release = Promise.withResolvers<Uint8Array>()
    let fetchSignal: AbortSignal | undefined
    const fetch = vi.fn((signal: AbortSignal) => {
      fetchSignal = signal
      return release.promise
    })
    const leaving = new AbortController()
    const gone = cache.load(hash, fetch, leaving.signal)
    const staying = cache.load(hash, fetch)
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce()
    })
    leaving.abort()
    await expect(gone).rejects.toMatchObject({ name: 'AbortError' })
    release.resolve(bytes)
    expect(await staying).toEqual(bytes)
    expect(fetchSignal?.aborted).toBe(false)
    await cache.idle()
    expect(cache.has(hash)).toBe(true)
  })

  it('fetches again when its copy fails the check, and keeps nothing a fetch failed', async () => {
    const cache = open(10_000)
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
    const cache = open(250)
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
    const restarted = open(150)
    await restarted.ready()
    expect(await files()).toHaveLength(1)
    const fetch = vi.fn(() => Promise.resolve(c.bytes))
    const kept = (await files())[0] === hex(c.hash) ? c : a
    await restarted.load(kept.hash, fetch)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('segments kept on their own (§6.2)', () => {
  it('keeps segments apart from whole frames, and lets a whole frame replace them', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await frame(7, 300)
    cache.putSegment(hash, 0, bytes.subarray(0, 100))
    cache.putSegment(hash, 1, bytes.subarray(100, 200))
    await cache.idle()
    expect(cache.has(hash)).toBe(false)
    expect(cache.hasSegment(hash, 1)).toBe(true)
    expect(await cache.segment(hash, 1)).toEqual(bytes.subarray(100, 200))
    expect(cache.frames).toBe(0)
    cache.put(hash, bytes)
    await cache.idle()
    expect(cache.has(hash)).toBe(true)
    expect(cache.hasSegment(hash, 0)).toBe(false)
    expect(cache.frames).toBe(1)
    expect(await files()).toEqual([`${Buffer.from(hash).toString('hex')}.frame`])
  })

  it('forgets every segment when cleared, and finds them again after a restart', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await frame(8, 200)
    cache.putSegment(hash, 0, bytes.subarray(0, 100))
    await cache.idle()
    const reopened = open(10_000)
    await reopened.ready()
    expect(reopened.hasSegment(hash, 0)).toBe(true)
    expect(reopened.frames).toBe(0)
    await reopened.clear()
    expect(reopened.hasSegment(hash, 0)).toBe(false)
    // A whole frame put after a clear finds no stale segments to drop.
    reopened.put(hash, bytes)
    await reopened.idle()
    expect(reopened.frames).toBe(1)
  })
})

describe('part of a frame kept whole (§6.2)', () => {
  /** A frame whose bytes differ along its length, so a slice of it is told from any other. */
  async function varied(size: number) {
    const bytes = new Uint8Array(size).map((_, index) => index % 251)
    return { bytes, hash: new Uint8Array(await sha256(bytes)) }
  }

  /** The kept frame's file, for spoiling or removing it. */
  function fileOf(hash: Uint8Array): string {
    const hex = Buffer.from(hash).toString('hex')
    return path.join(dir, hex.slice(0, 2), `${hex}.frame`)
  }

  it('reads part of a kept frame without reading the rest', async () => {
    const cache = open(10_000_000)
    await cache.ready()
    const { bytes, hash } = await varied(1024 * 1024)
    cache.put(hash, bytes)
    await cache.idle()
    const before = cache.stats.bytesRead
    const slice = await cache.frameSlice(hash, 1000, 500)
    expect(Buffer.from(slice ?? [])).toEqual(Buffer.from(bytes.subarray(1000, 1500)))
    expect(cache.stats.bytesRead - before).toBe(500)
  })

  it('reads part of a frame still on its way to the disk from memory', async () => {
    const cache = open(10_000_000)
    await cache.ready()
    const { bytes, hash } = await varied(100_000)
    cache.put(hash, bytes)
    // Not idle: the frame is waiting for the disk, and is read from where it is.
    const read = cache.frameSlice(hash, 70_000, 500)
    expect(Buffer.from((await read) ?? [])).toEqual(Buffer.from(bytes.subarray(70_000, 70_500)))
    expect(cache.stats.bytesRead).toBe(0)
    // Past its end is no part of it.
    expect(await cache.frameSlice(hash, 99_900, 500)).toBeNull()
  })

  it('marks a frame most recently used when part of it is read', async () => {
    const cache = open(250)
    await cache.ready()
    const a = await frame(5)
    const b = await frame(6)
    const c = await frame(7)
    for (const { bytes, hash } of [a, b]) {
      cache.put(hash, bytes)
      await cache.idle()
    }
    // `a` is used again, so `b` is the one to go.
    expect(await cache.frameSlice(a.hash, 10, 10)).not.toBeNull()
    cache.put(c.hash, c.bytes)
    await cache.idle()
    expect([a, b, c].map(({ hash }) => cache.has(hash))).toEqual([true, false, true])
  })

  it('gives null for part of a frame whose file is gone, and lets it go', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await varied(1000)
    cache.put(hash, bytes)
    await cache.idle()
    await rm(fileOf(hash))
    expect(await cache.frameSlice(hash, 0, 10)).toBeNull()
    expect(cache.has(hash)).toBe(false)
  })

  it('gives null for part of a frame whose file comes short, and lets it go', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await varied(1000)
    cache.put(hash, bytes)
    await cache.idle()
    await writeFile(fileOf(hash), bytes.subarray(0, 600))
    // The first 500 bytes are all there; the rest of the frame isn't.
    expect(await cache.frameSlice(hash, 400, 500)).toBeNull()
    expect(cache.has(hash)).toBe(false)
    expect(await cache.frameSlice(hash, 0, 10)).toBeNull()
  })

  it('gives null for part of a frame it never kept', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { hash } = await varied(1000)
    expect(await cache.frameSlice(hash, 0, 10)).toBeNull()
  })

  it('lets a frame kept whole go when told to', async () => {
    const cache = open(10_000)
    await cache.ready()
    const { bytes, hash } = await varied(1000)
    cache.put(hash, bytes)
    await cache.idle()
    cache.forget(hash)
    expect(cache.has(hash)).toBe(false)
    expect(await cache.frameSlice(hash, 0, 10)).toBeNull()
    await vi.waitFor(async () => {
      expect(await files()).toEqual([])
    })
  })
})

describe('FrameCache.clear', () => {
  it('lets every frame go, and caches what is read after', async () => {
    const cache = open(10_000)
    await cache.ready()
    const a = await frame(8)
    const b = await frame(9)
    for (const { bytes, hash } of [a, b]) await cache.load(hash, () => Promise.resolve(bytes))
    expect(await cache.clear()).toBe(200)
    expect({ bytes: cache.bytes, frames: cache.frames }).toEqual({ bytes: 0, frames: 0 })
    expect(await files()).toEqual([])
    const fetch = vi.fn(() => Promise.resolve(a.bytes))
    await cache.load(a.hash, fetch)
    expect(fetch).toHaveBeenCalledOnce()
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
