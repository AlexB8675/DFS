import { MOCK_RESPONSE_HEADER } from './marker'

/** How long to wait for the worker to confirm before retrying anyway. */
const ACTIVATION_TIMEOUT_MS = 1000

let pendingActivation: Promise<void> | null = null

/**
 * Keeps the mock API answering after the browser restarts its service worker.
 *
 * Browsers stop idle service workers, and background tabs throttle the timer
 * MSW uses to keep its worker awake. A restarted worker forgets which pages it
 * mocks for and hands their requests to the dev server, which answers 404, so
 * the drive suddenly looks empty. This re-registers the page with the worker
 * when the tab becomes visible again and, as a safety net, whenever an API
 * response arrives that the mock did not produce, then retries that request.
 */
export function keepMockingActive(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void reactivate()
  })

  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const retryInput = input instanceof Request ? input.clone() : input
    const response = await nativeFetch(input, init)
    if (!isApiRequest(input) || response.headers.has(MOCK_RESPONSE_HEADER)) return response
    await reactivate()
    return nativeFetch(retryInput, init)
  }
}

/** Sends MSW's activation handshake once, however many requests are waiting on it. */
function reactivate(): Promise<void> {
  pendingActivation ??= sendActivation().finally(() => {
    pendingActivation = null
  })
  return pendingActivation
}

async function sendActivation(): Promise<void> {
  const worker = navigator.serviceWorker.controller
  if (!worker) return

  await new Promise<void>((resolve) => {
    const finish = () => {
      navigator.serviceWorker.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      resolve()
    }
    const onMessage = (event: MessageEvent) => {
      if (isMockingEnabled(event.data)) finish()
    }
    const timer = window.setTimeout(finish, ACTIVATION_TIMEOUT_MS)
    navigator.serviceWorker.addEventListener('message', onMessage)
    // The same message MSW sends on start; the worker answers "MOCKING_ENABLED".
    worker.postMessage('MOCK_ACTIVATE')
  })
}

function isMockingEnabled(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null && 'type' in data && data.type === 'MOCKING_ENABLED'
  )
}

function isApiRequest(input: RequestInfo | URL): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
  return url.origin === window.location.origin && url.pathname.startsWith('/api/')
}
