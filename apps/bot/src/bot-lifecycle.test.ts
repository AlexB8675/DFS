import { EventEmitter } from 'node:events'
import path from 'node:path'
import { loadConfig } from '@dfs/config'
import type * as Db from '@dfs/db'
import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBot } from './bot.ts'
import { startLeaderWork } from './leader-work.ts'

vi.mock('@dfs/db', async (original) => {
  const db = await original<typeof Db>()
  return { ...db, createPool: () => ({ end: vi.fn() }), createDatabase: () => ({}) }
})
vi.mock('pg', () => ({ default: { Client: vi.fn() } }))
vi.mock('pg-boss', () => ({ PgBoss: vi.fn() }))
vi.mock('./leader-work.ts', () => ({ startLeaderWork: vi.fn() }))

class FakeClient extends EventEmitter {
  readonly connect = vi.fn(() => Promise.resolve())
  readonly query = vi.fn(() => Promise.resolve({ rows: [{ locked: true }] }))
  readonly end = vi.fn(() => {
    this.emit('end')
    return Promise.resolve()
  })
}

beforeEach(() => {
  vi.mocked(pg.Client).mockImplementation(function () {
    return new FakeClient() as unknown as pg.Client
  })
})

describe('bot startup shutdown', () => {
  it.each(['queue', 'work'] as const)('cleans up startup interrupted during %s', async (phase) => {
    const pending = Promise.withResolvers<undefined>()
    const queue = {
      on: vi.fn(),
      start: vi.fn(() => (phase === 'queue' ? pending.promise : Promise.resolve())),
      stop: vi.fn(() => Promise.resolve()),
    }
    const work = { stop: vi.fn(() => Promise.resolve()) }
    vi.mocked(PgBoss).mockImplementation(function () {
      return queue as unknown as PgBoss
    })
    vi.mocked(startLeaderWork).mockImplementation(async () => {
      if (phase === 'work') await pending.promise
      return work
    })
    const config = loadConfig(
      { NODE_ENV: 'test', DATABASE_URL: 'postgres://test' },
      { service: 'bot', rootDir: path.resolve('/repo') },
    )
    const bot = createBot({ config, logger: false, onLeadershipLost: vi.fn() })
    try {
      await vi.waitFor(() => {
        if (phase === 'queue') expect(queue.start).toHaveBeenCalledOnce()
        else expect(startLeaderWork).toHaveBeenCalledOnce()
      })
      const stopping = bot.stop()
      pending.resolve(undefined)
      await stopping
      expect(bot.queue()).toBeNull()
      expect(queue.stop).toHaveBeenCalledExactlyOnceWith({ graceful: false })
      if (phase === 'work') expect(work.stop).toHaveBeenCalledOnce()
      else expect(startLeaderWork).not.toHaveBeenCalled()
    } finally {
      pending.resolve(undefined)
      await bot.stop()
      vi.clearAllMocks()
    }
  })
})
