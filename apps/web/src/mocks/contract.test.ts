import { defineContractSuite, type ContractTarget } from '@dfs/contract'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The contract suite (BACKEND.md §5) against the mock API, served by MSW in
// Node, so the mock and the real API answer the same.

vi.hoisted(() => {
  const storage = new Map<string, string>()
  Object.assign(globalThis, {
    window: globalThis,
    location: { origin: 'http://localhost', href: 'http://localhost/' },
    // MSW's SSE handler insists on the API existing; the suite doesn't use it.
    EventSource: function EventSource() {
      throw new Error('EventSource is not available in the contract suite.')
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
})

const { db, handlers, setResponseDelay } = await import('./handlers')
const { DEMO_ACCOUNTS } = await import('./seed')
const server = setupServer(...handlers)

const demoOwner = DEMO_ACCOUNTS.find((account) => account.username === 'demo')
if (!demoOwner) throw new Error('The seed has no demo owner.')

const target: ContractTarget = {
  name: 'mock',
  baseUrl: 'http://localhost',
  origin: 'http://localhost',
  owner: { username: demoOwner.username, password: demoOwner.password },
  settle: () => {
    db.finishSyncs()
    return Promise.resolve()
  },
}

beforeAll(() => {
  setResponseDelay(false)
  server.listen({ onUnhandledFrame: 'error' })
})

afterAll(() => {
  server.close()
})

defineContractSuite({ describe, it, expect }, () => target)
