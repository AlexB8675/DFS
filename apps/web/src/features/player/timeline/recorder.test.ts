import {
  TIMELINE_MAX_EVENTS,
  timelineEventSchema,
  type TimelineBatch,
  type TimelineEventInput,
} from '@dfs/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipText, Timeline, timelineSender, type SendResult, type TimelineSend } from './recorder'

const PLAY = '0199f3a2-7c41-7d00-8000-00000000a001'
const VERSION = '0199f3a2-7c41-7d00-8000-00000000b002'
const WALL = Date.parse('2026-10-20T12:00:00Z')

const encoder = new TextEncoder()
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length

/** A valid event of exactly `size` bytes (with `t` 0, as under fake time). */
const sized = (size: number): TimelineEventInput => {
  const empty = bytesOf({ type: 'error', from: 'page', code: null, message: '', t: 0 })
  return { type: 'error', from: 'page', code: null, message: 'x'.repeat(size - empty) }
}
/** A small valid event. */
const hide = (hidden = true): TimelineEventInput => ({ type: 'visibility', hidden })
/** A valid event of about 370 bytes, told apart by its code. */
const big = (code: number): TimelineEventInput => ({
  type: 'error',
  from: 'page',
  code,
  message: 'x'.repeat(300),
})

interface Call {
  batch: TimelineBatch
  keepalive: boolean
}

/**
 * A `send` that records its calls and answers from `script`, then from
 * `answer` (`'sent'` unless changed). With `holdFirst`, the first call stays
 * pending until `release` is called.
 */
