import { timelineEventSchema, type TimelineEventInput } from '@dfs/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionNow, watchPage } from './watch-page'

/** An `EventTarget` that knows which listeners it still holds. */
class Watched extends EventTarget {
  private readonly held = new Map<string, Set<EventListenerOrEventListenerObject>>()
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options)
    if (callback === null) return
    const callbacks = this.held.get(type) ?? new Set()
    callbacks.add(callback)
    this.held.set(type, callbacks)
  }
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback, options)
    if (callback !== null) this.held.get(type)?.delete(callback)
  }
  /** How many listeners are still attached. */
  get listening(): number {
    let count = 0
    for (const callbacks of this.held.values()) count += callbacks.size
    return count
  }
}

class FakeConnection extends Watched {
  effectiveType: string | undefined = '4g'
  downlink: number | undefined = 10
  rtt: number | undefined = 50
  saveData: boolean | undefined = false
}

class FakeDocument extends Watched {
  visibilityState = 'visible'
}

interface Page {
  document: FakeDocument
  window: Watched
  navigator: { onLine: boolean; connection?: FakeConnection }
}

/** Stubs the page globals the watcher reads, with a connection unless `connection` is false. */
function stubPage(connection = true): Page {
  const page: Page = {
    document: new FakeDocument(),
    window: new Watched(),
    navigator: { onLine: true },
  }
  if (connection) page.navigator.connection = new FakeConnection()
  vi.stubGlobal('document', page.document)
  vi.stubGlobal('window', page.window)
  vi.stubGlobal('navigator', page.navigator)
  return page
}

/** What the watcher did, in order: events recorded and keepalive flushes asked for. */
type Step = TimelineEventInput | 'flush'

/** Watches the page, collecting what is recorded and flushed in the order it happens. */
function watch() {
  const steps: Step[] = []
  const stop = watchPage(
    (event) => {
      steps.push(event)
    },
    () => {
      steps.push('flush')
    },
  )
  const events = () => steps.filter((step) => step !== 'flush')
  return { steps, events, stop }
}

/** Every recorded event as the recorder would check it. */
function refused(events: readonly TimelineEventInput[]) {
  return events.filter((event) => !timelineEventSchema.safeParse({ ...event, t: 0 }).success)
}

let page: Page

beforeEach(() => {
  page = stubPage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('watchPage (§10.4, §16)', () => {
  it('records going offline, hiding and a connection change', () => {
    const { events } = watch()

    page.window.dispatchEvent(new Event('offline'))
    page.window.dispatchEvent(new Event('online'))
    page.document.visibilityState = 'hidden'
    page.document.dispatchEvent(new Event('visibilitychange'))
    page.document.visibilityState = 'visible'
    page.document.dispatchEvent(new Event('visibilitychange'))

    const connection = page.navigator.connection
    if (connection === undefined) throw new Error('no connection')
    connection.effectiveType = '3g'
    connection.downlink = 1.5
    connection.rtt = 300
    connection.saveData = true
    connection.dispatchEvent(new Event('change'))

    expect(events()).toEqual([
      { type: 'network', online: false },
      { type: 'network', online: true },
      { type: 'visibility', hidden: true },
      { type: 'visibility', hidden: false },
      {
        type: 'connection',
        connection: { effectiveType: '3g', downlinkMbps: 1.5, rttMs: 300, saveData: true },
      },
    ])
    expect(refused(events())).toEqual([])
  })

  it('records hiding before it flushes, so the batch that goes holds it', () => {
    const { steps } = watch()
    page.document.visibilityState = 'hidden'
    page.document.dispatchEvent(new Event('visibilitychange'))
    expect(steps).toEqual([{ type: 'visibility', hidden: true }, 'flush'])
  })

  it('records showing the page again and flushes nothing', () => {
    const { steps } = watch()
    page.document.visibilityState = 'hidden'
    page.document.dispatchEvent(new Event('visibilitychange'))
    page.document.visibilityState = 'visible'
    page.document.dispatchEvent(new Event('visibilitychange'))
    expect(steps).toEqual([
      { type: 'visibility', hidden: true },
      'flush',
      { type: 'visibility', hidden: false },
    ])
  })

  it('flushes as the page leaves', () => {
    const { steps } = watch()
    page.window.dispatchEvent(new Event('pagehide'))
    expect(steps).toEqual(['flush'])
  })

  it('flushes nothing for going offline or a connection change', () => {
    const { steps } = watch()
    page.window.dispatchEvent(new Event('offline'))
    page.navigator.connection?.dispatchEvent(new Event('change'))
    expect(steps.filter((step) => step === 'flush')).toEqual([])
  })

  it('watches a browser without a connection API', () => {
    page = stubPage(false)
    const { events, stop } = watch()
    page.window.dispatchEvent(new Event('offline'))
    expect(events()).toEqual([{ type: 'network', online: false }])
    expect(() => {
      stop()
    }).not.toThrow()
  })

  it('stops listening when stopped', () => {
    const { steps, stop } = watch()
    const connection = page.navigator.connection
    if (connection === undefined) throw new Error('no connection')
    expect(page.window.listening).toBeGreaterThan(0)
    expect(page.document.listening).toBeGreaterThan(0)
    expect(connection.listening).toBeGreaterThan(0)

    stop()
    expect(page.window.listening).toBe(0)
    expect(page.document.listening).toBe(0)
    expect(connection.listening).toBe(0)

    page.window.dispatchEvent(new Event('offline'))
    page.window.dispatchEvent(new Event('pagehide'))
    page.document.visibilityState = 'hidden'
    page.document.dispatchEvent(new Event('visibilitychange'))
    connection.dispatchEvent(new Event('change'))
    expect(steps).toEqual([])
    // Stopping again changes nothing.
    expect(() => {
      stop()
    }).not.toThrow()
  })
})

describe('connectionNow (§16)', () => {
  it('reads navigator.connection', () => {
    expect(connectionNow()).toEqual({
      effectiveType: '4g',
      downlinkMbps: 10,
      rttMs: 50,
      saveData: false,
    })
  })

  it('is null where the browser has none', () => {
    stubPage(false)
    expect(connectionNow()).toBeNull()
  })

  it('leaves out what the browser doesn’t say or says badly', () => {
    const connection = page.navigator.connection
    if (connection === undefined) throw new Error('no connection')
    connection.effectiveType = undefined
    connection.downlink = -1
    connection.rtt = NaN
    connection.saveData = undefined
    expect(connectionNow()).toEqual({
      effectiveType: null,
      downlinkMbps: null,
      rttMs: null,
      saveData: null,
    })
    connection.effectiveType = 'a-very-long-type'
    connection.downlink = Infinity
    connection.rtt = 0
    connection.saveData = true
    expect(connectionNow()).toEqual({
      effectiveType: 'a-very-lon',
      downlinkMbps: null,
      rttMs: 0,
      saveData: true,
    })
  })
})
