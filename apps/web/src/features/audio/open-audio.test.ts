import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.assign(globalThis, {
    window: globalThis,
    // MSW resolves the app's relative `/api/...` URLs against this.
    location: { origin: 'http://localhost', href: 'http://localhost/' },
  })
})

const { queryClient } = await import('@/app/query-client')
const { audioQuery } = await import('./open-audio')

// Asking under a link that answered a 4xx is not repeated (DESIGN.md §7.5,
// D46): each ask under a gone link counts against the viewer's address.

let asked = 0
const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' })
})
afterEach(() => {
  queryClient.clear()
  server.resetHandlers()
  asked = 0
})
afterAll(() => {
  server.close()
})

/** Every audio ask answers `status`, counted. */
function answering(status: number): void {
  server.use(
    http.get('*/api/s/:token/audio', () => {
      asked += 1
      return HttpResponse.json({ error: { code: 'failed', message: 'No.' } }, { status })
    }),
  )
}

/** Opens a link's queue the way the app does, with no wait between retries. */
async function openUnderLink(): Promise<unknown> {
  // The app's own client, whose default retry a link's query replaces.
  return queryClient.query({ ...audioQuery('folder', 'short', false), retryDelay: 0 }).then(
    () => null,
    (error: unknown) => error,
  )
}

describe('audioQuery under a link', () => {
  it('asks once of a link that answered 404', async () => {
    answering(404)
    expect(await openUnderLink()).toMatchObject({ status: 404 })
    expect(asked).toBe(1)
  })

  it('asks once of an address that answered 429', async () => {
    answering(429)
    expect(await openUnderLink()).toMatchObject({ status: 429 })
    expect(asked).toBe(1)
  })

  it('retries server errors, twice', async () => {
    answering(503)
    expect(await openUnderLink()).toMatchObject({ status: 503 })
    expect(asked).toBe(3)
  })

  it('leaves the drive to the default retry', () => {
    expect(audioQuery('folder', null, false).retry).toBeUndefined()
    expect(audioQuery('folder', 'short', false).retry).toBeTypeOf('function')
  })
})