function fakeSend(options: { script?: SendResult[]; holdFirst?: boolean } = {}) {
  const calls: Call[] = []
  const script = [...(options.script ?? [])]
  const state = { answer: 'sent' as SendResult, running: 0, mostRunning: 0 }
  let release: (() => void) | null = null
  let holding = options.holdFirst ?? false
  const send: TimelineSend = async (batch, keepalive) => {
    calls.push({ batch, keepalive })
    state.running += 1
    state.mostRunning = Math.max(state.mostRunning, state.running)
    try {
      if (holding) {
        holding = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return script.shift() ?? state.answer
    } finally {
      state.running -= 1
    }
  }
  return {
    send,
    calls,
    state,
    release: () => {
      release?.()
    },
  }
}

function newTimeline(send: TimelineSend, versioned = true) {
  const timeline = new Timeline({
    playId: PLAY,
    send,
    now: () => Date.now(),
    wallNow: () => Date.now(),
  })
  if (versioned) timeline.setVersion(VERSION)
  return timeline
}

const eventsOf = (calls: readonly Call[]) => calls.flatMap((call) => call.batch.events)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(WALL)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Timeline', () => {
  it('sends before the version is known, naming none, then names it', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send, false)
    timeline.record(hide(true))
    timeline.record(hide(false))
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keepalive).toBe(false)
    expect(calls[0]?.batch).toMatchObject({
      playId: PLAY,
      versionId: null,
      seq: 0,
      startedAt: WALL,
      sentAt: 5000,
    })
    expect(calls[0]?.batch.events).toEqual([
      { type: 'visibility', hidden: true, t: 0 },
      { type: 'visibility', hidden: false, t: 0 },
    ])

    timeline.setVersion(VERSION)
    timeline.record({ type: 'closed' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.batch).toMatchObject({ versionId: VERSION, seq: 1, sentAt: 10_000 })
  })

  it('sends a play that ends before its version is known', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send, false)
    timeline.record(hide(true))
    timeline.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keepalive).toBe(true)
    expect(calls[0]?.batch.versionId).toBeNull()
    expect(calls[0]?.batch.events.map((event) => event.type)).toEqual(['visibility', 'closed'])
  })

  it('stamps each event with the milliseconds since the play began', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    await vi.advanceTimersByTimeAsync(1234)
    timeline.record(hide())
    await vi.advanceTimersByTimeAsync(3766)
    expect(calls[0]?.batch.events).toEqual([{ type: 'visibility', hidden: true, t: 1234 }])
    expect(calls[0]?.batch.sentAt).toBe(5000)
  })

  it('sends a batch every five seconds, numbered from 0', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    timeline.record(hide(true))
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((call) => call.batch.seq)).toEqual([0])

    timeline.record(hide(false))
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.map((call) => call.batch.seq)).toEqual([0, 1])
    expect(calls[1]?.batch.sentAt).toBe(10_000)

    // Nothing kept, nothing sent.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toHaveLength(2)
  })

  it('sends at once past 16 KiB', () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    const each = bytesOf({ ...big(0), t: 0 })
    const needed = Math.ceil((16 * 1024) / each)
    for (let i = 0; i < needed - 1; i++) timeline.record(big(i))
    expect(calls).toHaveLength(0)
    timeline.record(big(needed - 1))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.batch.events).toHaveLength(needed)
  })

  it('splits what it holds into batches of 32 KiB and 2000 events at most', async () => {
    const { send, calls, state } = fakeSend()
    const timeline = newTimeline(send, false)
    const total = 3000
    for (let i = 0; i < total; i++) {
      timeline.record({ type: 'request', id: i, from: 0, to: null })
    }
    timeline.setVersion(VERSION)
    await timeline.flush()

    expect(calls.map((call) => call.batch.seq)).toEqual(calls.map((_, index) => index))
    expect(calls.length).toBeGreaterThan(1)
    for (const { batch } of calls) {
      expect(batch.events.length).toBeLessThanOrEqual(TIMELINE_MAX_EVENTS)
      expect(batch.events.reduce((sum, event) => sum + bytesOf(event), 0)).toBeLessThanOrEqual(
        32 * 1024,
      )
    }
    expect(eventsOf(calls).map((event) => (event.type === 'request' ? event.id : -1))).toEqual(
      Array.from({ length: total }, (_, index) => index),
    )
    // One ordinary send at a time.
    expect(state.mostRunning).toBe(1)
  })

  it('sends a failed batch again with the same seq', async () => {
    const { send, calls } = fakeSend({ script: ['retry'] })
    const timeline = newTimeline(send)
    timeline.record(hide(true))
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.map((call) => call.batch.seq)).toEqual([0])

    timeline.record(hide(false))
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.map((call) => call.batch.seq)).toEqual([0, 0, 1])
    // The same events under the same number, stamped again as sent.
    expect(calls[1]?.batch.events).toEqual(calls[0]?.batch.events)
    expect(calls[0]?.batch.sentAt).toBe(5000)
    expect(calls[1]?.batch.sentAt).toBe(10_000)
    expect(calls[2]?.batch.events).toEqual([{ type: 'visibility', hidden: false, t: 5000 }])
  })

  it('does not send a failed batch again at every event past 16 KiB', async () => {
    const { send, calls, state } = fakeSend()
    state.answer = 'retry'
    const timeline = newTimeline(send)
    for (let i = 0; i < 45; i++) timeline.record(big(i))
    await timeline.flush()
    expect(calls).toHaveLength(1)

    // More than 16 KiB is kept again, but the failed batch waits for the timer.
    for (let i = 45; i < 200; i++) timeline.record(big(i))
    await timeline.flush()
    expect(calls).toHaveLength(2)
    for (let i = 200; i < 260; i++) timeline.record(big(i))
    expect(calls).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(3)
    expect(calls[2]?.batch.seq).toBe(0)
  })

  it('stops for good on a refusal', async () => {
    const { send, calls } = fakeSend({ script: ['refused'] })
    const timeline = newTimeline(send)
    timeline.record(hide())
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(1)

    timeline.record(hide(false))
    await timeline.flush()
    await timeline.flush({ keepalive: true })
    await vi.advanceTimersByTimeAsync(10_000)
    timeline.close()
    expect(calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes on hide without closing', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    timeline.record(hide(true))
    await timeline.flush({ keepalive: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keepalive).toBe(true)
    expect(calls[0]?.batch.seq).toBe(0)

    timeline.record(hide(false))
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.keepalive).toBe(false)
    expect(calls[1]?.batch.seq).toBe(1)
  })

  it('keeps a keepalive batch under 24 KiB, older events sent apart first', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send, false)
    const total = 160
    for (let i = 0; i < total; i++) timeline.record(big(i))
    timeline.setVersion(VERSION)
    await timeline.flush({ keepalive: true })

    const last = calls[calls.length - 1]
    expect(last?.keepalive).toBe(true)
    expect(last?.batch.events.reduce((sum, event) => sum + bytesOf(event), 0)).toBeLessThanOrEqual(
      24 * 1024,
    )
    // Everything older went first, as ordinary batches with the lower numbers.
    const older = calls.slice(0, -1)
    expect(older.length).toBeGreaterThan(0)
    for (const call of older) {
      expect(call.keepalive).toBe(false)
      expect(call.batch.events.reduce((sum, event) => sum + bytesOf(event), 0)).toBeLessThanOrEqual(
        32 * 1024,
      )
    }
    expect(calls.map((call) => call.batch.seq)).toEqual(calls.map((_, index) => index))
    // The keepalive batch holds the newest events, and none is lost or repeated.
    expect(eventsOf(calls).map((event) => (event.type === 'error' ? event.code : -1))).toEqual(
      Array.from({ length: total }, (_, index) => index),
    )
  })

  it('sends pending batches first, as ordinary ones, on a keepalive flush', async () => {
    const { send, calls } = fakeSend({ script: ['retry'] })
    const timeline = newTimeline(send)
    timeline.record(hide(true))
    await vi.advanceTimersByTimeAsync(5000)
    timeline.record(hide(false))
    await timeline.flush({ keepalive: true })

    expect(calls.map((call) => [call.batch.seq, call.keepalive])).toEqual([
      [0, false],
      [0, false],
      [1, true],
    ])
  })

  it('sends a keepalive batch at once, even with a send in flight', async () => {
    const { send, calls, release } = fakeSend({ holdFirst: true })
    const timeline = newTimeline(send)
    timeline.record(hide(true))
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(1)

    timeline.record(hide(false))
    // An ordinary flush leaves the send in flight alone.
    const ordinary = timeline.flush()
    expect(calls).toHaveLength(1)

    const leaving = timeline.flush({ keepalive: true })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.keepalive).toBe(true)
    expect(calls[1]?.batch.seq).toBe(1)
    expect(calls[1]?.batch.events).toEqual([{ type: 'visibility', hidden: false, t: 5000 }])

    release()
    await Promise.all([ordinary, leaving])
    expect(calls).toHaveLength(2)
  })

  it('puts a send that fails in flight back for the next flush, in seq order', async () => {
    const { send, calls, release } = fakeSend({ holdFirst: true, script: ['retry', 'retry'] })
    const timeline = newTimeline(send)
    timeline.record(hide(true))
    await vi.advanceTimersByTimeAsync(5000)
    timeline.record(hide(false))
    // The keepalive batch (seq 1) fails first, then the one in flight (seq 0).
    await timeline.flush({ keepalive: true })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map((call) => call.batch.seq)).toEqual([0, 1])

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.map((call) => call.batch.seq)).toEqual([0, 1, 0, 1])
  })

  it('drops and counts an event the schema refuses', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    timeline.record({ type: 'error', from: 'page', code: null, message: 'y'.repeat(301) })
    timeline.record(hide())
    await vi.advanceTimersByTimeAsync(5000)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.batch.events).toEqual([
      { type: 'dropped', t: 5000, events: 0, invalid: 1 },
      { type: 'visibility', hidden: true, t: 0 },
    ])

    // The counts go back to nothing once sent.
    timeline.record(hide(false))
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls[1]?.batch.events).toEqual([{ type: 'visibility', hidden: false, t: 5000 }])
  })

  it('drops text the database can’t hold, counting each event', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    timeline.record({
      type: 'error',
      from: 'page',
      code: null,
      message: 'a' + String.fromCharCode(0) + 'b',
    })
    timeline.record({
      type: 'error',
      from: 'page',
      code: null,
      message: 'a' + String.fromCharCode(0xd800) + 'b',
    })
    timeline.record(hide())
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls[0]?.batch.events).toEqual([
      { type: 'dropped', t: 5000, events: 0, invalid: 2 },
      { type: 'visibility', hidden: true, t: 0 },
    ])
  })

  it('sends the count of a refused event even when nothing else was kept', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    timeline.record({ type: 'error', from: 'page', code: null, message: 'y'.repeat(301) })
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls[0]?.batch.events).toEqual([{ type: 'dropped', t: 5000, events: 0, invalid: 1 }])
  })

  it('drops the oldest past 256 KiB and says how many', async () => {
    // The first send stays in flight, so what comes after is kept, past the cap.
    const { send, calls, release } = fakeSend({ holdFirst: true })
    const timeline = newTimeline(send)
    const total = 900
    for (let i = 0; i < total; i++) timeline.record(big(i))
    expect(calls).toHaveLength(1)
    const inFlight = calls[0]?.batch.events.length ?? 0
    release()
    await timeline.flush()

    // The next batch begins with the count.
    const events = eventsOf(calls.slice(1))
    const first = events[0]
    expect(first?.type).toBe('dropped')
    const lost = first?.type === 'dropped' ? first.events : 0
    expect(lost).toBeGreaterThan(0)
    expect(first).toMatchObject({ invalid: 0 })
    const kept = events.slice(1)
    // What stayed is the newest, in order, and fits the cap; the rest is counted.
    expect(inFlight + kept.length + lost).toBe(total)
    expect(kept.map((event) => (event.type === 'error' ? event.code : -1))).toEqual(
      Array.from({ length: kept.length }, (_, index) => inFlight + lost + index),
    )
    expect(kept.reduce((sum, event) => sum + bytesOf(event), 0)).toBeLessThanOrEqual(256 * 1024)
  })

  it('counts batches that failed to send in the 256 KiB too', async () => {
    const { send, calls, state } = fakeSend()
    state.answer = 'retry'
    const timeline = newTimeline(send)
    const total = 800
    for (let round = 0; round < total / 40; round++) {
      for (let i = 0; i < 40; i++) timeline.record(big(round * 40 + i))
      await timeline.flush()
    }
    state.answer = 'sent'
    const before = calls.length
    await timeline.flush()

    const events = eventsOf(calls.slice(before))
    const first = events[0]
    expect(first?.type).toBe('dropped')
    const lost = first?.type === 'dropped' ? first.events : 0
    expect(lost).toBeGreaterThan(0)
    expect(events.length - 1 + lost).toBe(total)
    expect(events.slice(1).map((event) => (event.type === 'error' ? event.code : -1))).toEqual(
      Array.from({ length: total - lost }, (_, index) => lost + index),
    )
  })

  it('puts the lost count in the keepalive batch, the one that outlives the page', async () => {
    // The first ordinary send stays in flight, so what follows is kept and trimmed.
    const { send, calls, release } = fakeSend({ holdFirst: true })
    const timeline = newTimeline(send)
    for (let i = 0; i < 50; i++) timeline.record(big(i))
    expect(calls).toHaveLength(1)
    timeline.record({ type: 'error', from: 'page', code: null, message: 'y'.repeat(301) })
    timeline.record({ type: 'error', from: 'page', code: null, message: 'y'.repeat(301) })
    for (let i = 50; i < 950; i++) timeline.record(big(i))

    await timeline.flush({ keepalive: true })
    const last = calls[calls.length - 1]
    expect(last?.keepalive).toBe(true)
    const first = last?.batch.events[0]
    expect(first).toMatchObject({ type: 'dropped', invalid: 2 })
    const lost = first?.type === 'dropped' ? first.events : 0
    expect(lost).toBeGreaterThan(0)
    // Within what keepalive may carry, the count included.
    expect(last?.batch.events.reduce((sum, event) => sum + bytesOf(event), 0)).toBeLessThanOrEqual(
      24 * 1024,
    )
    // The ordinary batches, older, say nothing of it: they may be cancelled with the page.
    const ordinary = calls.slice(0, -1).flatMap((call) => call.batch.events)
    expect(ordinary.some((event) => event.type === 'dropped')).toBe(false)
    // Every event is sent or counted, once.
    const sent = eventsOf(calls).filter((event) => event.type === 'error').length
    expect(sent + lost).toBe(950)
    release()
  })

  it('counts the lost count in the keepalive batch’s 24 KiB', async () => {
    const { send, calls, release } = fakeSend({ holdFirst: true })
    const timeline = newTimeline(send)
    // Events of 256 bytes: 96 fill 24 KiB exactly, so the count must make room.
    const filler = () => sized(256)
    for (let i = 0; i < 64; i++) timeline.record(filler())
    expect(calls).toHaveLength(1)
    timeline.record({ type: 'error', from: 'page', code: null, message: 'y'.repeat(301) })
    for (let i = 0; i < 200; i++) timeline.record(filler())

    await timeline.flush({ keepalive: true })
    const last = calls[calls.length - 1]
    expect(last?.keepalive).toBe(true)
    expect(last?.batch.events[0]).toMatchObject({ type: 'dropped', events: 0, invalid: 1 })
    expect(last?.batch.events.reduce((sum, event) => sum + bytesOf(event), 0)).toBeLessThanOrEqual(
      24 * 1024,
    )
    expect(last?.batch.events).toHaveLength(96)
    release()
  })

  it('puts the count in the keepalive batch when only the count is left', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    timeline.record({ type: 'error', from: 'page', code: null, message: 'y'.repeat(301) })
    await timeline.flush({ keepalive: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keepalive).toBe(true)
    expect(calls[0]?.batch.events).toEqual([{ type: 'dropped', t: 0, events: 0, invalid: 1 }])
  })

  it('passes on the counts of a dropped event it trims', async () => {
    const { send, calls, release } = fakeSend({ holdFirst: true })
    const timeline = newTimeline(send)
    for (let i = 0; i < 50; i++) timeline.record(big(i))
    expect(calls).toHaveLength(1)
    // A `dropped` event at the head of what is kept, then enough to trim it.
    timeline.record({ type: 'dropped', events: 5, invalid: 2 })
    for (let i = 50; i < 850; i++) timeline.record(big(i))

    await timeline.flush({ keepalive: true })
    const last = calls[calls.length - 1]
    const first = last?.batch.events[0]
    expect(first?.type).toBe('dropped')
    const sent = eventsOf(calls).filter((event) => event.type === 'error').length
    const trimmed = 850 - sent
    expect(trimmed).toBeGreaterThan(0)
    expect(first).toMatchObject({ type: 'dropped', events: 5 + trimmed, invalid: 2 })
    release()
  })

  it('records closed, flushes and ignores what comes after', async () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    timeline.record(hide())
    await vi.advanceTimersByTimeAsync(1000)
    timeline.close()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keepalive).toBe(true)
    expect(calls[0]?.batch.events).toEqual([
      { type: 'visibility', hidden: true, t: 0 },
      { type: 'closed', t: 1000 },
    ])
    expect(vi.getTimerCount()).toBe(0)

    timeline.record(hide(false))
    timeline.close()
    await vi.advanceTimersByTimeAsync(10_000)
    await timeline.flush()
    expect(calls).toHaveLength(1)
  })

  it('sends the closing batch with keepalive even when closed tips the 16 KiB', () => {
    const { send, calls } = fakeSend()
    const timeline = newTimeline(send)
    // Just under 16 KiB, so that the `closed` event close() adds is what takes it over.
    const closedBytes = bytesOf({ type: 'closed', t: 0 })
    const justUnder = Math.ceil((16 * 1024) / closedBytes) - 1
    for (let i = 0; i < justUnder; i++) timeline.record({ type: 'closed' })
    expect(calls).toHaveLength(0)

    timeline.close()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keepalive).toBe(true)
    expect(calls[0]?.batch.events).toHaveLength(justUnder + 1)
  })

  it('keeps its play ID', () => {
    expect(newTimeline(fakeSend().send).playId).toBe(PLAY)
  })

  it('treats a send that throws as a failed one', async () => {
    let calls = 0
    const timeline = newTimeline(() => {
      calls += 1
      return Promise.reject(new Error('boom'))
    })
    timeline.record(hide())
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
  })
})

