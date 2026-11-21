import { describe, expect, it } from 'vitest'
import { IndexCache } from './index-cache.ts'

// The chunks that opening and seeking needed (DESIGN.md §10.4), kept up to a limit.

const chunk = (start: number, size: number): { start: number; bytes: Uint8Array } => ({
  start,
  bytes: new Uint8Array(size),
})

describe('the index cache', () => {
  it('gives the head first, then the chunks added', () => {
    const cache = new IndexCache(chunk(0, 10), 100)
    cache.add(chunk(500, 20))
    cache.add(chunk(100, 30))
    expect(cache.chunks().map((one) => one.start)).toEqual([0, 500, 100])
    expect(cache.bytes).toBe(60)
  })

  it('drops the oldest chunk first when the limit is passed, and never the head', () => {
    const cache = new IndexCache(chunk(0, 50), 120)
    cache.add(chunk(1, 30))
    cache.add(chunk(2, 30))
    expect(cache.chunks().map((one) => one.start)).toEqual([0, 1, 2])
    cache.add(chunk(3, 30))
    expect(cache.chunks().map((one) => one.start)).toEqual([0, 2, 3])
  })

  it('keeps the chunk just added even when it alone is over the limit', () => {
    const cache = new IndexCache(chunk(0, 50), 100)
    cache.add(chunk(1, 30))
    cache.add(chunk(2, 500))
    expect(cache.chunks().map((one) => one.start)).toEqual([0, 2])
  })
})
