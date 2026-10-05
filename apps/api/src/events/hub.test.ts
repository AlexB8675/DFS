import { EventEmitter } from 'node:events'
import type { FastifyBaseLogger } from 'fastify'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventHub } from './hub.ts'

vi.mock('pg', () => ({ default: { Client: vi.fn() } }))

let connectMode: 'success' | 'pending' | 'failure'
let pendingListen: boolean
const clients: FakeClient[] = []

class FakeClient extends EventEmitter {
  readonly connected = Promise.withResolvers<undefined>()
  readonly listening = Promise.withResolvers<undefined>()
  readonly connect = vi.fn(() => {
    if (connectMode === 'pending') return this.connected.promise
    if (connectMode === 'failure') return Promise.reject(new Error('Database unavailable.'))
    return Promise.resolve()
  })
  readonly query = vi.fn(() => (pendingListen ? this.listening.promise : Promise.resolve()))
  readonly end = vi.fn(() => {
    this.emit('end')
    return Promise.resolve()
  })
}

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  clients.length = 0
  connectMode = 'success'
  pendingListen = false
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

describe('EventHub lifecycle', () => {
  it.each(['connect', 'listen'])(
    'closes a connection still waiting to %s during shutdown',
    async (phase) => {
      connectMode = phase === 'connect' ? 'pending' : 'success'
      pendingListen = phase === 'listen'
      const hub = new EventHub('postgres://test', log)
      hub.subscribe('user', vi.fn(), vi.fn())
      await settle()
      const client = clients[0]
      if (!client) throw new Error('No event connection opened.')
      const stopping = hub.stop()
      await stopping
      await settle()
      expect(client.end).toHaveBeenCalled()
      hub.subscribe('other', vi.fn(), vi.fn())
      expect(clients).toHaveLength(1)
    },
  )

  it('keeps reconnect backoff when more subscribers arrive while the database is down', async () => {
    connectMode = 'failure'
    const hub = new EventHub('postgres://test', log)
    try {
      hub.subscribe('first', vi.fn(), vi.fn())
      await settle()
      hub.subscribe('second', vi.fn(), vi.fn())
      await settle()
      expect(clients).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(clients).toHaveLength(2)
      await hub.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(clients).toHaveLength(2)
    } finally {
      await hub.stop()
    }
  })

  it('retries a connection that ends before LISTEN finishes instead of keeping it', async () => {
    pendingListen = true
    const hub = new EventHub('postgres://test', log)
    try {
      hub.subscribe('user', vi.fn(), vi.fn())
      await settle()
      const client = clients[0]
      if (!client) throw new Error('No event connection opened.')
      client.emit('end')
      client.listening.resolve(undefined)
      await settle()
      pendingListen = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(clients).toHaveLength(2)
      expect(client.end).toHaveBeenCalled()
    } finally {
      for (const client of clients) client.listening.resolve(undefined)
      await hub.stop()
    }
  })
})
