import { queryClient } from '@/app/query-client'

/** Bursts of events (a whole pack syncing at once) collapse into one refresh. */
export const DEBOUNCE_MS = 300
export const RECONNECT_MIN_MS = 1000
export const RECONNECT_MAX_MS = 30_000

const EVENT_QUERIES: Record<string, readonly string[]> = {
  'nodes.changed': ['nodes'],
  'quota.changed': ['session'],
}

/**
 * Subscribes to the server's live events (`GET /api/events`, §6.1) and
 * refetches the affected queries. Returns a function that disconnects.
 *
 * `EventSource` retries dropped connections by itself, but gives up for good
 * when the server answers with an error (during a deploy, say), so this
 * reconnects with backoff and refreshes everything once it is back, in case
 * events were missed in between.
 */
export function startLiveEvents(url = '/api/events'): () => void {
  const pending = new Set<string>()
  let source: EventSource | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = RECONNECT_MIN_MS
  let connectedBefore = false

  const flush = () => {
    debounceTimer = undefined
    for (const key of pending) void queryClient.invalidateQueries({ queryKey: [key] })
    pending.clear()
  }

  const connect = () => {
    const current = new EventSource(url)
    source = current

    current.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS
      if (connectedBefore) void queryClient.invalidateQueries()
      connectedBefore = true
    })

    current.addEventListener('error', () => {
      if (current.readyState !== EventSource.CLOSED) return
      reconnectTimer = setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    })

    for (const [type, queryKeys] of Object.entries(EVENT_QUERIES)) {
      current.addEventListener(type, () => {
        queryKeys.forEach((key) => pending.add(key))
        debounceTimer ??= setTimeout(flush, DEBOUNCE_MS)
      })
    }
  }

  connect()

  return () => {
    clearTimeout(debounceTimer)
    clearTimeout(reconnectTimer)
    source?.close()
  }
}
