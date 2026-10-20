import type { AppendOutcome, TimelineOwner } from '@dfs/db'
import type { ServedEvent, StreamEvent } from '@dfs/shared'
import { TIMELINE_MAX_EVENTS } from '@dfs/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSources } from './reader.ts'
import {
  FLUSH_EVERY_MS,
  MAX_PENDING_EVENTS,
  SESSION_IDLE_MS,
  StreamSessions,
  type ServedResult,
  type StreamRequest,
} from './stream-sessions.ts'

interface Call {
  id: string
  owner: TimelineOwner
  batch: { seq: number; events: readonly StreamEvent[]; address: string }
}

/** A session registry on fake clocks, with a writer that records every attempt. */
function setup() {
  const clock = { now: 5000, wall: Date.UTC(2026, 9, 20, 12) }
  const calls: Call[] = []
  const behaviour: { outcome: AppendOutcome; fails: boolean; failsFor: string | null } = {
    outcome: 'stored',
    fails: false,
    failsFor: null,
  }
  const warn = vi.fn()
  const sessions = new StreamSessions({
    write: (id, owner, batch) => {
      calls.push({ id, owner, batch })
      if (behaviour.fails || id === behaviour.failsFor) {
        return Promise.reject(new Error('the database is down'))
      }
      return Promise.resolve(behaviour.outcome)
    },
    log: { warn },
    now: () => clock.now,
    wallNow: () => clock.wall,
  })
  return { sessions, clock, calls, behaviour, warn }
}

function request(over: Partial<StreamRequest> = {}): StreamRequest {
  return {
    via: 'link',
    nodeId: 'node-1',
    versionId: 'version-1',
    userId: null,
    shareId: 'share-1',
    playId: null,
    address: '203.0.113.7',
    userAgent: 'Firefox',
    from: 0,
    to: 1_000_000_000,
    status: 200,
    ...over,
  }
}

function result(over: Partial<ServedResult> = {}): ServedResult {
  return {
    bytes: 0,
    finished: true,
    failed: false,
    firstByteMs: 10,
    totalMs: 100,
    sources: readSources(),
    clientMs: 0,
    ...over,
  }
}

/** Opens a request, lets `ms` pass while it sends `bytes`, and closes it. */
function serve(
  harness: ReturnType<typeof setup>,
  over: Partial<StreamRequest> = {},
  bytes = 1000,
  ms = 10,
): string {
  const sent = { bytes: 0 }
  const { sessionId, close } = harness.sessions.open(request(over), sent)
  sent.bytes = bytes
  harness.clock.now += ms
  close(result({ bytes }))
  return sessionId
}

