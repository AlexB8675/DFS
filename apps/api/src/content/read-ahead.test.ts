import { describe, expect, it } from 'vitest'
import type { PrefetchOutcome } from './reader.ts'
import { type AheadFetch, BUSY_RETRY_MS, MAX_RUNS, ReadAhead } from './read-ahead.ts'

const MiB = 1024 * 1024

interface Call {
  index: number
  signal: AbortSignal
  /** Settles the fetch, as the chunk's read ending would. */
  settle: (outcome: PrefetchOutcome) => void
}

/** A window on a fake clock whose fetches the test settles. */
function setup(
  options: { chunkCount?: number; size?: number; parallel?: number; windowBytes?: number } = {},
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
    onFetched: (fetch) => fetched.push(fetch),
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
    expect(ahead.fetching).toEqual([3, 4])
  })

  it('reads ahead at most four times what the run has sent, up to 128 MiB, never past the last chunk', () => {
    const first = setup({ parallel: Infinity })
    first.ahead.reached(0, 2 * MiB)
    expect(first.ahead.fetching).toEqual([3, 4, 5, 6, 7, 8, 9, 10])

    // 3 to 10 are under way still; the window now reaches from 65 to 192.
    const before = first.calls.length
    first.ahead.reached(0, 64 * MiB)
    const next = first.calls.slice(before).map((call) => call.index)
    expect(next).toHaveLength(192 - 65 + 1)
    expect(next[0]).toBe(65)
    expect(next.at(-1)).toBe(192)

    const short = setup({ chunkCount: 70, parallel: Infinity })
    short.ahead.reached(0, 64 * MiB)
    const indexes = short.started()
    expect(indexes[0]).toBe(65)
    expect(indexes.at(-1)).toBe(69)
    expect(Math.max(...indexes)).toBe(69)
  })

  it('fetches two chunks at once, nearest first, and the next as one ends', async () => {
    const { ahead, settle } = setup()
    ahead.reached(0, 2 * MiB)
    expect(ahead.fetching).toEqual([3, 4])
    await settle(3, 'fetched')
    expect(ahead.fetching).toEqual([4, 5])
  })

  it('carries a run across reads that follow one another', () => {
    const { ahead, calls } = setup()
    ahead.reached(0, MiB)
    expect(calls).toHaveLength(0)
    ahead.reached(MiB, 2 * MiB)
    expect(ahead.fetching).toEqual([3, 4])

    // A reconnect starts a little behind the reach, and the run it joins has
    // sent 2.25 MiB; as a run of its own it would have sent 1.75 MiB.
    const reconnect = setup()
    reconnect.ahead.reached(0, MiB)
    reconnect.ahead.reached(MiB - 512 * 1024, 2 * MiB + 256 * 1024)
    expect(reconnect.ahead.fetching).toEqual([3, 4])
  })

  it('a storm of short reads moves nothing', async () => {
    // Nothing holds a fetch back here, so a read the window followed would show.
    const { ahead, calls, settle, started } = setup({ parallel: Infinity })
    ahead.reached(0, 2 * MiB)
    const first = started()
    expect(first).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    for (let at = 50; at <= 240; at += 10) {
      ahead.reached(at * MiB, (at + 1) * MiB)
    }
    await settle(3, 'fetched')
    expect(started()).toEqual(first)
    expect(calls.every((call) => !call.signal.aborted)).toBe(true)
  })

  it('follows the newest run that has sent 2 MiB, and lets the fetches under way finish', async () => {
    const { ahead, calls, settle, started } = setup()
    ahead.reached(0, 2 * MiB)
    expect(started()).toEqual([3, 4])

    ahead.reached(100 * MiB, 102 * MiB)
    expect(calls.slice(0, 2).every((call) => !call.signal.aborted)).toBe(true)
    // Both fetches are still under way: no new one starts until one ends.
    expect(started()).toEqual([3, 4])

    await settle(3, 'fetched')
    expect(started()).toEqual([3, 4, 103])
    expect(ahead.fetching).toEqual([4, 103])
  })

  it('never fetches a chunk twice', async () => {
    const { ahead, calls, settle } = setup({ parallel: Infinity })
    ahead.reached(0, 2 * MiB)
    await settle(3, 'fetched')
    await settle(4, 'kept')
    await settle(5, 'skipped')
    await settle(6, 'failed')

    // The run goes elsewhere and then moves back over the chunks it fetched.
    ahead.reached(100 * MiB, 102 * MiB)
    ahead.reached(0, 2 * MiB)

    const counts = new Map<number, number>()
    for (const call of calls) counts.set(call.index, (counts.get(call.index) ?? 0) + 1)
    for (const index of [3, 4, 5, 6, 7, 8, 9, 10]) expect(counts.get(index)).toBe(1)
    expect([...counts.values()].every((count) => count === 1)).toBe(true)
  })

  it('tries a busy chunk again after a second', async () => {
    // Chunks 3 and 4 are all the window reaches.
    const { ahead, calls, clock, settle } = setup({ chunkCount: 5 })
    ahead.reached(0, 2 * MiB)
    expect(ahead.fetching).toEqual([3, 4])
    await settle(3, 'busy')
    await settle(4, 'skipped')
    expect(calls).toHaveLength(2)

    clock.now += BUSY_RETRY_MS - 1
    ahead.reached(0, 2 * MiB)
    expect(calls).toHaveLength(2)

    clock.now += 1
    ahead.reached(0, 2 * MiB)
    expect(calls.map((call) => call.index)).toEqual([3, 4, 3])
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

    await settle(3, 'fetched')
    await settle(4, 'failed')
    expect(fetched).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('reports each fetch that ends, but not one the cache had', async () => {
    // The last chunk, 4, holds what the file has past 4 MiB.
    const { ahead, clock, fetched, settle } = setup({ chunkCount: 5, size: 4 * MiB + 300_000 })
    ahead.reached(0, 2 * MiB)
    clock.now += 40
    await settle(3, 'fetched')
    expect(fetched).toEqual([{ from: 3 * MiB, bytes: MiB, ms: 40, outcome: 'fetched' }])

    clock.now += 15
    await settle(4, 'fetched')
    expect(fetched[1]).toEqual({ from: 4 * MiB, bytes: 300_000, ms: 55, outcome: 'fetched' })

    const cached = setup()
    cached.ahead.reached(0, 2 * MiB)
    await cached.settle(3, 'kept')
    await cached.settle(4, 'skipped')
    expect(cached.fetched).toEqual([])

    const failing = setup()
    failing.ahead.reached(0, 2 * MiB)
    failing.clock.now += 7
    await failing.settle(3, 'failed')
    expect(failing.fetched).toEqual([{ from: 3 * MiB, bytes: MiB, ms: 7, outcome: 'failed' }])
  })

  it('goes on to the next nearest chunk while one is busy', async () => {
    const { ahead, settle, started } = setup()
    ahead.reached(0, 2 * MiB)
    await settle(3, 'busy')
    // Chunk 3 waits for its second; 5 is the nearest the window may fetch.
    expect(ahead.fetching).toEqual([4, 5])
    expect(started()).toEqual([3, 4, 5])
  })

  it('reports a chunk that is busy only the first time', async () => {
    const { ahead, clock, fetched, settle } = setup({ chunkCount: 5 })
    ahead.reached(0, 2 * MiB)
    await settle(3, 'busy')
    await settle(4, 'skipped')
    expect(fetched).toEqual([{ from: 3 * MiB, bytes: MiB, ms: 0, outcome: 'busy' }])

    clock.now += BUSY_RETRY_MS
    ahead.reached(0, 2 * MiB)
    expect(ahead.fetching).toEqual([3])
    await settle(3, 'busy')
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
    expect(started()).toEqual([3, 4])
    await settle(3, 'fetched')
    expect(started()).toEqual([3, 4, 5])
  })

  it('counts a fetch whose promise rejects as failed', async () => {
    const fetched: AheadFetch[] = []
    const ahead = new ReadAhead({
      size: 4 * MiB,
      chunkSize: MiB,
      chunkCount: 4,
      prefetch: () => Promise.reject(new Error('a fetch that was not to reject')),
      onFetched: (fetch) => fetched.push(fetch),
      now: () => 0,
    })
    ahead.reached(0, 2 * MiB)
    await Promise.resolve()
    await Promise.resolve()
    expect(fetched).toEqual([{ from: 3 * MiB, bytes: MiB, ms: 0, outcome: 'failed' }])
  })
})
