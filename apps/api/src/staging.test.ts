import type { Executor } from '@dfs/db'
import { describe, expect, it, vi } from 'vitest'
import { StagingLimit } from './staging.ts'

function database() {
  const execute = vi.fn<() => Promise<ReturnType<typeof usage>>>()
  return { execute, db: { execute } as unknown as Executor }
}

const usage = (bytes: number) => ({
  rows: [{ bytes }],
  rowCount: 1,
  command: 'SELECT',
  fields: [],
  oid: 0,
})

describe('StagingLimit', () => {
  it('shares a pending usage check and caches only the finished result', async () => {
    const { execute, db } = database()
    const pending = Promise.withResolvers<ReturnType<typeof usage>>()
    execute.mockReturnValueOnce(pending.promise)
    const limit = new StagingLimit(db, 100)
    const first = limit.isFull(10_000)
    const concurrent = limit.isFull(10_001)
    pending.resolve(usage(100))

    expect(await Promise.all([first, concurrent])).toEqual([true, true])
    expect(await limit.isFull(12_999)).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)

    execute.mockResolvedValueOnce(usage(20))
    expect(await limit.isFull(13_000)).toBe(false)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('retries a failed check immediately instead of caching the old answer', async () => {
    const { execute, db } = database()
    const error = new Error('Database unavailable.')
    execute.mockRejectedValueOnce(error).mockResolvedValueOnce(usage(100))
    const limit = new StagingLimit(db, 100)

    await expect(limit.isFull(10_000)).rejects.toBe(error)
    expect(await limit.isFull(10_001)).toBe(true)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('checks usage on first use even when the clock starts at zero', async () => {
    const { execute, db } = database()
    execute.mockResolvedValueOnce(usage(100))
    expect(await new StagingLimit(db, 100).isFull(0)).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