function served(call: Call | undefined): ServedEvent[] {
  return (call?.batch.events ?? []).filter((event) => event.type === 'served')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('stream sessions (§6.2, §16)', () => {
  it('groups a play’s requests by its play ID, whatever their address', () => {
    const harness = setup()
    const first = serve(harness, { playId: 'play-1', address: '203.0.113.7', userAgent: 'Firefox' })
    const second = serve(harness, { playId: 'play-1', address: '198.51.100.9', userAgent: null })
    const other = serve(harness, { playId: 'play-2' })
    expect(second).toBe(first)
    expect(other).not.toBe(first)
  })

  it('keeps two readers apart even with the same play ID', async () => {
    const harness = setup()
    const drive = { playId: 'play-1', via: 'drive', userId: 'user-1', shareId: null } as const
    const link = { playId: 'play-1', via: 'link', userId: null, shareId: 'share-1' } as const
    const one = serve(harness, drive)
    expect(serve(harness, drive)).toBe(one)
    // Another user presenting the same play ID is another session, not joined to the first's.
    const user = serve(harness, { ...drive, userId: 'user-2' })
    expect(user).not.toBe(one)
    // So is a link's viewer, and a viewer of another link.
    const viewer = serve(harness, link)
    expect(viewer).not.toBe(one)
    expect(viewer).not.toBe(user)
    expect(serve(harness, link)).toBe(viewer)
    expect(serve(harness, { ...link, shareId: 'share-2' })).not.toBe(viewer)
    expect(serve(harness, { ...link, via: 'stream' })).not.toBe(viewer)

    // Each is written under its own timeline, whose owner is its own reader.
    await harness.sessions.flush()
    const owners = new Map(harness.calls.map((call) => [call.id, call.owner]))
    expect(owners.get(user)).toMatchObject({ via: 'drive', userId: 'user-2', playId: 'play-1' })
    expect(owners.get(viewer)).toMatchObject({ via: 'link', shareId: 'share-1', playId: 'play-1' })
  })

  it('keeps two files apart even with the same play ID and reader', () => {
    const harness = setup()
    const first = serve(harness, { playId: 'play-1', nodeId: 'node-1' })
    expect(serve(harness, { playId: 'play-1', nodeId: 'node-1', from: 1000 })).toBe(first)
    // A play is one file's view: a page that reused the ID for another file doesn't merge them.
    expect(serve(harness, { playId: 'play-1', nodeId: 'node-2' })).not.toBe(first)
  })

  it('groups another player’s requests by link, version, address and user agent', async () => {
    const harness = setup()
    const first = serve(harness)
    expect(serve(harness)).toBe(first)
    expect(serve(harness, { userAgent: 'VLC' })).not.toBe(first)
    expect(serve(harness, { address: '198.51.100.9' })).not.toBe(first)
    expect(serve(harness, { versionId: 'version-2' })).not.toBe(first)
    expect(serve(harness, { shareId: 'share-2' })).not.toBe(first)
    // A signed-in user's key is the user, so the link they happen to read through doesn't matter.
    const user = serve(harness, { via: 'drive', userId: 'user-1', shareId: null })
    expect(serve(harness, { via: 'drive', userId: 'user-1', shareId: null })).toBe(user)
    expect(serve(harness, { via: 'drive', userId: 'user-2', shareId: null })).not.toBe(user)

    await harness.sessions.flush()
    const owners = new Map(harness.calls.map((call) => [call.id, call.owner]))
    expect(owners.get(first)).toEqual({
      kind: 'stream',
      via: 'link',
      nodeId: 'node-1',
      versionId: 'version-1',
      userId: null,
      shareId: 'share-1',
      playId: null,
      address: '203.0.113.7',
      userAgent: 'Firefox',
      clientStartedAt: null,
      startedAt: new Date(harness.clock.wall),
    })
  })

  it('begins a new session after two idle minutes', async () => {
    const harness = setup()
    const first = serve(harness)
    // Exactly the limit still joins: the session is at most that idle.
    harness.clock.now += SESSION_IDLE_MS
    expect(serve(harness)).toBe(first)

    harness.clock.now += SESSION_IDLE_MS + 1
    harness.clock.wall += 999_000
    const later = serve(harness)
    expect(later).not.toBe(first)

    // The earlier session's events are still written, apart from the new one's.
    await harness.sessions.flush()
    const byId = new Map(harness.calls.map((call) => [call.id, call]))
    expect(served(byId.get(first))).toHaveLength(2)
    expect(served(byId.get(later))).toHaveLength(1)
    expect(byId.get(later)?.owner.startedAt).toEqual(new Date(harness.clock.wall))
    expect(served(byId.get(later))[0]?.t).toBe(0)
  })

  it('keeps a session whose request is still running, however long it takes', () => {
    const harness = setup()
    const sent = { bytes: 0 }
    const long = harness.sessions.open(request(), sent)
    harness.clock.now += 10 * SESSION_IDLE_MS
    expect(harness.sessions.open(request({ from: 50 }), { bytes: 0 }).sessionId).toBe(
      long.sessionId,
    )
  })

  it('flags seeks and gaps against what was sent, with reads open-ended and overlapping', async () => {
    const harness = setup()
    const { clock, sessions } = harness

    // `bytes=0-` runs to the file's end, but is closed after 65 536 bytes: the first is never a seek.
    const sentA = { bytes: 0 }
    const a = sessions.open(request({ from: 0 }), sentA)
    sentA.bytes = 65_536
    clock.now += 100
    a.close(result({ bytes: 65_536 }))

    // `bytes=65536-` carries on from where A stopped, after four idle seconds.
    clock.now += 4000
    const sentB = { bytes: 0 }
    const b = sessions.open(request({ from: 65_536 }), sentB)
    sentB.bytes = 1000

    // While B runs, a read from far on is a seek, and there is no gap, as B is running.
    clock.now += 50
    const sentC = { bytes: 0 }
    const c = sessions.open(request({ from: 5_000_000 }), sentC)
    sentC.bytes = 300_000
    sentB.bytes = 2000
    clock.now += 20
    b.close(result({ bytes: 2000 }))
    c.close(result({ bytes: 300_000 }))

    // Both are closed: a read from where C stopped carries on, ten milliseconds after.
    clock.now += 10
    const d = sessions.open(request({ from: 5_300_000 }), { bytes: 0 })
    d.close(result({ bytes: 100 }))

    // A read from where B was still running, when C opened, is a seek: it had got to 66 536 only.
    clock.now += 7
    const e = sessions.open(request({ from: 66_536 }), { bytes: 0 })
    e.close(result({ bytes: 100 }))

    await sessions.flush()
    const events = served(harness.calls[0])
    const at = (from: number) => events.find((event) => event.from === from)
    expect(at(0)).toMatchObject({ seek: false, gapMs: null, to: 1_000_000_000, bytes: 65_536 })
    expect(at(65_536)).toMatchObject({ seek: false, gapMs: 4000 })
    expect(at(5_000_000)).toMatchObject({ seek: true, gapMs: null })
    expect(at(5_300_000)).toMatchObject({ seek: false, gapMs: 10 })
    expect(at(66_536)).toMatchObject({ seek: true, gapMs: 7 })
  })

  it('counts a read from where a running one has got to as no seek', async () => {
    const harness = setup()
    serve(harness, { from: 0 }, 1000)
    const sent = { bytes: 0 }
    const running = harness.sessions.open(request({ from: 7000 }), sent)
    sent.bytes = 500
    // Where the running read has got to, as it opens: a second connection of the same player.
    harness.sessions.open(request({ from: 7500 }), { bytes: 0 }).close(result())
    // Behind it, or ahead, is somewhere else.
    harness.sessions.open(request({ from: 7400 }), { bytes: 0 }).close(result())
    sent.bytes = 900
    harness.sessions.open(request({ from: 7500 }), { bytes: 0 }).close(result())
    running.close(result({ bytes: 900 }))

    await harness.sessions.flush()
    expect(served(harness.calls[0]).map((event) => [event.from, event.seek])).toEqual([
      [0, false],
      [7500, false],
      [7400, true],
      // The 7500 stopped at is remembered, so a read from there again is not a seek either.
      [7500, false],
      [7000, true],
    ])
  })

  it('writes a session’s events in numbered batches, and nothing twice', async () => {
    const harness = setup()
    const { clock, calls, sessions } = harness
    const id = serve(harness, { playId: 'play-1' }, 1000, 0)
    clock.now += 40
    serve(harness, { playId: 'play-1', address: '198.51.100.9', from: 1000, status: 206 }, 2000, 5)
    const total = 2500
    for (let i = 2; i < total; i++) {
      clock.now += 1
      serve(harness, { playId: 'play-1', from: i * 1000 }, 1000, 0)
    }

    await sessions.flush()
    expect(calls.map((call) => [call.id, call.batch.seq, call.batch.events.length])).toEqual([
      [id, 0, TIMELINE_MAX_EVENTS],
      [id, 1, total - TIMELINE_MAX_EVENTS],
    ])
    expect(calls.every((call) => call.batch.address === '203.0.113.7')).toBe(true)
    const first = served(calls[0])
    expect(first[0]).toMatchObject({
      type: 'served',
      t: 0,
      address: '203.0.113.7',
      from: 0,
      to: 1_000_000_000,
      status: 200,
      bytes: 1000,
      finished: true,
      failed: false,
      firstByteMs: 10,
      totalMs: 100,
      clientMs: 0,
      seek: false,
      gapMs: null,
    })
    expect(first[0]?.sources).toEqual(readSources())
    expect(first[1]).toMatchObject({
      t: 40,
      address: '198.51.100.9',
      status: 206,
      gapMs: 40,
      seek: false,
    })

    // Nothing is written twice.
    await sessions.flush()
    expect(calls).toHaveLength(2)

    serve(harness, { playId: 'play-1', address: '192.0.2.44', from: 9_999_999 })
    await sessions.flush()
    expect(calls).toHaveLength(3)
    expect(calls[2]?.batch).toMatchObject({ seq: 2, address: '192.0.2.44' })
    expect(calls[2]?.batch.events).toHaveLength(1)
  })

  it('rounds every time it keeps to whole milliseconds', async () => {
    const harness = setup()
    harness.clock.now = 1000.4
    const first = harness.sessions.open(request(), { bytes: 0 })
    first.close(result({ firstByteMs: null, totalMs: 0.4, clientMs: 0 }))
    harness.clock.now = 1007.6
    const sources = readSources()
    sources.cache = { bytes: 4096, waitMs: 12.5 }
    sources.discord = { bytes: 100, waitMs: 80.49 }
    const second = harness.sessions.open(request(), { bytes: 0 })
    second.close(
      result({ sources, bytes: 4196, firstByteMs: 12.5, totalMs: 92.9, clientMs: 33.49 }),
    )

    await harness.sessions.flush()
    const events = served(harness.calls[0])
    // A first byte that never came stays missing, and isn't taken for 0.
    expect(events[0]).toMatchObject({ firstByteMs: null, totalMs: 0, clientMs: 0 })
    expect(events[1]).toMatchObject({ t: 7, firstByteMs: 13, totalMs: 93, clientMs: 33 })
    expect(events[1]?.sources).toEqual({
      staging: { bytes: 0, waitMs: 0 },
      cache: { bytes: 4096, waitMs: 13 },
      discord: { bytes: 100, waitMs: 80 },
    })
    // The result's own object is not changed, as the request goes on using it.
    expect(sources.cache.waitMs).toBe(12.5)
  })

  it('notes where each read came from, as a phone changes network mid-play', async () => {
    const harness = setup()
    serve(harness, { playId: 'play-1', address: '203.0.113.7', from: 0 })
    serve(harness, { playId: 'play-1', address: '198.51.100.9', from: 1000 })
    serve(harness, { playId: 'play-1', address: '198.51.100.9', from: 2000 })
    await harness.sessions.flush()
    expect(harness.calls).toHaveLength(1)
    expect(served(harness.calls[0]).map((event) => [event.from, event.address])).toEqual([
      [0, '203.0.113.7'],
      [1000, '198.51.100.9'],
      [2000, '198.51.100.9'],
    ])
    // The batch goes with the session's latest address, the timeline keeping its first.
    expect(harness.calls[0]?.batch.address).toBe('198.51.100.9')
    expect(harness.calls[0]?.owner.address).toBe('203.0.113.7')

    // A read that closes after another opened from elsewhere keeps its own address.
    const slow = harness.sessions.open(
      request({ playId: 'play-1', address: '198.51.100.9', from: 3000 }),
      { bytes: 0 },
    )
    harness.sessions
      .open(request({ playId: 'play-1', address: '192.0.2.44', from: 9000 }), { bytes: 0 })
      .close(result())
    slow.close(result())
    await harness.sessions.flush()
    expect(served(harness.calls[1]).map((event) => [event.from, event.address])).toEqual([
      [9000, '192.0.2.44'],
      [3000, '198.51.100.9'],
    ])
    expect(harness.calls[1]?.batch.address).toBe('192.0.2.44')
  })

  it('takes a request that closes twice once', async () => {
    const harness = setup()
    const { close } = harness.sessions.open(request(), { bytes: 0 })
    close(result({ bytes: 10 }))
    close(result({ bytes: 20 }))
    await harness.sessions.flush()
    expect(served(harness.calls[0])).toHaveLength(1)
  })

  it('keeps events when a write fails, and sends them with the next flush', async () => {
    const harness = setup()
    const { behaviour, calls, sessions, warn } = harness
    behaviour.fails = true
    const id = serve(harness, { playId: 'play-1' })
    const other = serve(harness, { playId: 'play-2' })
    await sessions.flush()
    // The store is down: one attempt, not one for each session, and the outage said once.
    expect(calls.map((call) => call.id)).toEqual([id])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error) as unknown, sessionId: id },
      'could not save a stream session; trying again',
    )

    // Events that come meanwhile follow in a batch of their own: the one that failed is sent as it was.
    serve(harness, { playId: 'play-1', from: 1000 })
    behaviour.fails = false
    await sessions.flush()
    const retried = calls.slice(1)
    expect(
      retried.map((call) => [call.id, call.batch.seq, served(call).map((e) => e.from)]),
    ).toEqual([
      // The session that failed went to the back, so the other one is written first.
      [other, 0, [0]],
      [id, 0, [0]],
      [id, 1, [1000]],
    ])
    expect(retried[1]?.batch.events).toEqual(calls[0]?.batch.events)

    await sessions.flush()
    expect(calls).toHaveLength(4)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('doesn’t let one failing session hold back the others', async () => {
    const harness = setup()
    const { behaviour, calls, sessions, warn } = harness
    const a = serve(harness, { playId: 'play-a' })
    const b = serve(harness, { playId: 'play-b' })
    behaviour.failsFor = a

    // The run ends at A, as the store may be down, but A goes to the back of the order.
    await sessions.flush()
    expect(calls.map((call) => call.id)).toEqual([a])
    // The next flush begins with B, which is written, and then tries A again.
    await sessions.flush()
    expect(calls.map((call) => call.id)).toEqual([a, b, a])
    expect(served(calls[1])).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(2)

    // And so on: B's later events are not held back by A's failures either.
    serve(harness, { playId: 'play-b', from: 1000 })
    await sessions.flush()
    expect(calls.map((call) => [call.id, call.batch.seq])).toEqual([
      [a, 0],
      [b, 0],
      [a, 0],
      [b, 1],
      [a, 0],
    ])

    // A recovers: what it kept is written.
    behaviour.failsFor = null
    await sessions.flush()
    expect(calls.at(-1)?.id).toBe(a)
    expect(served(calls.at(-1))).toHaveLength(1)
  })

  it.each(['full', 'not_yours'] as const)(
    'stops collecting for a session the store refuses (%s)',
    async (outcome) => {
      const harness = setup()
      const { behaviour, calls, sessions, warn } = harness
      behaviour.outcome = outcome
      const id = serve(harness, { playId: 'play-1' })
      await sessions.flush()
      expect(calls).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        { sessionId: id, outcome },
        'stream session no longer logged',
      )

      // The session still has its ID, and its requests go on, but nothing is written.
      expect(serve(harness, { playId: 'play-1', from: 1000 })).toBe(id)
      await sessions.flush()
      expect(calls).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)

      // Another session is another timeline.
      behaviour.outcome = 'stored'
      const other = serve(harness, { playId: 'play-2' })
      await sessions.flush()
      expect(calls.map((call) => call.id)).toEqual([id, other])
    },
  )

  it('takes a duplicate as written', async () => {
    const harness = setup()
    harness.behaviour.outcome = 'duplicate'
    serve(harness)
    await harness.sessions.flush()
    await harness.sessions.flush()
    expect(harness.calls).toHaveLength(1)
    expect(harness.warn).not.toHaveBeenCalled()
  })

  it('drops the oldest past the pending limit, and says how many', async () => {
    const harness = setup()
    const { clock, calls, sessions } = harness
    const extra = 3
    for (let i = 0; i < MAX_PENDING_EVENTS + extra; i++) {
      clock.now += 2
      serve(harness, { playId: 'play-1', from: i * 1000 }, 1000, 0)
    }

    await sessions.flush()
    const batches = calls.map((call) => call.batch)
    expect(batches.map((batch) => batch.seq)).toEqual([0, 1, 2])
    expect(batches.every((batch) => batch.events.length <= TIMELINE_MAX_EVENTS)).toBe(true)
    // Told once, first in the first batch, with the time of the first event kept.
    const events = batches.flatMap((batch) => batch.events)
    const firstKept = events.find((event) => event.type === 'served')
    expect(events[0]).toEqual({ type: 'dropped', t: firstKept?.t, events: extra, invalid: 0 })
    expect(events.filter((event) => event.type === 'dropped')).toHaveLength(1)
    // The newest were kept, in order.
    const kept = events.filter((event) => event.type === 'served')
    expect(kept).toHaveLength(MAX_PENDING_EVENTS)
    expect(kept[0]?.from).toBe(extra * 1000)
    expect(kept.at(-1)?.from).toBe((MAX_PENDING_EVENTS + extra - 1) * 1000)
    expect(firstKept?.t).toBe(extra * 2)
  })

  it('writes every session out when stopped', async () => {
    vi.useFakeTimers()
    const harness = setup()
    const { calls, sessions } = harness
    const running = sessions.start()
    const first = serve(harness, { playId: 'play-1' })
    const second = serve(harness, { playId: 'play-2' })
    expect(calls).toHaveLength(0)

    await running.stop()
    expect(calls.map((call) => call.id).sort()).toEqual([first, second].sort())
    // Stopped for good: no timer is left to fire.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('writes on a timer while running, one flush after another', async () => {
    vi.useFakeTimers()
    const harness = setup()
    const { calls, sessions } = harness
    const running = sessions.start()
    serve(harness, { playId: 'play-1' })

    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS - 1)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)

    // Nothing new, nothing written; then what comes is written at the next tick.
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS)
    expect(calls).toHaveLength(1)
    serve(harness, { playId: 'play-1', from: 1000 })
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.batch.seq).toBe(1)

    await running.stop()
  })

  it('keeps flushing after a flush that failed', async () => {
    vi.useFakeTimers()
    const harness = setup()
    const { behaviour, calls, warn } = harness
    const running = harness.sessions.start()
    serve(harness, { playId: 'play-1' })

    // A flush that rejects, not just a write that fails: the warning for the failed write throws.
    behaviour.fails = true
    warn.mockImplementationOnce(() => {
      throw new Error('the log is broken')
    })
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS)
    expect(calls).toHaveLength(1)
    // The tick says so, instead of leaving an unhandled rejection to end the process.
    expect(warn).toHaveBeenLastCalledWith(
      { err: expect.any(Error) as unknown },
      'could not save stream sessions; trying again',
    )

    // The next tick comes, and writes what was kept.
    behaviour.fails = false
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.batch.seq).toBe(0)
    expect(served(calls[1])).toHaveLength(1)

    await expect(running.stop()).resolves.toBeUndefined()
  })
})
