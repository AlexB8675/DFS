import { liveEventSchemas, type Session, type SyncState } from '@dfs/shared'
import type { z } from 'zod'
import { create } from 'zustand'
import { queryClient } from '@/app/query-client'
import { invalidateListings, patchNodes } from '@/features/drive/cache'

// The live connection to the server (`GET /api/events`, §6.1).
//
// Server-Sent Events rather than WebSockets: the traffic is one-way (the
// browser talks back over plain HTTP), SSE runs over the same HTTP/2
// connection as the API behind Caddy, and the API fans out Postgres
// LISTEN/NOTIFY to it (D11). WebSockets would add a second protocol for no gain.
//
// Payloads say what changed, so the UI updates in place: synced files are
// patched in the cache, only the folders that changed refetch, and the quota
// is set directly. Events arriving together are applied in one batch.

/** Events arriving within this window are applied together. */
export const FLUSH_MS = 100
export const RECONNECT_MIN_MS = 1000
export const RECONNECT_MAX_MS = 30_000
/** The server pings every 25 s; silence this long means the connection is dead. */
export const PING_TIMEOUT_MS = 60_000

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

/** The connection state, for the indicator in the header. */
export const useLiveStatus = create<{ status: LiveStatus }>()(() => ({ status: 'connecting' }))

export interface SyncedNode {
  id: string
  parentId: string
  syncState: SyncState
}

const syncListeners = new Set<(nodes: SyncedNode[]) => void>()

/** Calls `listener` with files whose sync state changed, e.g. for the upload panel's second phase. */
export function subscribeToSyncs(listener: (nodes: SyncedNode[]) => void): () => void {
  syncListeners.add(listener)
  return () => syncListeners.delete(listener)
}

const resyncListeners = new Set<() => void>()

/** Calls `listener` after a reconnect, when events may have been missed and caches refetch. */
export function subscribeToResync(listener: () => void): () => void {
  resyncListeners.add(listener)
  return () => resyncListeners.delete(listener)
}

interface Pending {
  synced: Map<string, SyncedNode>
  changedFolders: Set<string>
  usedBytes: number | null
  /** Set after a reconnect or an unreadable event: anything may be stale. */
  refetchAll: boolean
}

/** Connects to the server's live events. Returns a function that disconnects. */
export function startLiveEvents(url = '/api/events'): () => void {
  const setStatus = (status: LiveStatus) => {
    useLiveStatus.setState({ status })
  }
  let pending: Pending = emptyPending()
  let source: EventSource | null = null
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = RECONNECT_MIN_MS
  let connectedBefore = false
  let stopped = false

  const flush = () => {
    flushTimer = undefined
    const batch = pending
    pending = emptyPending()
    applyBatch(batch)
  }
  const scheduleFlush = () => {
    flushTimer ??= setTimeout(flush, FLUSH_MS)
  }

  /** Drops the connection and tries again after `delay`. */
  const reconnect = (delay: number) => {
    source?.close()
    source = null
    clearTimeout(watchdog)
    clearTimeout(reconnectTimer)
    setStatus(navigator.onLine ? 'reconnecting' : 'offline')
    reconnectTimer = setTimeout(connect, delay)
  }

  const armWatchdog = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      reconnect(0)
    }, PING_TIMEOUT_MS)
  }

  function connect() {
    if (stopped) return
    const current = new EventSource(url)
    source = current
    if (!connectedBefore) setStatus('connecting')

    current.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS
      setStatus('live')
      armWatchdog()
      // Events are not stored on the server; whatever happened while we were away is refetched.
      if (connectedBefore) {
        pending.refetchAll = true
        scheduleFlush()
      }
      connectedBefore = true
    })

    current.addEventListener('error', () => {
      if (current.readyState === EventSource.CLOSED) {
        // The server answered with an error (a deploy, say): EventSource gives up for good.
        reconnect(reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
      } else {
        // EventSource is already retrying on its own.
        setStatus(navigator.onLine ? 'reconnecting' : 'offline')
      }
    })

    const listen = <S extends z.ZodType>(
      type: string,
      schema: S,
      apply: (payload: z.infer<S>) => void,
    ) => {
      current.addEventListener(type, (event) => {
        armWatchdog()
        const parsed = schema.safeParse(readJson(event))
        if (parsed.success) apply(parsed.data)
        else pending.refetchAll = true
        scheduleFlush()
      })
    }

    listen('nodes.synced', liveEventSchemas['nodes.synced'], ({ nodes }) => {
      for (const node of nodes) pending.synced.set(node.id, node)
    })
    listen('nodes.changed', liveEventSchemas['nodes.changed'], ({ parentIds }) => {
      for (const id of parentIds) pending.changedFolders.add(id)
    })
    listen('quota.changed', liveEventSchemas['quota.changed'], ({ usedBytes }) => {
      pending.usedBytes = usedBytes
    })
    listen('ping', liveEventSchemas.ping, () => undefined)
  }

  const handleOffline = () => {
    setStatus('offline')
  }
  const handleOnline = () => {
    // Back on the network: don't sit out the rest of a long backoff.
    if (useLiveStatus.getState().status !== 'live') {
      reconnectDelay = RECONNECT_MIN_MS
      reconnect(0)
    }
  }
  window.addEventListener('offline', handleOffline)
  window.addEventListener('online', handleOnline)

  connect()

  return () => {
    stopped = true
    clearTimeout(flushTimer)
    clearTimeout(reconnectTimer)
    clearTimeout(watchdog)
    window.removeEventListener('offline', handleOffline)
    window.removeEventListener('online', handleOnline)
    source?.close()
  }
}

function emptyPending(): Pending {
  return { synced: new Map(), changedFolders: new Set(), usedBytes: null, refetchAll: false }
}

function applyBatch(batch: Pending): void {
  if (batch.refetchAll) {
    void queryClient.invalidateQueries()
  }
  if (batch.synced.size > 0) {
    const nodes = [...batch.synced.values()]
    patchNodes(new Map(nodes.map((node) => [node.id, { syncState: node.syncState }])))
    for (const listener of syncListeners) listener(nodes)
  }
  if (!batch.refetchAll && batch.changedFolders.size > 0) {
    void invalidateListings(batch.changedFolders)
  }
  const { usedBytes } = batch
  if (usedBytes !== null) {
    queryClient.setQueryData<Session>(
      ['session'],
      (session) => session && { ...session, user: { ...session.user, usedBytes } },
    )
  }
  // Fresh events can arrive in the same batch as the reconnect; keep them,
  // then check whatever still needs to catch up.
  if (batch.refetchAll) for (const listener of resyncListeners) listener()
}

function readJson(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return undefined
  try {
    return JSON.parse(event.data)
  } catch {
    return undefined
  }
}
