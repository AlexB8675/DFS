import { describe, expect, it } from 'vitest'
import type { PrefetchOutcome, ReadableVersion } from './reader.ts'
import { type AheadFetch, BUSY_RETRY_MS, MAX_RUNS, ReadAhead, ReadAheads } from './read-ahead.ts'
import { SESSION_IDLE_MS } from './stream-sessions.ts'

const MiB = 1024 * 1024

interface Call {
  index: number
  signal: AbortSignal
  /** Settles the fetch, as the chunk's read ending would. */
  settle: (outcome: PrefetchOutcome) => void
}

/** A window on a fake clock whose fetches the test settles. */
function setup(
  options: {
    chunkCount?: number
    size?: number
    parallel?: number
    windowBytes?: number
    onFetched?: (fetch: AheadFetch) => void
  } = {},
) {
  const clock = { now: 1000 }
  const calls: Call[] = []
  const fetched: AheadFetch[] = []
  const chunkCount = options.chunkCount ?? 300
  const ahead = new ReadAhead({
    size: options.size ?? chunkCount * MiB,
    chunkSize: MiB,
    chunkCount,
    prefetch: (index, signal) =>
      new Promise<PrefetchOutcome>((resolve) => {
        calls.push({ index, signal, settle: resolve })
      }),
    onFetched:
      options.onFetched ??
      ((fetch) => {
        fetched.push(fetch)
      }),
    now: () => clock.now,
    ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
    ...(options.windowBytes === undefined ? {} : { windowBytes: options.windowBytes }),
  })
  /** Settles the call for a chunk (the latest, if it was fetched more than once) and lets the window act on it. */
  async function settle(index: number, outcome: PrefetchOutcome) {
    const call = calls.findLast((each) => each.index === index)
    if (call === undefined) throw new Error(`chunk ${index} was never fetched`)
    call.settle(outcome)
    await Promise.resolve()
    await Promise.resolve()
  }
  /** The chunks fetched, in the order they were started. */
  const started = () => calls.map((call) => call.index)
  return { ahead, clock, calls, fetched, settle, started }
}

