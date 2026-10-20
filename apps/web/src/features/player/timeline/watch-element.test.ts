import { timelineEventSchema, type TimelineEventInput } from '@dfs/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionNow, watchElement } from './watch-element'

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

/** The parts of a `<video>` the watcher reads. */
class FakeVideo extends Watched {
  currentTime = 0
  readyState = 0
  paused = true
  error: { code: number; message: string } | null = null
  /** The buffered ranges, as the element reports them. */
  ranges: [number, number][] = []
  frames = 0
  dropped = 0
  get buffered() {
    const ranges = this.ranges
    return {
      length: ranges.length,
      start: (index: number) => ranges[index]?.[0] ?? NaN,
      end: (index: number) => ranges[index]?.[1] ?? NaN,
    }
  }
  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.frames, droppedVideoFrames: this.dropped }
  }
}

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void

/** A `<video>` that can say when a frame is presented. */
class FrameVideo extends FakeVideo {
  /** Callbacks asked for and neither run nor cancelled, by handle. */
  readonly waiting = new Map<number, FrameCallback>()
  readonly cancelled: number[] = []
  private next = 1
  requestVideoFrameCallback(callback: FrameCallback): number {
    const handle = this.next++
    this.waiting.set(handle, callback)
    return handle
  }
  cancelVideoFrameCallback(handle: number): void {
    this.cancelled.push(handle)
    this.waiting.delete(handle)
  }
  /** The browser presents a frame: the oldest request waiting runs. */
  present(mediaTime: number): void {
    const [handle, callback] = [...this.waiting][0] ?? []
    if (handle === undefined || callback === undefined) throw new Error('no frame was asked for')
    this.waiting.delete(handle)
    callback(0, { mediaTime })
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

/** Watches `video`, collecting what is recorded; every event must pass the shared schema. */
function watch(video: FakeVideo) {
  const events: TimelineEventInput[] = []
  const stop = watchElement(video as unknown as HTMLVideoElement, (event) => {
    events.push(event)
  })
  return { events, stop }
}

/** Every recorded event as the recorder would check it. */
function refused(events: readonly TimelineEventInput[]) {
  return events.filter((event) => !timelineEventSchema.safeParse({ ...event, t: 0 }).success)
}

const ELEMENT_NAMES = [
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'seeking',
  'seeked',
  'ended',
  'emptied',
] as const

let page: Page

beforeEach(() => {
  vi.useFakeTimers()
  page = stubPage()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('watchElement (§10.4, §16)', () => {
  it('records the element’s events with its time and ready state', () => {
    const video = new FakeVideo()
    video.currentTime = 12.3456
    video.readyState = 3
    const { events } = watch(video)
    for (const name of ELEMENT_NAMES) video.dispatchEvent(new Event(name))
    expect(events).toEqual(
      ELEMENT_NAMES.map((name) => ({ type: 'element', name, at: 12.346, readyState: 3 })),
    )
    // The element's other events aren't the timeline's.
    video.dispatchEvent(new Event('timeupdate'))
    video.dispatchEvent(new Event('progress'))
    expect(events).toHaveLength(ELEMENT_NAMES.length)
    expect(refused(events)).toEqual([])
  })

  it('records the time as 0 when the element has none to give', () => {
    const video = new FakeVideo()
    video.currentTime = NaN
    const { events } = watch(video)
    video.dispatchEvent(new Event('emptied'))
    expect(events).toEqual([{ type: 'element', name: 'emptied', at: 0, readyState: 0 }])
  })

  it('records an element error with its code', () => {
    const video = new FakeVideo()
    const { events } = watch(video)
    video.error = { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }
    video.dispatchEvent(new Event('error'))
    // Without a message the code stands in, and a long one is cut to 300 characters.
    video.error = { code: 3, message: '' }
    video.dispatchEvent(new Event('error'))
    video.error = { code: 2, message: `${'x'.repeat(299)}😀\u0000` }
    video.dispatchEvent(new Event('error'))
    video.error = null
    video.dispatchEvent(new Event('error'))
    expect(events).toEqual([
      { type: 'error', from: 'element', code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' },
      { type: 'error', from: 'element', code: 3, message: 'media error 3' },
      { type: 'error', from: 'element', code: 2, message: 'x'.repeat(299) },
      { type: 'error', from: 'element', code: null, message: 'media error' },
    ])
    expect(refused(events)).toEqual([])
  })

  it('samples once a second while playing, with its buffered ranges', () => {
    const video = new FakeVideo()
    video.paused = false
    video.readyState = 4
    video.currentTime = 10.0004
    video.ranges = [
      [0, 5.123],
      [8, 14.567],
    ]
    video.frames = 240
    video.dropped = 3
    const { events } = watch(video)
    vi.advanceTimersByTime(999)
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual([
      {
        type: 'sample',
        at: 10,
        aheadS: 4.567,
        ranges: [
          [0, 5.12],
          [8, 14.57],
        ],
        readyState: 4,
        paused: false,
        frames: 240,
        dropped: 3,
      },
    ])
    // Each tick records one, whether or not anything changed.
    vi.advanceTimersByTime(2000)
    expect(events).toHaveLength(3)
    expect(refused(events)).toEqual([])
  })

  it('holds the buffered figures to the schema’s bounds', () => {
    const video = new FakeVideo()
    video.paused = false
    video.currentTime = 3
    // A range with no end is skipped; only the first 20 are kept; no range holds the time: 0 ahead.
    video.ranges = [
      [0, Infinity],
      ...Array.from({ length: 24 }, (_, i): [number, number] => [100 + i * 2, 100.5 + i * 2]),
    ]
    const { events } = watch(video)
    vi.advanceTimersByTime(1000)
    const sample = events[0]
    expect(sample).toMatchObject({ type: 'sample', aheadS: 0 })
    if (sample?.type !== 'sample') throw new Error('no sample')
    expect(sample.ranges).toHaveLength(20)
    expect(sample.ranges[0]).toEqual([100, 100.5])
    expect(refused(events)).toEqual([])
  })

  it('counts a range past the first 20 when it holds the time', () => {
    const video = new FakeVideo()
    video.paused = false
    video.currentTime = 90
    video.ranges = Array.from({ length: 30 }, (_, i): [number, number] => [i * 4, i * 4 + 3])
    video.ranges.push([88, 95.5])
    const { events } = watch(video)
    vi.advanceTimersByTime(1000)
    expect(events[0]).toMatchObject({ type: 'sample', aheadS: 5.5 })
  })

  it('gives 0 frames when the browser can’t count them', () => {
    const video = new FakeVideo()
    video.paused = false
    Object.defineProperty(video, 'getVideoPlaybackQuality', { value: undefined })
    const { events } = watch(video)
    vi.advanceTimersByTime(1000)
    expect(events[0]).toMatchObject({ type: 'sample', frames: 0, dropped: 0 })
    expect(refused(events)).toEqual([])
  })

  it('samples a paused video only when it changes, and at most every 10 s', () => {
    const video = new FakeVideo()
    video.readyState = 4
    video.currentTime = 0
    video.ranges = [[0, 5]]
    const { events } = watch(video)
    const samples = () => events.filter((event) => event.type === 'sample').length

    // The first sample has nothing before it to match.
    vi.advanceTimersByTime(1000)
    expect(samples()).toBe(1)
    expect(events[0]).toMatchObject({ type: 'sample', paused: true, aheadS: 5, readyState: 4 })

    // Nothing changed: nothing is recorded, however long it waits.
    vi.advanceTimersByTime(30_000)
    expect(samples()).toBe(1)

    // At 31 s the last sample is 30 s old, so a change records at the next tick.
    video.readyState = 3
    vi.advanceTimersByTime(1000)
    expect(samples()).toBe(2)

    // A change within 10 s of the last sample waits for the 10 s.
    video.ranges = [
      [0, 5],
      [20, 30],
    ]
    vi.advanceTimersByTime(9000)
    expect(samples()).toBe(2)
    vi.advanceTimersByTime(1000)
    expect(samples()).toBe(3)

    // Less than a second more ahead is no change, but it adds up against the last sample.
    video.ranges = [
      [0, 5.5],
      [20, 30],
    ]
    vi.advanceTimersByTime(40_000)
    expect(samples()).toBe(3)
    video.ranges = [
      [0, 6],
      [20, 30],
    ]
    vi.advanceTimersByTime(1000)
    expect(samples()).toBe(4)
    expect(refused(events)).toEqual([])
  })

  it('samples every second again once the video plays', () => {
    const video = new FakeVideo()
    const { events } = watch(video)
    vi.advanceTimersByTime(5000)
    expect(events).toHaveLength(1)
    video.paused = false
    vi.advanceTimersByTime(3000)
    expect(events).toHaveLength(4)
  })

  it('records the first picture after the start and after each seek, where the browser can say', () => {
    const video = new FrameVideo()
    video.currentTime = 0.04
    const { events } = watch(video)
    expect(video.waiting.size).toBe(1)
    video.present(0.0416)
    expect(events).toEqual([{ type: 'picture', at: 0.042, after: 'start' }])

    video.currentTime = 30
    video.dispatchEvent(new Event('seeking'))
    expect(events.at(-1)).toMatchObject({ type: 'element', name: 'seeking' })
    expect(video.waiting.size).toBe(1)
    video.present(30.0334)
    expect(events.at(-1)).toEqual({ type: 'picture', at: 30.033, after: 'seek' })
    expect(video.waiting.size).toBe(0)

    // A seek on top of a seek: only the latest frame is asked for, the earlier request cancelled.
    video.dispatchEvent(new Event('seeking'))
    const first = [...video.waiting.keys()][0]
    video.dispatchEvent(new Event('seeking'))
    expect(video.cancelled).toEqual([first])
    expect(video.waiting.size).toBe(1)
    const before = events.length
    video.present(45)
    expect(events.slice(before)).toEqual([{ type: 'picture', at: 45, after: 'seek' }])
    expect(refused(events)).toEqual([])
  })

  it('records no pictures where the browser can’t say, and throws nothing', () => {
    const video = new FakeVideo()
    const { events } = watch(video)
    expect(() => video.dispatchEvent(new Event('seeking'))).not.toThrow()
    video.dispatchEvent(new Event('seeked'))
    video.dispatchEvent(new Event('playing'))
    expect(events.map((event) => event.type)).toEqual(['element', 'element', 'element'])
  })

  it('records going offline, hiding and a connection change', () => {
    const video = new FakeVideo()
    const { events } = watch(video)

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

    expect(events).toEqual([
      { type: 'network', online: false },
      { type: 'network', online: true },
      { type: 'visibility', hidden: true },
      { type: 'visibility', hidden: false },
      {
        type: 'connection',
        connection: { effectiveType: '3g', downlinkMbps: 1.5, rttMs: 300, saveData: true },
      },
    ])
    expect(refused(events)).toEqual([])
  })

  it('watches a browser without a connection API', () => {
    page = stubPage(false)
    const video = new FakeVideo()
    const { events, stop } = watch(video)
    page.window.dispatchEvent(new Event('offline'))
    expect(events).toEqual([{ type: 'network', online: false }])
    expect(() => {
      stop()
    }).not.toThrow()
  })

  it('stops listening when stopped', () => {
    const video = new FrameVideo()
    const { events, stop } = watch(video)
    const connection = page.navigator.connection
    if (connection === undefined) throw new Error('no connection')
    expect(video.listening).toBeGreaterThan(0)
    expect(page.window.listening).toBeGreaterThan(0)
    expect(page.document.listening).toBeGreaterThan(0)
    expect(connection.listening).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(1)
    // The start's frame is still waiting.
    const [pending] = [...video.waiting.keys()]

    stop()
    expect(video.listening).toBe(0)
    expect(page.window.listening).toBe(0)
    expect(page.document.listening).toBe(0)
    expect(connection.listening).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(video.cancelled).toEqual([pending])

    video.paused = false
    for (const name of ELEMENT_NAMES) video.dispatchEvent(new Event(name))
    video.dispatchEvent(new Event('error'))
    page.window.dispatchEvent(new Event('offline'))
    page.document.dispatchEvent(new Event('visibilitychange'))
    connection.dispatchEvent(new Event('change'))
    vi.advanceTimersByTime(60_000)
    expect(events).toEqual([])
    // Stopping again changes nothing.
    expect(() => {
      stop()
    }).not.toThrow()
    expect(video.cancelled).toEqual([pending])
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
