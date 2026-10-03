import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient } from '@/app/query-client'
import { DEBOUNCE_MS, RECONNECT_MIN_MS, startLiveEvents } from './live-events'

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

  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

const latest = () => FakeEventSource.instances.at(-1)

describe('startLiveEvents', () => {
  let invalidate: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.instances = []
    invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('coalesces a burst of events into one refresh per query', () => {
    const stop = startLiveEvents()
    latest()?.open()
    for (let i = 0; i < 5; i += 1) latest()?.dispatchEvent(new Event('nodes.changed'))

    expect(invalidate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['nodes'] })
    stop()
  })

  it('reconnects with backoff after the server rejects the stream, then refreshes', () => {
    const stop = startLiveEvents()
    latest()?.open()
    latest()?.fail()

    vi.advanceTimersByTime(RECONNECT_MIN_MS)
    expect(FakeEventSource.instances).toHaveLength(2)

    // A second failure waits twice as long.
    latest()?.fail()
    vi.advanceTimersByTime(RECONNECT_MIN_MS)
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(RECONNECT_MIN_MS)
    expect(FakeEventSource.instances).toHaveLength(3)

    // Back online: everything is refetched, since events may have been missed.
    latest()?.open()
    expect(invalidate).toHaveBeenCalledWith()
    stop()
  })

  it('stops reconnecting once stopped', () => {
    const stop = startLiveEvents()
    latest()?.fail()
    stop()
    vi.advanceTimersByTime(RECONNECT_MIN_MS * 10)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