describe('ReadAhead', () => {
  it('reads nothing ahead until a run has sent 2 MiB', () => {
    const { ahead, calls } = setup()
    ahead.reached(0, 2 * MiB - 1)
    expect(calls).toHaveLength(0)
    ahead.reached(0, 2 * MiB)
    expect(ahead.fetching).toEqual([2, 3])
  })

  it('reads ahead from the chunk after the last byte sent, at a chunk boundary too', () => {
    // The last byte a run sent is the one before its reach: a run that stops
    // exactly where a chunk ends has the chunk that begins there next.
    const boundary = setup()
    boundary.ahead.reached(0, 3 * MiB)
    expect(boundary.ahead.fetching).toEqual([3, 4])

    const inside = setup()
    inside.ahead.reached(0, 3 * MiB + 1)
    expect(inside.ahead.fetching).toEqual([4, 5])

    const before = setup()
    before.ahead.reached(0, 3 * MiB - 1)
    expect(before.ahead.fetching).toEqual([3, 4])

    // The last chunk has nothing after it; the one before it has that.
    const end = setup({ chunkCount: 4, parallel: Infinity })
    end.ahead.reached(0, 4 * MiB)
    expect(end.started()).toEqual([])
    const beforeEnd = setup({ chunkCount: 4, parallel: Infinity })
    beforeEnd.ahead.reached(0, 3 * MiB)
    expect(beforeEnd.started()).toEqual([3])
  })

  it('reads ahead at most four times what the run has sent, up to 128 MiB, never past the last chunk', () => {
    const first = setup({ parallel: Infinity })
    first.ahead.reached(0, 2 * MiB)
    expect(first.ahead.fetching).toEqual([2, 3, 4, 5, 6, 7, 8, 9])

    // 2 to 9 are under way still; the window now reaches from 64 to 191.
    const before = first.calls.length
    first.ahead.reached(0, 64 * MiB)
    const next = first.calls.slice(before).map((call) => call.index)
    expect(next).toHaveLength(191 - 64 + 1)
    expect(next[0]).toBe(64)
    expect(next.at(-1)).toBe(191)

    const short = setup({ chunkCount: 70, parallel: Infinity })
    short.ahead.reached(0, 64 * MiB)
    const indexes = short.started()
    expect(indexes[0]).toBe(64)
    expect(indexes.at(-1)).toBe(69)
    expect(Math.max(...indexes)).toBe(69)
  })

  it('fetches two chunks at once, nearest first, and the next as one ends', async () => {
    const { ahead, settle } = setup()
    ahead.reached(0, 2 * MiB)
    expect(ahead.fetching).toEqual([2, 3])
    await settle(2, 'fetched')
    expect(ahead.fetching).toEqual([3, 4])
  })

  it('carries a run across reads that follow one another', () => {
    const { ahead, calls } = setup()
    ahead.reached(0, MiB)
    expect(calls).toHaveLength(0)
    ahead.reached(MiB, 2 * MiB)
    expect(ahead.fetching).toEqual([2, 3])

    // A reconnect starts a little behind the reach, and the run it joins has
    // sent 2.25 MiB; as a run of its own it would have sent 1.75 MiB.
    const reconnect = setup()
    reconnect.ahead.reached(0, MiB)
    reconnect.ahead.reached(MiB - 512 * 1024, 2 * MiB + 256 * 1024)
    expect(reconnect.ahead.fetching).toEqual([3, 4])
  })

  it('joins the followed run, though the runs kept have forgotten it', () => {
    const { ahead, started } = setup({ parallel: Infinity })
    ahead.reached(0, 2 * MiB)
    expect(started()).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
    // Short reads elsewhere push it off the eight kept.
    for (let run = 1; run <= MAX_RUNS + 2; run += 1) {
      ahead.reached((100 + run * 10) * MiB, (101 + run * 10) * MiB)
    }
    expect(started()).toHaveLength(8)

    // The player's request goes on where the run reached, with 1 MiB more: the
    // window moves on at once, as it would had the run been kept.
    ahead.reached(2 * MiB, 3 * MiB)
    expect(started().slice(8)).toEqual([10, 11, 12, 13, 14])
  })

  it('a storm of short reads moves nothing', async () => {
    // Nothing holds a fetch back here, so a read the window followed would show.
    const { ahead, calls, settle, started } = setup({ parallel: Infinity })
    ahead.reached(0, 2 * MiB)
    const first = started()
    expect(first).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
    for (let at = 50; at <= 240; at += 10) {
      ahead.reached(at * MiB, (at + 1) * MiB)
    }
    await settle(2, 'fetched')
    expect(started()).toEqual(first)
    expect(calls.every((call) => !call.signal.aborted)).toBe(true)
  })

  it('follows the newest run that has sent 2 MiB, and lets the fetches under way finish', async () => {
    const { ahead, calls, settle, started } = setup()
    ahead.reached(0, 2 * MiB)
    expect(started()).toEqual([2, 3])

    ahead.reached(100 * MiB, 102 * MiB)
    expect(calls.slice(0, 2).every((call) => !call.signal.aborted)).toBe(true)
    // Both fetches are still under way: no new one starts until one ends.
    expect(started()).toEqual([2, 3])

    await settle(2, 'fetched')
    expect(started()).toEqual([2, 3, 102])
    expect(ahead.fetching).toEqual([3, 102])
  })

  it('never fetches a chunk twice', async () => {
    const { ahead, calls, settle } = setup({ parallel: Infinity })
    ahead.reached(0, 2 * MiB)
    await settle(2, 'fetched')
    await settle(3, 'kept')
    await settle(4, 'skipped')
    await settle(5, 'failed')

    // The run goes elsewhere and then moves back over the chunks it fetched.
    ahead.reached(100 * MiB, 102 * MiB)
    ahead.reached(0, 2 * MiB)

    const counts = new Map<number, number>()
    for (const call of calls) counts.set(call.index, (counts.get(call.index) ?? 0) + 1)
    for (const index of [2, 3, 4, 5, 6, 7, 8, 9]) expect(counts.get(index)).toBe(1)
    expect([...counts.values()].every((count) => count === 1)).toBe(true)
  })

  it('tries a busy chunk again after a second', async () => {
    // Chunks 2 and 3 are all the window reaches.
    const { ahead, calls, clock, settle } = setup({ chunkCount: 4 })
    ahead.reached(0, 2 * MiB)
    expect(ahead.fetching).toEqual([2, 3])
    await settle(2, 'busy')
    await settle(3, 'skipped')
    expect(calls).toHaveLength(2)

    clock.now += BUSY_RETRY_MS - 1
    ahead.reached(0, 2 * MiB)
    expect(calls).toHaveLength(2)

    clock.now += 1
    ahead.reached(0, 2 * MiB)
    expect(calls.map((call) => call.index)).toEqual([2, 3, 2])
  })

  it('stops: aborts what is under way and does nothing after', async () => {
    const { ahead, calls, fetched, settle } = setup()
    ahead.reached(0, 2 * MiB)
    expect(calls).toHaveLength(2)
    ahead.stop()
    expect(calls.every((call) => call.signal.aborted)).toBe(true)

    ahead.reached(0, 64 * MiB)
    ahead.reached(100 * MiB, 102 * MiB)
    expect(calls).toHaveLength(2)

    await settle(2, 'fetched')
    await settle(3, 'failed')
    expect(fetched).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('reports each fetch that ends, but not one the cache had', async () => {
    // The last chunk, 3, holds what the file has past 3 MiB.
    const { ahead, clock, fetched, settle } = setup({ chunkCount: 4, size: 3 * MiB + 300_000 })
    ahead.reached(0, 2 * MiB)
    clock.now += 40
    await settle(2, 'fetched')
    expect(fetched).toEqual([{ from: 2 * MiB, bytes: MiB, ms: 40, outcome: 'fetched' }])

    clock.now += 15
    await settle(3, 'fetched')
    expect(fetched[1]).toEqual({ from: 3 * MiB, bytes: 300_000, ms: 55, outcome: 'fetched' })

    const cached = setup()
    cached.ahead.reached(0, 2 * MiB)
    await cached.settle(2, 'kept')
    await cached.settle(3, 'skipped')
    expect(cached.fetched).toEqual([])

    const failing = setup()
    failing.ahead.reached(0, 2 * MiB)
    failing.clock.now += 7
    await failing.settle(2, 'failed')
    expect(failing.fetched).toEqual([{ from: 2 * MiB, bytes: MiB, ms: 7, outcome: 'failed' }])
  })

  it('goes on to the next nearest chunk while one is busy', async () => {
    const { ahead, settle, started } = setup()
    ahead.reached(0, 2 * MiB)
    await settle(2, 'busy')
    // Chunk 2 waits for its second; 4 is the nearest the window may fetch.
    expect(ahead.fetching).toEqual([3, 4])
    expect(started()).toEqual([2, 3, 4])
  })

  it('reports a chunk that is busy only the first time', async () => {
    const { ahead, clock, fetched, settle } = setup({ chunkCount: 4 })
    ahead.reached(0, 2 * MiB)
    await settle(2, 'busy')
    await settle(3, 'skipped')
    expect(fetched).toEqual([{ from: 2 * MiB, bytes: MiB, ms: 0, outcome: 'busy' }])

    clock.now += BUSY_RETRY_MS
    ahead.reached(0, 2 * MiB)
    expect(ahead.fetching).toEqual([2])
    await settle(2, 'busy')
    expect(fetched).toHaveLength(1)
  })

  it('keeps the newest eight runs, which a read may join', () => {
    const { ahead, calls } = setup({ parallel: Infinity })
    ahead.reached(0, 2 * MiB)
    expect(calls).toHaveLength(8)
    // Ten runs of 1 MiB, 10 MiB apart: the first two are dropped.
    for (let run = 1; run <= MAX_RUNS + 2; run += 1) {
      ahead.reached((100 + run * 10) * MiB, (101 + run * 10) * MiB)
    }
    expect(calls).toHaveLength(8)

    // A read joining the oldest run kept (the third) makes it 2.25 MiB, and the window follows it.
    ahead.reached(130 * MiB + 512 * 1024, 132 * MiB + 256 * 1024)
    expect(calls[8]?.index).toBe(133)
    const followed = calls.length
    expect(followed).toBeGreaterThan(8)
    // One that would join a run dropped (the second) begins a run of its own, of 1.75 MiB.
    ahead.reached(120 * MiB + 512 * 1024, 122 * MiB + 256 * 1024)
    expect(calls).toHaveLength(followed)
  })

  it('keeps following a run that has fallen off the ones kept', async () => {
    const { ahead, settle, started } = setup()
    ahead.reached(0, 2 * MiB)
    for (let run = 1; run <= MAX_RUNS + 2; run += 1) {
      ahead.reached((100 + run * 10) * MiB, (101 + run * 10) * MiB)
    }
    expect(started()).toEqual([2, 3])
    await settle(2, 'fetched')
    expect(started()).toEqual([2, 3, 4])
  })

  it('counts a fetch whose promise rejects as failed', async () => {
    const fetched: AheadFetch[] = []
    const ahead = new ReadAhead({
      size: 3 * MiB,
      chunkSize: MiB,
      chunkCount: 3,
      prefetch: () => Promise.reject(new Error('a fetch that was not to reject')),
      onFetched: (fetch) => {
        fetched.push(fetch)
      },
      now: () => 0,
    })
    ahead.reached(0, 2 * MiB)
    await Promise.resolve()
    await Promise.resolve()
    expect(fetched).toEqual([{ from: 2 * MiB, bytes: MiB, ms: 0, outcome: 'failed' }])
  })

  it('goes on fetching when its recorder throws, and raises nothing', async () => {
    const unhandled: unknown[] = []
    const listen = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listen)
    try {
      let reports = 0
      const { ahead, settle, started } = setup({
        onFetched: () => {
          reports += 1
          throw new Error('the recorder is broken')
        },
      })
      ahead.reached(0, 2 * MiB)
      await settle(2, 'fetched')
      // The window filled again, whatever the recorder did.
      expect(started()).toEqual([2, 3, 4])
      await settle(3, 'failed')
      expect(started()).toEqual([2, 3, 4, 5])
      expect(reports).toBe(2)
      // An unhandled rejection is raised once the microtasks are over.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listen)
    }
  })
})

/** A version of `chunks` chunks of 1 MiB, which no reader reads. */
function film(id: string, chunks = 300): ReadableVersion {
  return {
    version_id: id,
    size_bytes: chunks * MiB,
    chunk_size: MiB,
    chunk_count: chunks,
    wrapped_dek: Buffer.alloc(0),
    key_id: 'key',
  }
}

/** The windows of a session on a fake clock, whose fetches never end by themselves. */
function windows() {
  const clock = { now: 1000 }
  const calls: { version: ReadableVersion; index: number; signal: AbortSignal }[] = []
  const reads = new ReadAheads({
    prefetch: (version, index, signal) =>
      new Promise<PrefetchOutcome>(() => {
        calls.push({ version, index, signal })
      }),
    now: () => clock.now,
  })
  return { reads, clock, calls }
}

describe('ReadAheads', () => {
  it('keeps one window per session and version', () => {
    const { reads } = windows()
    const first = film('v1')
    const { ahead } = reads.follow('s', first)
    expect(reads.follow('s', first).ahead).toBe(ahead)
    // The same version from another row, as a later request reads it.
    expect(reads.follow('s', film('v1')).ahead).toBe(ahead)
    // A file replaced in the middle of a play, and another session's play.
    expect(reads.follow('s', film('v2')).ahead).not.toBe(ahead)
    expect(reads.follow('t', first).ahead).not.toBe(ahead)
    expect(reads.size).toBe(3)
  })

  it('fetches through the prefetch it was given, for the version the window is of', () => {
    const { reads, calls } = windows()
    const first = film('v1')
    reads.follow('s', first).ahead.reached(0, 2 * MiB)
    const second = film('v2')
    reads.follow('s', second).ahead.reached(0, 2 * MiB)
    expect(calls.map((call) => [call.version.version_id, call.index])).toEqual([
      ['v1', 2],
      ['v1', 3],
      ['v2', 2],
      ['v2', 3],
    ])
    expect(calls[0]?.version).toBe(first)
    expect(calls[2]?.version).toBe(second)
  })

  it('forgets a window idle past two minutes, once its reads are over', () => {
    const { reads, clock } = windows()
    // Reached, but not enough to read ahead: nothing under way.
    const { ahead, done } = reads.follow('idle', film('v1'))
    ahead.reached(0, MiB)
    done()
    clock.now += SESSION_IDLE_MS
    reads.follow('other', film('v1'))
    // Idle for exactly two minutes is not past them.
    expect(reads.size).toBe(2)
    clock.now += 1
    reads.follow('another', film('v1'))
    expect(reads.size).toBe(2)
    // Dropped, so asking for it again makes a new window.
    const before = reads.size
    expect(reads.follow('idle', film('v1')).ahead).not.toBe(ahead)
    expect(reads.size).toBe(before + 1)
  })

  it('keeps a window while a read of it is open, however long it sends nothing', () => {
    const { reads, clock, calls } = windows()
    // A player paused over two minutes, its one long request still open.
    const first = reads.follow('s', film('v1'))
    clock.now += SESSION_IDLE_MS + 1
    reads.follow('t', film('v2'))
    expect(reads.size).toBe(2)
    // Not stopped: it reads ahead as the request carries on.
    first.ahead.reached(0, 2 * MiB)
    expect(first.ahead.fetching).toEqual([2, 3])
    expect(calls.every((call) => !call.signal.aborted)).toBe(true)
    expect(reads.follow('s', film('v1')).ahead).toBe(first.ahead)
  })

  it('forgets a window once its last open read is over, and it has been idle', () => {
    const { reads, clock } = windows()
    const first = reads.follow('s', film('v1'))
    clock.now += SESSION_IDLE_MS + 1
    reads.follow('t', film('v2'))
    expect(reads.size).toBe(2)
    first.done()
    // The time it ended counts: two idle minutes run from there.
    clock.now += SESSION_IDLE_MS
    reads.follow('u', film('v3'))
    expect(reads.size).toBe(3)
    clock.now += 1
    reads.follow('u', film('v3'))
    // 's' is forgotten; 't' and 'u' have reads open.
    expect(reads.size).toBe(2)
  })

  it('counts each read of a window once, however often it is done', () => {
    const { reads, clock } = windows()
    const first = reads.follow('s', film('v1'))
    const second = reads.follow('s', film('v1'))
    first.done()
    first.done()
    clock.now += SESSION_IDLE_MS + 1
    reads.follow('t', film('v2'))
    // The second read is open still.
    expect(reads.size).toBe(2)
    second.done()
    clock.now += SESSION_IDLE_MS + 1
    reads.follow('u', film('v3'))
    expect(reads.size).toBe(2)
  })

  it('keeps a window that has been reached lately, however long ago its reads were done', () => {
    const { reads, clock } = windows()
    const { ahead, done } = reads.follow('long', film('v1'))
    done()
    clock.now += SESSION_IDLE_MS
    ahead.reached(0, MiB)
    clock.now += SESSION_IDLE_MS
    reads.follow('other', film('v1'))
    expect(reads.size).toBe(2)
    expect(reads.follow('long', film('v1')).ahead).toBe(ahead)
  })

  it('keeps an idle window with a fetch under way, and stops one it drops', () => {
    const { reads, clock, calls } = windows()
    const busy = reads.follow('busy', film('v1'))
    busy.ahead.reached(0, 2 * MiB)
    busy.done()
    expect(busy.ahead.fetching).toEqual([2, 3])
    const idle = reads.follow('idle', film('v1'))
    idle.ahead.reached(0, MiB)
    idle.done()

    clock.now += SESSION_IDLE_MS + 1
    reads.follow('other', film('v1'))
    // `idle` is gone (stopped, so it fetches nothing more); `busy` has fetches under way.
    expect(reads.size).toBe(2)
    expect(reads.follow('busy', film('v1')).ahead).toBe(busy.ahead)
    expect(calls.every((call) => !call.signal.aborted)).toBe(true)
    idle.ahead.reached(0, 64 * MiB)
    expect(calls).toHaveLength(2)
  })

  it('stops every window: the fetches under way are aborted, and none starts after', () => {
    const { reads, calls } = windows()
    reads.follow('a', film('v1')).ahead.reached(0, 2 * MiB)
    reads.follow('b', film('v2')).ahead.reached(0, 2 * MiB)
    expect(calls).toHaveLength(4)
    expect(calls.every((call) => !call.signal.aborted)).toBe(true)

    reads.stop()
    expect(calls.every((call) => call.signal.aborted)).toBe(true)
    expect(reads.size).toBe(0)

    // A read that begins as the API closes finds a window that is already stopped.
    const late = reads.follow('c', film('v3'))
    late.ahead.reached(0, 4 * MiB)
    late.done()
    expect(calls).toHaveLength(4)
    expect(reads.size).toBe(0)
  })
})
