import { createTestDatabase, withAdmin, type TestDatabase } from '@dfs/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { LeaderElection, type LeaderElectionOptions } from './leader.ts'

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }
const fast = { pollMs: 50, heartbeatMs: 50, backoff: { minMs: 20, maxMs: 100 } }

describe('leader election (DESIGN §11)', () => {
  let database: TestDatabase
  const running: LeaderElection[] = []

  function election(options: Partial<LeaderElectionOptions> = {}): LeaderElection {
    const instance = new LeaderElection({
      databaseUrl: database.url,
      log: quiet,
      onLead: () => Promise.resolve(),
      onLost: () => undefined,
      ...fast,
      ...options,
    })
    running.push(instance)
    instance.start()
    return instance
  }

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
  })

  afterEach(async () => {
    await Promise.all(running.splice(0).map((instance) => instance.stop()))
  })

  afterAll(async () => {
    await database.drop()
  })

  it('lets one instance lead while the other waits, and hands over when the leader stops', async () => {
    const first = election()
    await vi.waitFor(() => {
      expect(first.state).toBe('leader')
    })
    const second = election()
    await vi.waitFor(() => {
      expect(second.state).toBe('standby')
    })

    await first.stop()
    await vi.waitFor(() => {
      expect(second.state).toBe('leader')
    })
  })

  it('stops leading when the connection holding the lock dies', async () => {
    const onLost = vi.fn()
    const leader = election({ onLost })
    await vi.waitFor(() => {
      expect(leader.state).toBe('leader')
    })

    await withAdmin(database.url, (admin) =>
      admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'dfs-bot-leader'",
      ),
    )
    await vi.waitFor(() => {
      expect(onLost).toHaveBeenCalledOnce()
    })
    expect(leader.state).toBe('stopped')
  })

  it('gives leadership back if starting the leader’s work fails', async () => {
    let attempts = 0
    const leader = election({
      onLead: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('queue failed to start'))
          : Promise.resolve()
      },
    })
    await vi.waitFor(() => {
      expect(attempts).toBe(2)
      expect(leader.state).toBe('leader')
    })
  })

  it('keeps retrying while Postgres is unreachable', async () => {
    const waiting = new LeaderElection({
      ...fast,
      databaseUrl: 'postgres://dfs:dfs@127.0.0.1:1/dfs',
      log: quiet,
      onLead: () => Promise.resolve(),
      onLost: () => undefined,
    })
    running.push(waiting)
    waiting.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(waiting.state).toBe('connecting')
  })
})
