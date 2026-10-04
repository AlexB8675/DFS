import type { DriveNode, Session } from '@dfs/shared'
import type { InfiniteData } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient } from '@/app/query-client'
import {
  FLUSH_MS,
  PING_TIMEOUT_MS,
  RECONNECT_MIN_MS,
  startLiveEvents,
  subscribeToSyncs,
  useLiveStatus,
} from './live-events'

/** A minimal stand-in for the browser's EventSource. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = FakeEventSource.CONNECTING

  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.instances.push(this)
  }

  open() {
    this.readyState = FakeEventSource.OPEN
    this.dispatchEvent(new Event('open'))
  }

  /** What browsers do when the server answers with an HTTP error: give up. */
  fail() {
    this.readyState = FakeEventSource.CLOSED
    this.dispatchEvent(new Event('error'))
  }

  send(type: string, payload: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }))
  }

  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

const latest = () => {
  const source = FakeEventSource.instances.at(-1)
  if (!source) throw new Error('Not connected')
  return source
}

const folderId = crypto.randomUUID()
const fileId = crypto.randomUUID()
const listingKey = ['nodes', folderId, 'children', { sort: 'name', order: 'asc' }]

function seedListing() {
  const node: DriveNode = {
    id: fileId,
    parentId: folderId,
    kind: 'file',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 10,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
    syncState: 'syncing',
    hasChildFolders: false,
  }
  queryClient.setQueryData(listingKey, {
    pages: [{ items: [node], nextCursor: null }],
    pageParams: [null],
  })
}

function listedSyncState() {
  return queryClient.getQueryData<InfiniteData<{ items: DriveNode[] }>>(listingKey)?.pages[0]
    ?.items[0]?.syncState
}

describe('startLiveEvents', () => {
  let invalidate: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('navigator', { onLine: true })
    FakeEventSource.instances = []
    queryClient.clear()
    invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('patches synced files in place, batched, without refetching anything', () => {
    seedListing()
    const synced = vi.fn()
    const unsubscribe = subscribeToSyncs(synced)
    const stop = startLiveEvents()
    latest().open()
    latest().send('nodes.synced', {
      nodes: [{ id: fileId, parentId: folderId, syncState: 'stored' }],
    })

    expect(listedSyncState()).toBe('syncing')
    vi.advanceTimersByTime(FLUSH_MS)
    expect(listedSyncState()).toBe('stored')
    expect(synced).toHaveBeenCalledWith([{ id: fileId, parentId: folderId, syncState: 'stored' }])
    expect(invalidate).not.toHaveBeenCalled()
    unsubscribe()
    stop()
  })

  it('refetches only the folders that changed, once each', () => {
    const other = crypto.randomUUID()
    const stop = startLiveEvents()
    latest().open()
    latest().send('nodes.changed', { parentIds: [folderId, other] })
    latest().send('nodes.changed', { parentIds: [folderId] })
    vi.advanceTimersByTime(FLUSH_MS)

    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['nodes', folderId, 'children'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['nodes', other, 'children'] })
    stop()
  })

  it('sets the quota use straight from the event', () => {
    queryClient.setQueryData<Session>(['session'], {
      csrfToken: 'token',
      user: {
        id: crypto.randomUUID(),
        discordUserId: '1',
        displayName: 'Demo',
        avatarUrl: null,
        role: 'user',
        rootFolderId: crypto.randomUUID(),
        quotaBytes: 100,
        usedBytes: 10,
      },
    })
    const stop = startLiveEvents()
    latest().open()
    latest().send('quota.changed', { usedBytes: 42 })
    vi.advanceTimersByTime(FLUSH_MS)

    expect(queryClient.getQueryData<Session>(['session'])?.user.usedBytes).toBe(42)
    stop()
  })

  it('refetches everything when an event can’t be read', () => {
    const stop = startLiveEvents()
    latest().open()
    latest().send('nodes.synced', { nodes: 'garbled' })
    vi.advanceTimersByTime(FLUSH_MS)
    expect(invalidate).toHaveBeenCalledWith()
    stop()
  })

  it('reconnects with backoff after the server rejects the stream, then catches up', () => {
    const stop = startLiveEvents()
    expect(useLiveStatus.getState().status).toBe('connecting')
    latest().open()
    expect(useLiveStatus.getState().status).toBe('live')
    latest().fail()
    expect(useLiveStatus.getState().status).toBe('reconnecting')

    vi.advanceTimersByTime(RECONNECT_MIN_MS)
    expect(FakeEventSource.instances).toHaveLength(2)

    // A second failure waits twice as long.
    latest().fail()
    vi.advanceTimersByTime(RECONNECT_MIN_MS)
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(RECONNECT_MIN_MS)
    expect(FakeEventSource.instances).toHaveLength(3)

    // Back: whatever happened meanwhile is refetched.
    latest().open()
    vi.advanceTimersByTime(FLUSH_MS)
    expect(invalidate).toHaveBeenCalledWith()
    expect(useLiveStatus.getState().status).toBe('live')
    stop()
  })

  it('reconnects when the server goes quiet, since pings stopped arriving', () => {
    const stop = startLiveEvents()
    latest().open()
    vi.advanceTimersByTime(PING_TIMEOUT_MS - 1000)
    latest().send('ping', {})
    vi.advanceTimersByTime(PING_TIMEOUT_MS - 1000)
    expect(FakeEventSource.instances).toHaveLength(1)

    // The watchdog fires, then the reconnect runs on the next tick.
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED)
    stop()
  })

  it('reconnects at once when the network comes back', () => {
    const stop = startLiveEvents()
    latest().open()
    latest().fail()
    window.dispatchEvent(new Event('online'))
    vi.advanceTimersByTime(0)
    expect(FakeEventSource.instances).toHaveLength(2)
    stop()
  })

  it('stops reconnecting once stopped', () => {
    const stop = startLiveEvents()
    latest().fail()
    stop()
    vi.advanceTimersByTime(RECONNECT_MIN_MS * 10)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