describe('timelineSender', () => {
  const batch: TimelineBatch = {
    playId: PLAY,
    versionId: VERSION,
    seq: 3,
    startedAt: WALL,
    sentAt: 5000,
    events: [{ type: 'closed', t: 4000 }],
  }

  it.each([
    [204, 'sent'],
    [200, 'sent'],
    [500, 'retry'],
    [503, 'retry'],
    [429, 'retry'],
    [408, 'retry'],
    [404, 'refused'],
    [410, 'refused'],
    [413, 'refused'],
    [409, 'refused'],
  ] as const)('maps an answer of %i to %s', async (status, expected) => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status })))
    expect(await timelineSender('/files/abc')(batch, false)).toBe(expected)
  })

  it('maps a network failure to retry', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    expect(await timelineSender('/files/abc')(batch, false)).toBe('retry')
  })

  it('posts the batch as JSON to the timeline of its place, with keepalive as asked', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)
    await timelineSender('/links/xyz/files/abc')(batch, true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/links/xyz/files/abc/timeline')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(init.body as string)).toEqual(batch)
  })
})

describe('clipText', () => {
  const accepted = (message: string) =>
    timelineEventSchema.safeParse({ type: 'error', t: 0, from: 'page', code: null, message })
      .success

  it('clips text the schema takes', () => {
    const long = clipText('a'.repeat(301))
    expect(long).toHaveLength(300)
    expect(accepted(long)).toBe(true)

    // An emoji straddling position 300 is cut before it.
    const straddling = clipText('a'.repeat(299) + '😀' + 'b')
    expect(straddling).toBe('a'.repeat(299))
    expect(straddling.isWellFormed()).toBe(true)
    expect(accepted(straddling)).toBe(true)

    const nul = clipText('a\u0000b')
    expect(nul).toBe('ab')
    expect(accepted(nul)).toBe(true)

    const lone = clipText('a\ud800b\udc00c')
    expect(lone).toBe('abc')
    expect(accepted(lone)).toBe(true)

    // A whole pair stays.
    expect(clipText('a😀b')).toBe('a😀b')
  })

  it('takes a limit of its own and leaves short text alone', () => {
    expect(clipText('abcdef', 3)).toBe('abc')
    expect(clipText('abc', 20)).toBe('abc')
    expect(clipText('')).toBe('')
  })
})
