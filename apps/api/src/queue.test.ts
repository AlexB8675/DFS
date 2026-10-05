import type { Config } from '@dfs/config'
import type { FastifyBaseLogger } from 'fastify'
import { PgBoss } from 'pg-boss'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobQueue } from './queue.ts'

vi.mock('pg-boss', () => ({ PgBoss: vi.fn() }))

const config = { databaseUrl: 'postgres://test' } as Config
const log = { error: vi.fn() } as unknown as FastifyBaseLogger
const bosses: FakeBoss[] = []

class FakeBoss {
  readonly on = vi.fn()
  readonly start = vi.fn(() => Promise.resolve())
  readonly createQueue = vi.fn(() => Promise.resolve())
  readonly stop = vi.fn(() => Promise.resolve())
}

beforeEach(() => {
  bosses.length = 0
  vi.mocked(PgBoss).mockImplementation(function () {
    const boss = new FakeBoss()
    bosses.push(boss)
    return boss as unknown as PgBoss
  })
})

describe('job queue startup', () => {
  it.each(['start', 'createQueue'] as const)(
    'cleans up a failed %s before allowing a retry',
    async (phase) => {
      const failed = new FakeBoss()
      const error = new Error('Database unavailable.')
      failed[phase].mockRejectedValueOnce(error)
      // Cleanup errors must preserve the failure that caused startup to stop.
      failed.stop.mockRejectedValueOnce(new Error('Connection already closed.'))
      vi.mocked(PgBoss).mockImplementationOnce(function () {
        return failed as unknown as PgBoss
      })
      const queue = new JobQueue(config, log)
      await expect(queue.get()).rejects.toBe(error)
      expect(failed.stop).toHaveBeenCalledExactlyOnceWith({ graceful: false })
      const retry = await queue.get()
      expect(retry).toBe(bosses[0])
      await queue.stop()
    },
  )
})
