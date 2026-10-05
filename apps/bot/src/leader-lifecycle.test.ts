import { EventEmitter } from 'node:events'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeaderElection } from './leader.ts'

vi.mock('pg', () => ({ default: { Client: vi.fn() } }))

const clients: FakeClient[] = []
let pendingConnect: boolean
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

class FakeClient extends EventEmitter {
  readonly connected = Promise.withResolvers<undefined>()
  readonly connect = vi.fn(() => (pendingConnect ? this.connected.promise : Promise.resolve()))
  readonly query = vi.fn(() => Promise.resolve({ rows: [{ locked: true }] }))
  readonly end = vi.fn(() => {
    this.emit('end')
    return Promise.resolve()
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  clients.length = 0
  pendingConnect = false
  vi.mocked(pg.Client).mockImplementation(function () {
    const client = new FakeClient()
    clients.push(client)
    return client as unknown as pg.Client
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('leader lifecycle', () => {
  it('closes a connecting client even when pg leaves connect pending after end', async () => {
    pendingConnect = true
    const onLead = vi.fn(() => Promise.resolve())
    const leader = new LeaderElection({
      databaseUrl: 'postgres://test',
      log: quiet,
      onLead,
      onLost: vi.fn(),
    })
    leader.start()
    const client = clients[0]
    if (!client) throw new Error('No leader connection opened.')
    await leader.stop()
    expect(client.end).toHaveBeenCalled()
    client.connected.resolve(undefined)
    await settle()
    expect(leader.state).toBe('stopped')
    expect(onLead).not.toHaveBeenCalled()
    await leader.stop()
  })

  it.each(['success', 'failure'])(
    'waits for leader startup during shutdown when it ends in %s',
    async (result) => {
      const leading = Promise.withResolvers<undefined>()
      const onLead = vi.fn(() => leading.promise)
      const leader = new LeaderElection({
        databaseUrl: 'postgres://test',
        log: quiet,
        onLead,
        onLost: vi.fn(),
      })
      leader.start()
      await settle()
      expect(onLead).toHaveBeenCalledOnce()
      let stopped = false
      const stopping = leader.stop().then(() => {
        stopped = true
      })
      await settle()
      expect(stopped).toBe(false)
      if (result === 'success') leading.resolve(undefined)
      else leading.reject(new Error('Startup failed during shutdown.'))
      await stopping
      expect(leader.state).toBe('stopped')
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does not start more than one attempt when start is called repeatedly', async () => {
    pendingConnect = true
    const leader = new LeaderElection({
      databaseUrl: 'postgres://test',
      log: quiet,
      onLead: () => Promise.resolve(),
      onLost: vi.fn(),
    })
    leader.start()
    leader.start()
    expect(clients).toHaveLength(1)
    await leader.stop()
  })
})
