import { generateDek, importAesKey, type AesKey } from '@dfs/crypto'
import { describe, expect, it, vi } from 'vitest'
import { DataKeyCache } from './keys.ts'

describe('DataKeyCache', () => {
  it('shares pending unwraps and retries failures', async () => {
    const cache = new DataKeyCache()
    const pending = Promise.withResolvers<AesKey>()
    const unwrap = vi.fn(() => pending.promise)
    const first = cache.get('version', unwrap)
    expect(cache.get('version', unwrap)).toBe(first)
    expect(unwrap).toHaveBeenCalledTimes(1)

    const error = new Error('Unwrap failed.')
    pending.reject(error)
    await expect(first).rejects.toBe(error)
    const key = await importAesKey(generateDek())
    expect(await cache.get('version', () => Promise.resolve(key))).toBe(key)
  })

  it('does not evict a replacement when an older, evicted unwrap fails', async () => {
    const cache = new DataKeyCache(1)
    const old = Promise.withResolvers<AesKey>()
    const first = cache.get('version', () => old.promise)
    const key = await importAesKey(generateDek())
    await cache.get('other', () => Promise.resolve(key))
    const replacement = cache.get('version', () => Promise.resolve(key))

    const error = new Error('Old unwrap failed.')
    old.reject(error)
    await expect(first).rejects.toBe(error)
    const unwrap = vi.fn(() => Promise.resolve(key))
    expect(cache.get('version', unwrap)).toBe(replacement)
    expect(unwrap).not.toHaveBeenCalled()
  })
})
