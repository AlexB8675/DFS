import { setTimeout as sleep } from 'node:timers/promises'
import type { ByteRange } from '@dfs/mp4'
import type { TimelineEventInput } from '@dfs/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Downloader, RateMeter, clip, messageOf, pageConnectivity } from './downloader.ts'
import type { Connectivity, HeadRead } from './downloader.ts'
import { StoreError } from './errors.ts'
import {
  BLOCK_BYTES,
  FRONTIER_RETRY_MS,
  LEVEL_EVERY_MS,
  RATE_EARLY_MS,
  READ_IDLE_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  STALL_COVER_MS,
} from './limits.ts'
import { ReadError } from './read.ts'
import { RangeSet } from './ranges.ts'
import { newPlayKey } from './seal.ts'
import { FrontierFullError } from './errors.ts'
import { CoreStore } from './store.ts'
import type { PlayStore, StoreStats, WriteOutcome } from './store.ts'
import { byteAt, startRangeServer } from './testing/range-server.ts'
import type { Fault, RangeServer } from './testing/range-server.ts'
import { TestSlotFile } from './testing/slot-file.ts'

// The downloader's onward read (DESIGN.md §10.4; the iron-clad spec §4.7): what it reads, in
// which pieces, through which failures, and what it says to the timeline. Most tests read from
// the test server, which breaks and refuses as a network does; those that are about time (the
// pauses, the level, a read that is held open) read from a stub of `fetch` whose bodies the
// test feeds. Fake timers stand in for the clock and nothing else: the sockets are real, so
// the tests wait for them with a real timer that the fake ones do not touch.

const MIB = 1024 * 1024
const SEED = 7

const servers: RangeServer[] = []
const downloaders: Downloader[] = []

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
})

afterEach(async () => {
  // The downloaders go first, while the timers they set are the fake ones that clear them.
  await Promise.all(downloaders.splice(0).map((downloader) => downloader.close()))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** Waits, on the real clock, until the condition holds. */
async function until(condition: () => boolean, limitMs = 10_000): Promise<void> {
  const began = performance.now()
  while (!condition()) {
    if (performance.now() - began > limitMs) throw new Error('timed out waiting for a condition')
    await sleep(1)
  }
}

/** Lets what is already under way settle: the store, which is in memory, answers within it. */
async function settle(): Promise<void> {
  await sleep(10)
}

type EventOf<T extends TimelineEventInput['type']> = Extract<TimelineEventInput, { type: T }>

function ofType<T extends TimelineEventInput['type']>(
  events: readonly TimelineEventInput[],
  type: T,
): EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.type === type)
}

/** What a test's connectivity does: the listeners are counted, so that none is left behind. */
class FakeConnectivity implements Connectivity {
  isOnline = true
  readonly #online = new Set<() => void>()
  readonly #visible = new Set<() => void>()

  online(): boolean {
    return this.isOnline
  }

  onOnline(listener: () => void): () => void {
    this.#online.add(listener)
    return () => {
      this.#online.delete(listener)
    }
  }

  onVisible(listener: () => void): () => void {
    this.#visible.add(listener)
    return () => {
      this.#visible.delete(listener)
    }
  }

  fireOnline(): void {
    for (const listener of [...this.#online]) listener()
  }

  fireVisible(): void {
    for (const listener of [...this.#visible]) listener()
  }

  listeners(): number {
    return this.#online.size + this.#visible.size
  }
}

/** A store of a test: the core store, with what is written to it and evicted from it recorded, and a failure or a hidden range on demand. */
class SpyStore implements PlayStore {
  readonly writes: { offset: number; length: number }[] = []
  readonly evictions: { range: ByteRange; position: number }[] = []
  /** Ranges that `held()` does not say until they are written, so that a play can have a gap after it was done, as an eviction leaves one. */
  readonly hidden = new RangeSet()
  failNextWrite: Error | null = null
  /** How long a write takes, by the timers of the test (the fake ones, when they are in use); 0 is at once. */
  writeDelayMs = 0
  /** How many of the next reads answer null, as a read of a block that was evicted in between does. */
  nullReads = 0
  /** How many reads were asked of the store. */
  reads = 0
  /** Whether what is written is forgotten at once: `held()` does not say it, as when a store lets go of a block as soon as it has it. */
  forget = false
  position = 0
  readonly #inner: CoreStore

  constructor(inner: CoreStore) {
    this.#inner = inner
  }

  get backend(): 'disk' | 'memory' {
    return this.#inner.backend
  }

  get capBytes(): number {
    return this.#inner.capBytes
  }

  get fileSize(): number {
    return this.#inner.fileSize
  }

  held(): RangeSet {
    const held = this.#inner.held()
    for (const range of this.hidden.ranges()) held.remove(range)
    return held
  }

  async write(offset: number, bytes: Uint8Array): Promise<WriteOutcome> {
    if (this.writeDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.writeDelayMs)
      })
    }
    if (this.failNextWrite !== null) {
      const failure = this.failNextWrite
      this.failNextWrite = null
      throw failure
    }
    if (bytes.length > 0) this.hidden.remove({ start: offset, end: offset + bytes.length })
    const outcome = await this.#inner.write(offset, bytes)
    // A write is recorded when the store has taken it: one that was refused is not among those that were written.
    if (bytes.length > 0) this.writes.push({ offset, length: bytes.length })
    for (const range of outcome.evicted) {
      this.evictions.push({ range, position: this.position })
    }
    if (this.forget && bytes.length > 0)
      this.hidden.add({ start: offset, end: offset + bytes.length })
    return outcome
  }

  read(start: number, end: number): Promise<Uint8Array | null> {
    this.reads += 1
    if (this.nullReads > 0) {
      this.nullReads -= 1
      return Promise.resolve(null)
    }
    return this.#inner.read(start, end)
  }

  setPosition(offset: number): void {
    this.#inner.setPosition(offset)
    this.position = offset
  }

  stats(): StoreStats {
    return this.#inner.stats()
  }

  close(): Promise<void> {
    return this.#inner.close()
  }
}

function memoryStore(fileSize: number, capBytes = 16 * MIB): SpyStore {
  return new SpyStore(new CoreStore({ backend: { kind: 'memory' }, fileSize, capBytes }))
}

/** A store that seals its blocks to a file of the test, so that a block that is complete waits in the frontier until it is sealed. */
async function diskStore(fileSize: number, capBytes = 32 * MIB): Promise<SpyStore> {
  const key = await newPlayKey()
  const file = new TestSlotFile()
  return new SpyStore(new CoreStore({ backend: { kind: 'disk', file, key }, fileSize, capBytes }))
}

/** A generator of numbers in [0, 1) from a seed (mulberry32): the same offsets on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** The bytes of the test file from `start` up to, not including, `end`. */
function bytesOf(start: number, end: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(end - start)
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = byteAt(SEED, start + at)
  return bytes
}

/** Where the store's bytes first differ from the file's within `range`, or -1 when none does. A byte that is not held is a difference. */
async function firstMismatch(store: PlayStore, range: ByteRange): Promise<number> {
  const bytes = await store.read(range.start, range.end)
  if (bytes === null) return range.start
  for (let at = 0; at < bytes.length; at += 1) {
    if (bytes[at] !== byteAt(SEED, range.start + at)) return range.start + at
  }
  return -1
}

/** Every held byte of the store is the file's. */
async function expectHeldBytesRight(store: PlayStore): Promise<void> {
  for (const range of store.held().ranges()) {
    expect(await firstMismatch(store, range)).toBe(-1)
  }
}

async function serve(options: {
  size: number
  faults?: Fault[]
  chunkDelayMs?: number
}): Promise<RangeServer> {
  const server = await startRangeServer({ seed: SEED, ...options })
  servers.push(server)
  return server
}

interface Rig {
  downloader: Downloader
  store: SpyStore
  events: TimelineEventInput[]
  connectivity: FakeConnectivity
}

/** A downloader on the given store and address, with its events kept; it has not started. */
function build(options: {
  url: string
  store: SpyStore
  fetch?: typeof fetch
  random?: () => number
  now?: () => number
  head?: HeadRead
  holdOnward?: boolean
  onEvent?: (event: TimelineEventInput) => void
}): Rig {
  const events: TimelineEventInput[] = []
  const connectivity = new FakeConnectivity()
  const downloader = new Downloader({
    url: options.url,
    store: options.store,
    onEvent: (event) => {
      events.push(event)
      options.onEvent?.(event)
    },
    connectivity,
    // Half is the middle of the jitter: pauses are exactly the base and its doublings.
    random: options.random ?? (() => 0.5),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.head === undefined ? {} : { head: options.head }),
    ...(options.holdOnward === undefined ? {} : { holdOnward: options.holdOnward }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  downloaders.push(downloader)
  return { downloader, store: options.store, events, connectivity }
}

/** Runs a downloader to the end of the file, moving the clock over each pause. */
async function runToEnd(rig: Rig): Promise<void> {
  rig.downloader.start()
  for (;;) {
    await until(() => rig.downloader.state() !== 'reading')
    if (rig.downloader.state() !== 'waiting') return
    const delay = ofType(rig.events, 'retry').at(-1)?.delayMs
    if (delay === undefined) throw new Error('the downloader waits and has said no retry')
    await vi.advanceTimersByTimeAsync(delay)
  }
}

/** A stub of the network: each read is answered by `answer`, which is given the read's number and range. */
interface StubCall {
  index: number
  range: string
  from: number
  to: number | null
  signal: AbortSignal
}

/** A body that the test feeds, and ends or breaks when it likes. */
class Pipe {
  readonly response: Response
  readonly signal: AbortSignal
  readonly #held: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}

  constructor(total: number, from: number, to: number, signal: AbortSignal) {
    this.signal = signal
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#held.controller = controller
      },
    })
    // A read that is aborted breaks off, as a connection does.
    signal.addEventListener('abort', () => {
      try {
        this.#held.controller?.error(signal.reason)
      } catch {
        // A body that is over has nothing to break.
      }
    })
    this.response = new Response(stream, {
      status: 206,
      headers: { 'Content-Range': `bytes ${from}-${to}/${total}` },
    })
  }

  /** Gives the bytes of the file from `start` up to `end`. */
  push(start: number, end: number): void {
    this.#held.controller?.enqueue(bytesOf(start, end))
  }

  end(): void {
    this.#held.controller?.close()
  }

  /** Breaks the body, as a connection that drops does. */
  fail(): void {
    this.#held.controller?.error(new Error('the connection dropped'))
  }
}

type Answer = Response | Pipe

interface Stub {
  fetch: typeof fetch
  calls: StubCall[]
  pipes: Pipe[]
}

/** The ranges `bytes=a-b` and `bytes=a-` of a request. */
function rangeOf(range: string): { from: number; to: number | null } {
  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (match === null) throw new Error(`the stub was asked for ${range}`)
  return { from: Number(match[1]), to: match[2] === '' ? null : Number(match[2]) }
}

function stubNetwork(answer: (call: StubCall) => Answer): Stub {
  const calls: StubCall[] = []
  const pipes: Pipe[] = []
  // eslint-disable-next-line @typescript-eslint/require-await
  const fetchStub: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    const range = headers.get('Range') ?? ''
    const signal = init?.signal
    if (signal === undefined || signal === null) throw new Error('the stub was given no signal')
    const { from, to } = rangeOf(range)
    const call: StubCall = { index: calls.length, range, from, to, signal }
    calls.push(call)
    const given = answer(call)
    if (given instanceof Pipe) {
      pipes.push(given)
      return given.response
    }
    return given
  }
  return { fetch: fetchStub, calls, pipes }
}

/** A `206` with all the bytes of the range, in one piece. */
function wholeRange(call: StubCall, total: number): Response {
  const to = call.to ?? total - 1
  return new Response(bytesOf(call.from, to + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${call.from}-${to}/${total}` },
  })
}

function refusal(status: number, retryAfter?: string): Response {
  return new Response(null, {
    status,
    ...(retryAfter === undefined ? {} : { headers: { 'Retry-After': retryAfter } }),
  })
}

/** A pipe for the range a call asked for. */
function pipeFor(call: StubCall, total: number): Pipe {
  return new Pipe(total, call.from, call.to ?? total - 1, call.signal)
}

/** How a promise ended, kept as it comes. */
interface Outcome {
  state: 'pending' | 'held' | 'rejected'
  reason: unknown
}

/** Follows a promise from the moment it is made, so that a rejection is never left unhandled. */
function track(promise: Promise<unknown>): Outcome {
  const outcome: Outcome = { state: 'pending', reason: undefined }
  promise.then(
    () => {
      outcome.state = 'held'
    },
    (reason: unknown) => {
      outcome.state = 'rejected'
      outcome.reason = reason
    },
  )
  return outcome
}

describe('Downloader: reading to the end', () => {
  it('reads a file of 6 MiB to its end in one read, and holds every byte right', async () => {
    const size = 6 * MIB
    const server = await serve({ size })
    const rig = build({ url: server.url, store: memoryStore(size) })

    expect(rig.downloader.failure()).toBeNull()
    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(rig.downloader.failure()).toBeNull()
    expect(server.requests).toEqual([{ range: 'bytes=0-' }])
    expect(rig.store.held().ranges()).toEqual([{ start: 0, end: size }])
    expect(await firstMismatch(rig.store, { start: 0, end: size })).toBe(-1)
    expect(rig.events).toEqual([
      { type: 'request', id: 1, from: 0, to: null },
      { type: 'firstByte', id: 1 },
      { type: 'requestEnd', id: 1, bytes: size, outcome: 'done', message: null },
      { type: 'storeLevel', storedBytes: size, aheadBytes: size, evictedBytes: 0, droppedBytes: 0 },
    ])
    // Every write is of one block at most: a block is what the store seals and evicts.
    for (const write of rig.store.writes) {
      expect(Math.floor(write.offset / BLOCK_BYTES)).toBe(
        Math.floor((write.offset + write.length - 1) / BLOCK_BYTES),
      )
    }
  })

  it('is done at once, with a level and no read, when the whole file is held', async () => {
    const size = 2 * MIB
    const server = await serve({ size })
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, size))
    const rig = build({ url: server.url, store })

    rig.downloader.start()

    expect(rig.downloader.state()).toBe('done')
    expect(server.requests).toEqual([])
    expect(rig.events).toEqual([
      { type: 'storeLevel', storedBytes: size, aheadBytes: size, evictedBytes: 0, droppedBytes: 0 },
    ])
  })

  it('skips the held data: it reads up to it and from after it', async () => {
    const size = 6 * MIB
    const server = await serve({ size })
    const store = memoryStore(size)
    await store.write(2 * MIB, bytesOf(2 * MIB, 4 * MIB))
    const prefilled = store.writes.length
    const rig = build({ url: server.url, store })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(server.requests).toEqual([{ range: 'bytes=0-2097151' }, { range: 'bytes=4194304-' }])
    expect(ofType(rig.events, 'request')).toEqual([
      { type: 'request', id: 1, from: 0, to: 2 * MIB - 1 },
      { type: 'request', id: 2, from: 4 * MIB, to: null },
    ])
    expect(store.held().ranges()).toEqual([{ start: 0, end: size }])
    expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
    // The held data was not read again.
    expect(
      store.writes
        .slice(prefilled)
        .every((write) => write.offset < 2 * MIB || write.offset >= 4 * MIB),
    ).toBe(true)
  })

  it('does not start twice, and does nothing before it starts', async () => {
    const size = 2 * MIB
    const server = await serve({ size })
    const rig = build({ url: server.url, store: memoryStore(size) })

    rig.downloader.setPosition(MIB)
    await settle()
    expect(server.requests).toEqual([])
    expect(rig.events).toEqual([])

    rig.downloader.start()
    rig.downloader.start()
    await until(() => rig.downloader.state() === 'done')
    // The position set before the start is where the read began.
    expect(server.requests).toEqual([{ range: 'bytes=1048576-' }])
  })
})

describe('Downloader: the file it plays', () => {
  it('says the size of the file, which is the store’s', () => {
    const rig = build({ url: 'http://localhost/none', store: memoryStore(3 * MIB + 5) })
    expect(rig.downloader.fileSize).toBe(3 * MIB + 5)
  })
})

describe('Downloader: failures and retries', () => {
  // 1.5 MiB is the brief's case (a block and a half, and a whole number of the server's 64 KiB pieces); 1,500,000 is a multiple of neither, so that a resume rounded to a piece would be seen too.
  it.each([1_572_864, 1_500_000])(
    'reopens a read that dropped after %i bytes at the first byte it did not receive, with the pauses growing',
    async (dropped) => {
      const size = 4 * MIB
      const server = await serve({
        size,
        faults: [
          { kind: 'drop', afterBytes: dropped },
          { kind: 'status', status: 503 },
        ],
      })
      const rig = build({ url: server.url, store: memoryStore(size) })

      await runToEnd(rig)

      expect(rig.downloader.state()).toBe('done')
      expect(server.requests).toEqual([
        { range: 'bytes=0-' },
        { range: `bytes=${dropped}-` },
        { range: `bytes=${dropped}-` },
      ])
      expect(ofType(rig.events, 'retry')).toEqual([
        { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: dropped },
        { type: 'retry', attempt: 2, delayMs: 2 * RETRY_BASE_MS, offset: dropped },
      ])
      expect(await firstMismatch(rig.store, { start: 0, end: size })).toBe(-1)
      expect(rig.store.held().ranges()).toEqual([{ start: 0, end: size }])
      const ends = ofType(rig.events, 'requestEnd')
      expect(ends.map((end) => end.outcome)).toEqual(['failed', 'failed', 'done'])
      expect(ends[0]?.bytes).toBe(dropped)
      expect(ends[1]?.message).toContain('503')
      expect(ofType(rig.events, 'error')).toEqual([])
      expect(rig.connectivity.listeners()).toBe(0)
    },
  )

  it('waits as long as a pause says and not shorter', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => (call.index === 0 ? refusal(503) : wholeRange(call, size)))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    expect(rig.downloader.state()).toBe('waiting')
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1)
    await settle()
    expect(stub.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await until(() => rig.downloader.state() === 'done')
    expect(stub.calls).toHaveLength(2)
  })

  it('retries for as long as the play lasts: 20 refusals in a row, with no pause over the cap and jitter', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => (call.index < 20 ? refusal(503) : wholeRange(call, size)))
    // The top of the jitter: each pause is the largest it may be.
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
      random: () => 1,
    })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(stub.calls).toHaveLength(21)
    const retries = ofType(rig.events, 'retry')
    expect(retries).toHaveLength(20)
    expect(retries.map((retry) => retry.attempt)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    )
    // 500 ms doubling to 30 s, each 20% longer.
    const expected = retries.map((_, index) =>
      Math.round(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** index) * 1.2),
    )
    expect(retries.map((retry) => retry.delayMs)).toEqual(expected)
    expect(Math.max(...retries.map((retry) => retry.delayMs))).toBe(RETRY_MAX_MS * 1.2)
    expect(await firstMismatch(rig.store, { start: 0, end: size })).toBe(-1)
  })

  it('moves a pause down as far as the jitter allows too', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => (call.index === 0 ? refusal(503) : wholeRange(call, size)))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
      random: () => 0,
    })

    await runToEnd(rig)

    expect(ofType(rig.events, 'retry').map((retry) => retry.delayMs)).toEqual([400])
  })

  it('waits what Retry-After says as a least, with no jitter on it, and never more than the cap', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => {
      if (call.index === 0) return refusal(503, '2')
      if (call.index === 1) return refusal(429, '120')
      return wholeRange(call, size)
    })
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
      random: () => 1,
    })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    // Two seconds as given, and not the 2.4 s of a jitter; two minutes as the cap, and not as asked.
    expect(ofType(rig.events, 'retry').map((retry) => retry.delayMs)).toEqual([2000, RETRY_MAX_MS])
  })

  it('does not hammer a server that answers Retry-After: 0: the pauses grow as without it (R10)', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) =>
      call.index < 4 ? refusal(503, '0') : wholeRange(call, size),
    )
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(ofType(rig.events, 'retry').map((retry) => retry.delayMs)).toEqual([
      500, 1000, 2000, 4000,
    ])
  })

  it('takes the longer of Retry-After and its own pause: a server’s wait is a least (R10)', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) =>
      call.index < 4 ? refusal(503, '1') : wholeRange(call, size),
    )
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    await runToEnd(rig)

    // One second as the server asked while the pause is shorter; the pause once it is longer.
    expect(ofType(rig.events, 'retry').map((retry) => retry.delayMs)).toEqual([
      1000, 1000, 2000, 4000,
    ])
  })

  it('counts a pause again from the base after a read that received a block, and not before', async () => {
    const size = 6 * MIB
    const server = await serve({
      size,
      faults: [
        // Each of the first two receives 600,000 bytes, and together they are more than a block: the count is of one read.
        { kind: 'drop', afterBytes: 600_000 },
        { kind: 'drop', afterBytes: 600_000 },
        // Exactly a block: the count starts again, and this failure is the first.
        { kind: 'drop', afterBytes: BLOCK_BYTES },
        // A byte short of a block: the count goes on.
        { kind: 'drop', afterBytes: BLOCK_BYTES - 1 },
      ],
    })
    const rig = build({ url: server.url, store: memoryStore(size) })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(ofType(rig.events, 'retry').map((retry) => [retry.attempt, retry.delayMs])).toEqual([
      [1, 500],
      [2, 1000],
      [1, 500],
      [2, 1000],
    ])
    expect(await firstMismatch(rig.store, { start: 0, end: size })).toBe(-1)
  })

  it('counts a pause again from the base after any read that ends clean, whatever it received (R12)', async () => {
    const size = 3 * MIB
    const store = memoryStore(size)
    // Three small gaps, 64 KiB each, one in each block: no read of them receives a block.
    const gap = 64 * 1024
    for (const block of [0, 1, 2]) {
      await store.write(block * MIB + gap, bytesOf(block * MIB + gap, (block + 1) * MIB))
    }
    // Each gap is refused once and then served.
    const refused = new Set<number>()
    const stub = stubNetwork((call) => {
      if (!refused.has(call.from)) {
        refused.add(call.from)
        return refusal(503)
      }
      return wholeRange(call, size)
    })
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(stub.calls.map((call) => call.from)).toEqual([0, 0, MIB, MIB, 2 * MIB, 2 * MIB])
    // Each failure follows a read that ended clean, so each is the first in a row.
    expect(ofType(rig.events, 'retry').map((retry) => [retry.attempt, retry.delayMs])).toEqual([
      [1, 500],
      [1, 500],
      [1, 500],
    ])
    expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
  })

  it('treats a RangeError from the store as a failure of the read to retry, and says so', async () => {
    const size = 2 * MIB
    const server = await serve({ size })
    const store = memoryStore(size)
    store.failNextWrite = new RangeError('the frontier is full')
    const rig = build({ url: server.url, store })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(rig.downloader.failure()).toBeNull()
    expect(ofType(rig.events, 'error')).toEqual([
      expect.objectContaining({ from: 'engine', code: null }),
    ])
    expect(ofType(rig.events, 'error')[0]?.message).toContain('the frontier is full')
    expect(ofType(rig.events, 'requestEnd').map((end) => end.outcome)).toEqual(['failed', 'done'])
    expect(ofType(rig.events, 'retry')).toHaveLength(1)
    expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
  })

  describe('a refusal by the frontier rule', () => {
    /** A play whose first onward read was refused once by the store's frontier rule, and ended quietly. */
    async function refused() {
      const size = 2 * MIB
      const stub = stubNetwork((call) => pipeFor(call, size))
      const store = memoryStore(size)
      store.failNextWrite = new FrontierFullError('the frontier holds blocks nearer the position')
      const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
      rig.downloader.start()
      await until(() => stub.pipes.length === 1)
      stub.pipes[0]?.push(0, 64 * 1024)
      await until(() => ofType(rig.events, 'requestEnd').length === 1)
      await settle()
      return { size, stub, store, rig }
    }

    it('ends the read quietly, with no error and no retry after a pause', async () => {
      const { rig } = await refused()
      expect(ofType(rig.events, 'error')).toEqual([])
      expect(ofType(rig.events, 'retry')).toEqual([])
      expect(ofType(rig.events, 'requestEnd')[0]?.outcome).toBe('aborted')
      expect(rig.downloader.failure()).toBeNull()
    })

    it('does not open the read again for its range at once, but after FRONTIER_RETRY_MS', async () => {
      const { size, stub, store } = await refused()
      await settle()
      // Nothing changed: no position move, no write, no time. Not a tight loop of requests.
      expect(stub.pipes).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(FRONTIER_RETRY_MS - 1)
      expect(stub.pipes).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      await until(() => stub.pipes.length === 2)
      stub.pipes[1]?.push(0, size)
      await until(() => store.held().heldFrom(0) === size)
      expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
    })

    it('keeps a refusal for each offset: two refused reads are neither opened again before FRONTIER_RETRY_MS, but both after (B1)', async () => {
      const { stub, store, rig } = await refused()
      expect(stub.pipes).toHaveLength(1)
      // A priority read farther on is refused too, with no write landing and no position move between.
      store.failNextWrite = new FrontierFullError('the frontier holds blocks nearer the position')
      void rig.downloader.fetchNow({ start: MIB, end: MIB + 1024 }).catch(() => undefined)
      await until(() => stub.pipes.length === 2)
      stub.pipes[1]?.push(MIB, MIB + 1024)
      await until(() => ofType(rig.events, 'requestEnd').length === 2)
      await settle()
      expect(stub.pipes).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(FRONTIER_RETRY_MS - 1)
      await settle()
      expect(stub.pipes).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      await until(() => stub.pipes.length === 3)
      // Both ranges may be asked for again: the first refusal's timer ends, and the read it opens covers the second's range too.
      expect(stub.calls[2]?.range).toBe('bytes=0-')
    })

    it('opens the read again when the position is told', async () => {
      const { stub, rig } = await refused()
      expect(stub.pipes).toHaveLength(1)
      rig.downloader.setPosition(0)
      await until(() => stub.pipes.length === 2)
    })

    it('opens the read again when the frontier changes: a write by another read succeeds', async () => {
      const { stub, rig } = await refused()
      expect(stub.pipes).toHaveLength(1)
      // A priority read (the engine's) farther on brings a block.
      const wait = rig.downloader.fetchNow({ start: MIB, end: MIB + 1024 })
      await until(() => stub.pipes.length === 2)
      stub.pipes[1]?.push(MIB, MIB + 1024)
      await wait
      await until(() => stub.pipes.length === 3)
    })

    it('has no timer left when the downloader closes with the gate set', async () => {
      const { rig } = await refused()
      await rig.downloader.close()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('stops quietly when the store is closed under it', async () => {
    const size = 2 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    await store.close()
    stub.pipes[0]?.push(0, 64 * 1024)
    await until(() => ofType(rig.events, 'requestEnd').length === 1)
    await settle()

    expect(ofType(rig.events, 'error')).toEqual([])
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(ofType(rig.events, 'requestEnd')[0]?.outcome).toBe('aborted')
    expect(rig.downloader.failure()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(stub.calls).toHaveLength(1)
  })
})

describe('Downloader: coming back', () => {
  it.each([
    [
      'onOnline',
      (connectivity: FakeConnectivity) => {
        connectivity.fireOnline()
      },
    ],
    [
      'onVisible',
      (connectivity: FakeConnectivity) => {
        connectivity.fireVisible()
      },
    ],
  ])('%s cuts a long pause short and reopens at once', async (_name, fire) => {
    const size = 2 * MIB
    const stub = stubNetwork((call) =>
      call.index === 0 ? refusal(503, '20') : wholeRange(call, size),
    )
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    expect(ofType(rig.events, 'retry')[0]?.delayMs).toBe(20_000)
    expect(rig.connectivity.listeners()).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(stub.calls).toHaveLength(1)

    fire(rig.connectivity)
    await until(() => rig.downloader.state() === 'done')

    // The read reopened with 19 s of the pause left, and the pause's timer and listeners went with it.
    expect(stub.calls).toHaveLength(2)
    expect(rig.connectivity.listeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(ofType(rig.events, 'retry')).toHaveLength(1)
    expect(await firstMismatch(rig.store, { start: 0, end: size })).toBe(-1)
  })

  it('does a failure while offline still pause, and cut it short only when the network is back', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => (call.index === 0 ? refusal(503) : wholeRange(call, size)))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })
    rig.connectivity.isOnline = false

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    await settle()
    expect(stub.calls).toHaveLength(1)

    rig.connectivity.isOnline = true
    rig.connectivity.fireOnline()
    await until(() => rig.downloader.state() === 'done')
    expect(stub.calls).toHaveLength(2)
  })

  it('does not end a pause on a return to the page while the network is down (R12)', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) =>
      call.index === 0 ? refusal(503, '20') : wholeRange(call, size),
    )
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })
    rig.connectivity.isOnline = false

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    rig.connectivity.fireVisible()
    await settle()
    // The pause runs on: the page is back, but the network is not.
    expect(rig.downloader.state()).toBe('waiting')
    expect(stub.calls).toHaveLength(1)
    expect(rig.connectivity.listeners()).toBe(2)

    // The network comes back: that ends the pause, and a later return to the page needs nothing.
    rig.connectivity.isOnline = true
    rig.connectivity.fireOnline()
    await until(() => rig.downloader.state() === 'done')
    expect(stub.calls).toHaveLength(2)
  })

  it('ignores online and visible outside a pause, for a read that is moving', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    // While a read is open the downloader hears the network's return, for the reads that have gone quiet; this one has not.
    expect(rig.connectivity.listeners()).toBe(2)
    rig.connectivity.fireOnline()
    rig.connectivity.fireVisible()
    await settle()
    expect(stub.calls).toHaveLength(1)

    stub.pipes[0]?.push(0, size)
    stub.pipes[0]?.end()
    await until(() => rig.downloader.state() === 'done')
    rig.connectivity.fireOnline()
    rig.connectivity.fireVisible()
    await settle()
    expect(stub.calls).toHaveLength(1)
    expect(rig.downloader.state()).toBe('done')
    expect(rig.connectivity.listeners()).toBe(0)
  })
})

describe('Downloader: errors that end the play', () => {
  it('stops at a 404: failed, one error event, no retry, no more requests', async () => {
    const size = 2 * MIB
    const server = await serve({ size, faults: [{ kind: 'status', status: 404 }] })
    const rig = build({ url: server.url, store: memoryStore(size) })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'failed')
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS)
    await settle()

    const failure = rig.downloader.failure()
    expect(failure).toBeInstanceOf(ReadError)
    expect(failure?.fatal).toBe(true)
    expect(failure?.status).toBe(404)
    expect(ofType(rig.events, 'error')).toEqual([
      { type: 'error', from: 'engine', code: 404, message: failure?.message },
    ])
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(server.requests).toHaveLength(1)
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: 0, outcome: 'failed', message: failure?.message },
    ])
  })

  it('stops every timer and listener when a fatal answer comes after a pause, and reads nothing more', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => (call.index === 0 ? refusal(503) : refusal(404)))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    rig.connectivity.fireOnline()
    await until(() => rig.downloader.state() === 'failed')

    expect(vi.getTimerCount()).toBe(0)
    expect(rig.connectivity.listeners()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS)
    rig.connectivity.fireOnline()
    rig.connectivity.fireVisible()
    rig.downloader.setPosition(MIB)
    await settle()
    expect(stub.calls).toHaveLength(2)
    expect(rig.downloader.state()).toBe('failed')
    expect(ofType(rig.events, 'error')).toHaveLength(1)
    expect(ofType(rig.events, 'storeLevel')).toEqual([])
  })

  it('fails on an answer that is of another file', async () => {
    const size = 2 * MIB
    const server = await serve({ size })
    // The store knows a file of another size.
    const store = memoryStore(size + 1)
    const rig = build({ url: server.url, store })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'failed')

    expect(rig.downloader.failure()?.fatal).toBe(true)
    expect(ofType(rig.events, 'error')).toHaveLength(1)
  })
})

describe('Downloader: a store that fills', () => {
  it('stops at a full store and stays stopped until the position frees a slot', async () => {
    const size = 12 * MIB
    const server = await serve({ size })
    const store = memoryStore(size, 4 * MIB)
    const rig = build({ url: server.url, store })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'full')

    expect(ofType(rig.events, 'storeFull')).toEqual([
      { type: 'storeFull', on: true, storedBytes: 4 * MIB },
    ])
    expect(ofType(rig.events, 'requestEnd').map((end) => end.outcome)).toEqual(['aborted'])
    expect(server.requests).toEqual([{ range: 'bytes=0-' }])
    // The block that filled the store is kept, in the frontier.
    expect(store.held().heldFrom(0)).toBe(5 * MIB)

    // The block of the position is nearer than the one that waits, but no slot's block is further than it: still full.
    rig.downloader.setPosition(MIB)
    await settle()
    expect(rig.downloader.state()).toBe('full')
    expect(ofType(rig.events, 'storeFull')).toHaveLength(1)
    expect(server.requests).toHaveLength(1)

    rig.downloader.setPosition(3 * MIB)
    await until(() => server.requests.length === 2)

    // The block furthest behind gave its slot to the one that waited, and the read went on after it.
    expect(server.requests[1]).toEqual({ range: `bytes=${5 * MIB}-` })
    expect(ofType(rig.events, 'storeFull').map((event) => event.on)).toEqual([true, false])
    expect(ofType(rig.events, 'storeFull')[1]?.storedBytes).toBe(4 * MIB)
    expect(store.held().has({ start: 0, end: MIB })).toBe(false)
    expect(store.held().has({ start: MIB, end: 5 * MIB })).toBe(true)
  })

  it('downloads a file bigger than its store while the position advances, keeping what is nearest', async () => {
    const size = 12 * MIB
    const server = await serve({ size })
    const store = memoryStore(size, 4 * MIB)
    let position = 0
    const requests: { from: number; position: number; gap: ByteRange | null }[] = []
    const rig = build({
      url: server.url,
      store,
      onEvent: (event) => {
        // At the moment the read is reported, the store stands as the gap was chosen from it.
        if (event.type === 'request') {
          requests.push({ from: event.from, position, gap: store.held().firstGap(position, size) })
        }
      },
    })

    rig.downloader.start()
    for (;;) {
      await until(() => rig.downloader.state() !== 'reading')
      if (rig.downloader.state() !== 'full') break
      // The playhead moves on, as playback does while the download waits.
      position = Math.min(position + MIB, size)
      rig.downloader.setPosition(position)
      await sleep(2)
    }

    expect(rig.downloader.state()).toBe('done')
    expect(ofType(rig.events, 'error')).toEqual([])
    // Going on as the playback makes room is not a seek: no read began for one.
    expect(ofType(rig.events, 'restart')).toEqual([])
    // The download stopped and went on several times, and the two alternate.
    const fulls = ofType(rig.events, 'storeFull').map((event) => event.on)
    expect(fulls.length).toBeGreaterThanOrEqual(6)
    fulls.forEach((on, index) => {
      expect(on).toBe(index % 2 === 0)
    })
    expect(fulls.at(-1)).toBe(false)

    // Each read began at the first gap at or after the position of that moment.
    expect(requests.length).toBeGreaterThan(1)
    for (const request of requests) {
      expect(request.gap).not.toBeNull()
      expect(request.from).toBe(request.gap?.start)
    }
    // No byte was written twice: what was kept was not read again.
    const writes = [...store.writes].sort((a, b) => a.offset - b.offset)
    writes.forEach((write, index) => {
      const previous = writes[index - 1]
      if (previous !== undefined)
        expect(write.offset).toBeGreaterThanOrEqual(previous.offset + previous.length)
    })
    // Only blocks behind the position were let go of, and never the position's block.
    expect(store.evictions.length).toBeGreaterThan(0)
    for (const { range, position: at } of store.evictions) {
      expect(range.end).toBeLessThanOrEqual(Math.floor(at / BLOCK_BYTES) * BLOCK_BYTES)
    }
    // What is held at the end is what is nearest to the final position: nothing that was let go of is nearer than a block that was kept.
    const finalBlock = Math.floor(position / BLOCK_BYTES)
    const distance = (block: number): number => Math.abs(block - finalBlock)
    const kept = new Set<number>()
    for (const range of store.held().ranges()) {
      for (
        let block = Math.floor(range.start / BLOCK_BYTES);
        block * BLOCK_BYTES < range.end;
        block += 1
      ) {
        kept.add(block)
      }
    }
    const letGo = new Set(
      store.evictions.flatMap(({ range }) => [Math.floor(range.start / BLOCK_BYTES)]),
    )
    expect(store.stats().storedBytes).toBe(4 * MIB)
    expect(kept.size).toBeGreaterThanOrEqual(4)
    expect(kept.size).toBeLessThanOrEqual(4 + 4)
    expect(Math.min(...[...letGo].map(distance))).toBeGreaterThanOrEqual(
      Math.max(...[...kept].map(distance)),
    )
    await expectHeldBytesRight(store)
  })

  it('is done, and not full, when the write that fills the store finishes the file', async () => {
    const size = 5 * MIB
    const server = await serve({ size })
    const rig = build({ url: server.url, store: memoryStore(size, 4 * MIB) })

    await runToEnd(rig)

    expect(rig.downloader.state()).toBe('done')
    expect(ofType(rig.events, 'storeFull')).toEqual([])
    expect(ofType(rig.events, 'requestEnd').map((end) => end.outcome)).toEqual(['done'])
    expect(rig.store.held().ranges()).toEqual([{ start: 0, end: size }])
    expect(await firstMismatch(rig.store, { start: 0, end: size })).toBe(-1)
  })

  it('is done, and not full for ever, when the position moves to where nothing is left to read (R12)', async () => {
    const size = 6 * MIB
    const server = await serve({ size })
    const store = memoryStore(size, 4 * MIB)
    const rig = build({ url: server.url, store })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'full')
    // Another reader (a priority read, in Task 12) holds the rest of the file: both blocks wait for slots, and the store is still full.
    await store.write(5 * MIB, bytesOf(5 * MIB, size))
    expect(store.held().ranges()).toEqual([{ start: 0, end: size }])

    rig.downloader.setPosition(0)
    await until(() => rig.downloader.state() === 'done')

    expect(ofType(rig.events, 'storeFull')).toEqual([
      { type: 'storeFull', on: true, storedBytes: 4 * MIB },
      { type: 'storeFull', on: false, storedBytes: 4 * MIB },
    ])
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(1)
    expect(server.requests).toHaveLength(1)
  })

  it('checks one place at a time when the position moves while it checks', async () => {
    const size = 12 * MIB
    const server = await serve({ size })
    const store = memoryStore(size, 4 * MIB)
    const rig = build({ url: server.url, store })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'full')
    const writes = store.writes.length

    // Several moves in one turn: at most one check at a time, and the last position is the one that counts.
    let checking = 0
    let overlapped = false
    const write = store.write.bind(store)
    store.write = async (offset, bytes) => {
      if (bytes.length === 0) {
        checking += 1
        if (checking > 1) overlapped = true
      }
      try {
        return await write(offset, bytes)
      } finally {
        if (bytes.length === 0) checking -= 1
      }
    }
    rig.downloader.setPosition(MIB)
    rig.downloader.setPosition(2 * MIB)
    rig.downloader.setPosition(3 * MIB)
    await until(() => server.requests.length === 2)

    expect(overlapped).toBe(false)
    expect(store.position).toBe(3 * MIB)
    expect(store.writes.length).toBeGreaterThanOrEqual(writes)
    expect(ofType(rig.events, 'storeFull').map((event) => event.on)).toEqual([true, false])
  })
})

describe('Downloader: the read and the data it meets', () => {
  it('ends a read whose next byte another writer has made held, and opens the next gap', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(0, 64 * 1024)
    await until(() => store.held().heldFrom(0) === 64 * 1024)
    // Another read, as Task 12's, holds what this one would read next.
    await store.write(128 * 1024, bytesOf(128 * 1024, 2 * MIB))
    stub.pipes[0]?.push(64 * 1024, 128 * 1024)

    await until(() => stub.pipes.length === 2)

    // It wrote the piece that ran up to the held data, and ended there, and its connection was let go.
    expect(store.held().heldFrom(0)).toBe(2 * MIB)
    expect(stub.calls[0]?.signal.aborted).toBe(true)
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: 128 * 1024, outcome: 'done', message: null },
    ])
    expect(stub.calls[1]).toMatchObject({ from: 2 * MIB, to: null })
    stub.pipes[1]?.push(2 * MIB, size)
    stub.pipes[1]?.end()
    await until(() => rig.downloader.state() === 'done')
    expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
  })

  it('does not write a piece that is held already, and ends there', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(0, 64 * 1024)
    await until(() => store.held().heldFrom(0) === 64 * 1024)
    await store.write(64 * 1024, bytesOf(64 * 1024, 2 * MIB))
    const writes = store.writes.length
    stub.pipes[0]?.push(64 * 1024, 128 * 1024)

    await until(() => stub.pipes.length === 2)

    expect(store.writes).toHaveLength(writes)
    expect(stub.calls[0]?.signal.aborted).toBe(true)
    expect(ofType(rig.events, 'requestEnd')[0]).toMatchObject({ id: 1, outcome: 'done' })
    expect(stub.calls[1]).toMatchObject({ from: 2 * MIB, to: null })
  })

  it('writes only what is not held of a piece that runs into held data, and ends there (R12)', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    // Another reader holds 100 KiB to 200 KiB while the read is open; the piece the network gives next covers them.
    await store.write(100 * 1024, bytesOf(100 * 1024, 200 * 1024))
    const written = store.writes.length
    stub.pipes[0]?.push(0, 300 * 1024)

    await until(() => stub.pipes.length === 2)

    // The part up to the held data was written, and nothing of the held data again.
    expect(store.writes.slice(written)).toEqual([{ offset: 0, length: 100 * 1024 }])
    expect(ofType(rig.events, 'requestEnd')[0]).toMatchObject({ id: 1, outcome: 'done' })
    expect(stub.calls[1]).toMatchObject({ from: 200 * 1024, to: null })
    expect(store.held().ranges()).toEqual([{ start: 0, end: 200 * 1024 }])
    expect(await firstMismatch(store, { start: 0, end: 200 * 1024 })).toBe(-1)
  })

  it('splits what the network gives at the blocks, whatever the size of the pieces', async () => {
    const size = 3 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    // One piece that crosses two block boundaries.
    stub.pipes[0]?.push(0, 2 * MIB + 100)
    stub.pipes[0]?.push(2 * MIB + 100, size)
    stub.pipes[0]?.end()
    await until(() => rig.downloader.state() === 'done')

    expect(store.writes).toEqual([
      { offset: 0, length: MIB },
      { offset: MIB, length: MIB },
      { offset: 2 * MIB, length: 100 },
      { offset: 2 * MIB + 100, length: MIB - 100 },
    ])
    expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
  })
})

describe('Downloader: the position', () => {
  it('keeps a pause going when the position moves and the read would be the same', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => (call.index === 0 ? refusal(503) : wholeRange(call, size)))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    // The data after the position: held, so that moving inside it changes nothing about what is read.
    await store.write(0, bytesOf(0, MIB))

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    rig.downloader.setPosition(512 * 1024)
    await settle()

    expect(rig.downloader.state()).toBe('waiting')
    expect(stub.calls).toHaveLength(1)
    expect(store.position).toBe(512 * 1024)
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => rig.downloader.state() === 'done')
    expect(stub.calls[1]).toMatchObject({ from: MIB })
  })

  it('reopens a pause at once when the position moves to where another read is wanted', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => (call.index === 0 ? refusal(503) : wholeRange(call, size)))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    rig.downloader.setPosition(3 * MIB)
    await until(() => rig.downloader.state() === 'done')

    expect(stub.calls[1]).toMatchObject({ from: 3 * MIB, to: null })
    expect(ofType(rig.events, 'restart')).toEqual([
      { type: 'restart', offset: 3 * MIB, reason: 'seek' },
    ])
    expect(vi.getTimerCount()).toBe(0)
    expect(rig.connectivity.listeners()).toBe(0)
    expect(store.position).toBe(3 * MIB)
  })

  it('is done when the position moves in a pause to where nothing is left to read', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    await store.write(2 * MIB, bytesOf(2 * MIB, size))
    const stub = stubNetwork(() => refusal(503))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    rig.downloader.setPosition(2 * MIB)

    expect(rig.downloader.state()).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
    expect(rig.connectivity.listeners()).toBe(0)
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * RETRY_MAX_MS)
    expect(stub.calls).toHaveLength(1)
  })

  it('reads again when the position moves, from done, to where a gap is', async () => {
    const size = 2 * MIB
    const server = await serve({ size })
    const store = memoryStore(size)
    const rig = build({ url: server.url, store })
    await runToEnd(rig)
    expect(rig.downloader.state()).toBe('done')

    // The block was let go of, as an eviction would have.
    store.hidden.add({ start: 0, end: MIB })
    rig.downloader.setPosition(0)
    await until(() => server.requests.length === 2)
    await until(() => rig.downloader.state() === 'done')

    expect(server.requests[1]).toEqual({ range: `bytes=0-${MIB - 1}` })
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(2)
  })

  it('gives the position to the store in every state, and refuses one that is not in the file', async () => {
    const size = 2 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    // The read is at the position, not behind it: a read that is behind yields to a new one (see the seeks).
    stub.pipes[0]?.push(0, MIB)
    await until(() => store.held().heldFrom(0) === MIB)
    rig.downloader.setPosition(MIB)
    expect(store.position).toBe(MIB)
    expect(() => {
      rig.downloader.setPosition(size + 1)
    }).toThrow(RangeError)
    expect(store.position).toBe(MIB)
    expect(stub.calls).toHaveLength(1)
    expect(rig.downloader.state()).toBe('reading')
  })
})

describe('Downloader: the level', () => {
  it('is sent every LEVEL_EVERY_MS while a read is open, and not after done', async () => {
    const size = 3 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(0, MIB)
    await until(() => store.held().heldFrom(0) === MIB)
    await vi.advanceTimersByTimeAsync(LEVEL_EVERY_MS - 1)
    expect(ofType(rig.events, 'storeLevel')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(ofType(rig.events, 'storeLevel')).toEqual([
      { type: 'storeLevel', storedBytes: MIB, aheadBytes: MIB, evictedBytes: 0, droppedBytes: 0 },
    ])
    // The server keeps sending (a read that is quiet for READ_IDLE_MS is given up on, and the level with it).
    await vi.advanceTimersByTimeAsync(LEVEL_EVERY_MS - 1000)
    stub.pipes[0]?.push(MIB, 2 * MIB)
    await until(() => store.held().heldFrom(0) === 2 * MIB)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(2)

    // The position is where the ahead is counted from.
    rig.downloader.setPosition(MIB / 2)
    await vi.advanceTimersByTimeAsync(LEVEL_EVERY_MS)
    expect(ofType(rig.events, 'storeLevel')[2]).toMatchObject({ aheadBytes: 1.5 * MIB })

    stub.pipes[0]?.push(2 * MIB, size)
    stub.pipes[0]?.end()
    await until(() => rig.downloader.state() === 'done')
    // One more, for the end of the download; then none, for no read is open.
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(10 * LEVEL_EVERY_MS)
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('goes on across reads that follow one another: its phase is not restarted by each', async () => {
    const size = 3 * MIB
    const store = memoryStore(size)
    // One block is held in the middle, so that two reads follow one another.
    await store.write(MIB, bytesOf(MIB, 2 * MIB))
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    await vi.advanceTimersByTimeAsync(3000)
    stub.pipes[0]?.push(0, MIB)
    stub.pipes[0]?.end()
    await until(() => stub.pipes.length === 2)
    await vi.advanceTimersByTimeAsync(3000)

    // Six seconds after the first read opened, whichever read is open: the level of the fifth.
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(1)
  })

  it('is not sent in a pause, nor after a failure', async () => {
    const size = 2 * MIB
    const stub = stubNetwork(() => refusal(503))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1)
    expect(ofType(rig.events, 'storeLevel')).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe('Downloader: close', () => {
  it('clears a pause, the listeners and the timers, closes the store, and reads nothing after', async () => {
    const size = 2 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork(() => refusal(503))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')
    await rig.downloader.close()

    expect(vi.getTimerCount()).toBe(0)
    expect(rig.connectivity.listeners()).toBe(0)
    await expect(store.write(0, new Uint8Array(1))).rejects.toBeInstanceOf(StoreError)
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS)
    rig.connectivity.fireOnline()
    rig.downloader.setPosition(MIB)
    rig.downloader.start()
    await settle()
    expect(stub.calls).toHaveLength(1)
    expect(rig.downloader.failure()).toBeNull()
  })

  it('lets go of a head read that was never taken over, when it closes first', async () => {
    const size = 2 * MIB
    const store = memoryStore(size)
    const controller = new AbortController()
    const rig = build({
      url: 'http://stub.invalid/file',
      store,
      head: {
        id: 4,
        controller,
        to: MIB - 1,
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve()
          yield bytesOf(0, 10)
        })(),
        meter: new RateMeter(),
      },
    })

    await rig.downloader.close()
    rig.downloader.start()
    await settle()

    // The head is let go of, and nothing was read from it, nor sent of it.
    expect(controller.signal.aborted).toBe(true)
    expect(store.writes).toEqual([])
    expect(rig.events).toEqual([])
  })

  it('aborts the read that is open, ends it on the timeline once, and is idempotent', async () => {
    const size = 2 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(0, 100)
    await until(() => store.held().heldFrom(0) === 100)
    const first = rig.downloader.close()
    const second = rig.downloader.close()
    await expect(Promise.all([first, second])).resolves.toBeDefined()
    await rig.downloader.close()

    expect(stub.calls[0]?.signal.aborted).toBe(true)
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: 100, outcome: 'aborted', message: null },
    ])
    expect(ofType(rig.events, 'error')).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await settle()
    expect(stub.calls).toHaveLength(1)
  })

  it('closes while a write is awaited without an unhandled rejection', async () => {
    const size = 2 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      rig.downloader.start()
      await until(() => stub.pipes.length === 1)
      stub.pipes[0]?.push(0, MIB)
      stub.pipes[0]?.push(MIB, size)
      await rig.downloader.close()
      await settle()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})

describe('Downloader: a seek', () => {
  // The test server waits with the timers of this process, which the fake ones would stop.
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('opens a read at a seek outside what is held, keeps what is held, and answers a wait there', async () => {
    const size = 32 * MIB
    // The first read is slow, so that it is far from the end when the position moves.
    const server = await serve({ size, faults: [{ kind: 'delay', ms: 4 }] })
    const store = memoryStore(size)
    const rig = build({ url: server.url, store })

    rig.downloader.start()
    await until(() => store.held().heldFrom(0) >= 2 * MIB)
    rig.downloader.setPosition(8 * MIB)
    await rig.downloader.whenHeld({ start: 8 * MIB, end: 9 * MIB })

    // The read, which was behind the position, yielded; then a read began at the position, and the restart comes before its request.
    expect(ofType(rig.events, 'restart')).toEqual([
      { type: 'restart', offset: 8 * MIB, reason: 'seek' },
    ])
    expect(ofType(rig.events, 'requestEnd')[0]).toMatchObject({ id: 1, outcome: 'aborted' })
    expect(ofType(rig.events, 'request')[1]).toEqual({
      type: 'request',
      id: 2,
      from: 8 * MIB,
      to: null,
    })
    const endAt = rig.events.findIndex((event) => event.type === 'requestEnd')
    const restartAt = rig.events.findIndex((event) => event.type === 'restart')
    const requestAt = rig.events.findIndex((event) => event.type === 'request' && event.id === 2)
    expect(endAt).toBeLessThan(restartAt)
    expect(requestAt).toBe(restartAt + 1)
    // Nothing stored was dropped by the seek.
    expect(store.held().has({ start: 0, end: 2 * MIB })).toBe(true)
    expect(store.evictions).toEqual([])
    expect(await firstMismatch(store, { start: 8 * MIB, end: 9 * MIB })).toBe(-1)
    expect(await firstMismatch(store, { start: 0, end: 2 * MIB })).toBe(-1)
  })

  it('opens no read for a seek back into what is held, and reads it at once', async () => {
    const size = 32 * MIB
    const server = await serve({ size, faults: [{ kind: 'delay', ms: 4 }] })
    const store = memoryStore(size)
    const rig = build({ url: server.url, store })

    rig.downloader.start()
    await until(() => store.held().heldFrom(0) >= 3 * MIB)
    rig.downloader.setPosition(MIB)
    await settle()

    // The read is ahead of the position and covers the first gap: it goes on.
    expect(rig.downloader.state()).toBe('reading')
    expect(server.requests).toHaveLength(1)
    expect(ofType(rig.events, 'restart')).toEqual([])
    expect(ofType(rig.events, 'requestEnd')).toEqual([])
    const bytes = await rig.downloader.read({ start: MIB, end: MIB + 1000 })
    expect(Buffer.compare(bytes, bytesOf(MIB, MIB + 1000))).toBe(0)
    expect(server.requests).toHaveLength(1)
  })

  it('opens no read for a seek in a file that is down, and says nothing of it', async () => {
    const size = 4 * MIB
    const server = await serve({ size })
    const rig = build({ url: server.url, store: memoryStore(size) })
    rig.downloader.start()
    await until(() => rig.downloader.state() === 'done')
    const events = rig.events.length

    rig.downloader.setPosition(2 * MIB)
    rig.downloader.setPosition(0)
    await settle()

    expect(server.requests).toHaveLength(1)
    expect(rig.downloader.state()).toBe('done')
    // Not even a second level for the end that was reached.
    expect(rig.events).toHaveLength(events)
  })

  it('lets a read yield when it falls behind the position, and not when it is at it', async () => {
    const size = 8 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(0, MIB)
    await until(() => store.held().heldFrom(0) === MIB)

    // The next byte of the read is the position: it is not behind, it covers the gap, and nothing opens.
    rig.downloader.setPosition(MIB)
    await settle()
    expect(stub.calls).toHaveLength(1)
    expect(ofType(rig.events, 'requestEnd')).toEqual([])
    expect(ofType(rig.events, 'restart')).toEqual([])

    // One byte past it the read is behind: it yields, what it brought stays held, and a read opens at the position.
    rig.downloader.setPosition(MIB + 1)
    await until(() => stub.calls.length === 2)
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: MIB, outcome: 'aborted', message: null },
    ])
    expect(stub.calls[0]?.signal.aborted).toBe(true)
    expect(stub.calls[1]).toMatchObject({ from: MIB + 1, to: null })
    expect(ofType(rig.events, 'restart')).toEqual([
      { type: 'restart', offset: MIB + 1, reason: 'seek' },
    ])
    expect(store.held().ranges()).toEqual([{ start: 0, end: MIB }])
  })

  it('keeps at most two onward reads, and gives up the one farthest from the position for a third', async () => {
    const size = 40 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    rig.downloader.setPosition(20 * MIB)
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    // The place at 5 MiB is not where the read at 20 MiB reads: a second read opens, and the first goes on.
    rig.downloader.setPosition(5 * MIB)
    await until(() => stub.pipes.length === 2)
    expect(stub.calls.map((call) => call.from)).toEqual([20 * MIB, 5 * MIB])
    expect(ofType(rig.events, 'requestEnd')).toEqual([])

    // A third, at 1 MiB: the read at 20 MiB is the farthest from the position, and goes before the new one opens.
    rig.downloader.setPosition(MIB)
    await until(() => stub.pipes.length === 3)
    expect(stub.calls.map((call) => call.from)).toEqual([20 * MIB, 5 * MIB, MIB])
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: 0, outcome: 'aborted', message: null },
    ])
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([true, false, false])
    expect(ofType(rig.events, 'restart')).toEqual([
      { type: 'restart', offset: 5 * MIB, reason: 'seek' },
      { type: 'restart', offset: MIB, reason: 'seek' },
    ])
    const endAt = rig.events.findIndex((event) => event.type === 'requestEnd')
    const thirdAt = rig.events.findIndex((event) => event.type === 'request' && event.id === 3)
    expect(endAt).toBeLessThan(thirdAt)
  })

  it('reads again from done at a seek to a gap, with a restart', async () => {
    const size = 2 * MIB
    const server = await serve({ size })
    const store = memoryStore(size)
    const rig = build({ url: server.url, store })
    rig.downloader.start()
    await until(() => rig.downloader.state() === 'done')

    // The block was let go of, as an eviction would have.
    store.hidden.add({ start: 0, end: MIB })
    rig.downloader.setPosition(0)
    await until(() => rig.downloader.state() === 'done' && server.requests.length === 2)

    expect(ofType(rig.events, 'restart')).toEqual([{ type: 'restart', offset: 0, reason: 'seek' }])
  })

  describe('out of a full store', () => {
    /**
     * A file of 32 MiB over a store of 8 MiB: the download fills the store from the start, the
     * position goes to 20 MiB, and the download fills it again from there, until it holds
     * [20, 29) MiB with the block at 28 MiB waiting for a slot. The state is `full`, the position
     * is at 20 MiB and nothing is read.
     */
    async function fullAtTwenty(): Promise<{ rig: Rig; store: SpyStore; server: RangeServer }> {
      const size = 32 * MIB
      const server = await serve({ size })
      const store = memoryStore(size, 8 * MIB)
      const rig = build({ url: server.url, store })
      rig.downloader.start()
      await until(() => rig.downloader.state() === 'full')
      expect(store.held().ranges()).toEqual([{ start: 0, end: 9 * MIB }])

      rig.downloader.setPosition(20 * MIB)
      await until(
        () =>
          rig.downloader.state() === 'full' && store.held().has({ start: 20 * MIB, end: 29 * MIB }),
      )
      await settle()
      expect(store.held().ranges()).toEqual([{ start: 20 * MIB, end: 29 * MIB }])
      expect(server.openResponses()).toBe(0)
      expect(ofType(rig.events, 'restart')).toEqual([
        { type: 'restart', offset: 20 * MIB, reason: 'seek' },
      ])
      return { rig, store, server }
    }

    it('opens a read where a seek back lands, with a restart, keeps the block that waits, and answers a wait there with no fetchNow', async () => {
      const { rig, store, server } = await fullAtTwenty()
      const requests = server.requests.length
      const events = rig.events.length

      rig.downloader.setPosition(5 * MIB)
      await until(() => server.requests.length > requests, 2000)

      // The read begins at the position and goes up to the data that is held.
      expect(server.requests.slice(requests)).toEqual([
        { range: `bytes=${5 * MIB}-${20 * MIB - 1}` },
      ])
      const after = rig.events.slice(events)
      expect(ofType(after, 'restart')).toEqual([
        { type: 'restart', offset: 5 * MIB, reason: 'seek' },
      ])
      // The store said that it has room (it may fill again by now, so only the first change counts).
      expect(ofType(after, 'storeFull').map((event) => event.on)[0]).toBe(false)
      // The block that waited is the farthest data, farther than the gap at the seek: it stays, held and right, and is not counted as full.
      expect(store.evictions.map((eviction) => eviction.range)).not.toContainEqual({
        start: 28 * MIB,
        end: 29 * MIB,
      })
      expect(store.held().has({ start: 28 * MIB, end: 29 * MIB })).toBe(true)
      expect(await firstMismatch(store, { start: 28 * MIB, end: 29 * MIB })).toBe(-1)
      const restartAt = after.findIndex((event) => event.type === 'restart')
      const requestAt = after.findIndex((event) => event.type === 'request')
      expect(requestAt).toBe(restartAt + 1)

      // The read brings the bytes there, and nobody asked for them with fetchNow.
      await rig.downloader.whenHeld({ start: 5 * MIB, end: 6 * MIB })
      expect(await firstMismatch(store, { start: 5 * MIB, end: 6 * MIB })).toBe(-1)
      expect(server.requests.slice(requests)[0]).toEqual({
        range: `bytes=${5 * MIB}-${20 * MIB - 1}`,
      })
    })

    it('says once that it restarted when the engine reads at the seek in the same turn as it moves the position, and its read covers the place', async () => {
      const { rig, store, server } = await fullAtTwenty()
      const requests = server.requests.length
      const events = rig.events.length

      // The engine's read opens before the store has said that it has room, and the onward read waits for it.
      rig.downloader.setPosition(5 * MIB)
      const bytes = await rig.downloader.read({ start: 5 * MIB, end: 6 * MIB })
      expect(Buffer.compare(bytes, bytesOf(5 * MIB, 6 * MIB))).toBe(0)
      await until(() => server.requests.length >= requests + 2, 2000)

      expect(server.requests.slice(requests, requests + 2)).toEqual([
        { range: `bytes=${5 * MIB}-${6 * MIB - 1}` },
        { range: `bytes=${6 * MIB}-${20 * MIB - 1}` },
      ])
      const after = rig.events.slice(events)
      expect(ofType(after, 'restart')).toEqual([
        { type: 'restart', offset: 5 * MIB, reason: 'seek' },
      ])
      expect(ofType(after, 'storeFull').map((event) => event.on)[0]).toBe(false)
      expect(store.held().has({ start: 28 * MIB, end: 29 * MIB })).toBe(true)
    })

    it('goes on reading ahead as the engine plays on from there, with the one onward read and no request for each read', async () => {
      const { rig, store, server } = await fullAtTwenty()
      const requests = server.requests.length
      const events = rig.events.length

      rig.downloader.setPosition(5 * MIB)
      await until(() => server.requests.length > requests, 2000)
      // The engine plays: it reads a megabyte and moves the position, again and again.
      for (let block = 5; block < 20; block += 1) {
        const bytes = await rig.downloader.read({ start: block * MIB, end: (block + 1) * MIB })
        expect(Buffer.compare(bytes, bytesOf(block * MIB, (block + 1) * MIB))).toBe(0)
        rig.downloader.setPosition((block + 1) * MIB)
        await sleep(5)
      }

      const after = rig.events.slice(events)
      // Every request the play made is an onward read: none is for one megabyte, the size of the engine's reads.
      const made = server.requests.slice(requests).map((request) => request.range)
      expect(made[0]).toBe(`bytes=${5 * MIB}-${20 * MIB - 1}`)
      for (const range of made) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
        const span = match?.[2] === '' ? Infinity : Number(match?.[2]) - Number(match?.[1]) + 1
        expect(span).not.toBe(MIB)
      }
      // A read that finds the store full, and goes on when the position makes room, is a request more; one for each read of the engine would be fifteen.
      expect(made.length).toBeLessThanOrEqual(4)
      expect(ofType(after, 'retry')).toEqual([])
      expect(ofType(after, 'error')).toEqual([])
      // The play went from 5 MiB to 20 MiB and the position moved on only by the megabyte: a restart is for the seek alone.
      expect(ofType(after, 'restart')).toEqual([
        { type: 'restart', offset: 5 * MIB, reason: 'seek' },
      ])
      await expectHeldBytesRight(store)
    })

    it('does not say that it restarted when the position makes room and the download goes on from where it stopped', async () => {
      const size = 12 * MIB
      const server = await serve({ size })
      const store = memoryStore(size, 4 * MIB)
      const rig = build({ url: server.url, store })
      rig.downloader.start()
      await until(() => rig.downloader.state() === 'full')

      // A move that makes room: the block furthest behind gives its slot, and the read goes on after the block that waited.
      rig.downloader.setPosition(3 * MIB)
      await until(() => server.requests.length === 2)
      expect(server.requests[1]).toEqual({ range: `bytes=${5 * MIB}-` })
      expect(ofType(rig.events, 'restart')).toEqual([])
    })

    it('does not say that it restarted when a read of the engine brought the bytes after where the download stopped', async () => {
      const size = 12 * MIB
      const server = await serve({ size })
      const store = memoryStore(size, 4 * MIB)
      const rig = build({ url: server.url, store })
      rig.downloader.start()
      await until(() => rig.downloader.state() === 'full')

      // The engine asks for the block after the data that fills the store, which the download would have read next.
      await rig.downloader.fetchNow({ start: 5 * MIB, end: 6 * MIB })
      expect(store.held().ranges()).toEqual([{ start: 0, end: 6 * MIB }])

      // The position makes room for both: the first gap is after them, which is the download going on.
      rig.downloader.setPosition(4 * MIB)
      await until(() => server.requests.length === 3)
      expect(server.requests[2]).toEqual({ range: `bytes=${6 * MIB}-` })
      expect(ofType(rig.events, 'restart')).toEqual([])
    })

    it('says that it restarted when the position makes room and the download goes on at another place', async () => {
      const size = 12 * MIB
      const server = await serve({ size })
      const store = memoryStore(size, 4 * MIB)
      const rig = build({ url: server.url, store })
      rig.downloader.start()
      await until(() => rig.downloader.state() === 'full')

      // The position goes past the data that is held: the block that waited takes a slot, and the read begins at the position.
      rig.downloader.setPosition(9 * MIB)
      await until(() => server.requests.length === 2)
      expect(server.requests[1]).toEqual({ range: `bytes=${9 * MIB}-` })
      expect(ofType(rig.events, 'restart')).toEqual([
        { type: 'restart', offset: 9 * MIB, reason: 'seek' },
      ])
    })
  })

  describe('a read far from the position in a full store', () => {
    /** A file of 32 MiB over a store of 8 MiB, read from the start until the store is full: it holds [0, 9) MiB with the block at 8 MiB waiting, and the position is at 0. */
    async function fullAtStart(): Promise<{ rig: Rig; store: SpyStore; server: RangeServer }> {
      const size = 32 * MIB
      const server = await serve({ size })
      const store = memoryStore(size, 8 * MIB)
      const rig = build({ url: server.url, store })
      rig.downloader.start()
      await until(() => rig.downloader.state() === 'full')
      await settle()
      expect(store.held().ranges()).toEqual([{ start: 0, end: 9 * MIB }])
      return { rig, store, server }
    }

    it('answers a read of two blocks beyond the first gap at once, with one request, the right bytes, and no retry', async () => {
      const { rig, store, server } = await fullAtStart()
      const requests = server.requests.length
      const events = rig.events.length

      const began = performance.now()
      const bytes = await Promise.race([
        rig.downloader.read({ start: 20 * MIB, end: 22 * MIB }),
        sleep(1000).then(() => null),
      ])
      // A read that the store lets go of block by block would go on for ever: this one is answered, and well within a second.
      expect(bytes).not.toBeNull()
      expect(performance.now() - began).toBeLessThan(1000)
      expect(Buffer.compare(bytes ?? new Uint8Array(0), bytesOf(20 * MIB, 22 * MIB))).toBe(0)
      const made = server.requests.slice(requests)
      expect(made.length).toBeLessThanOrEqual(4)
      expect(made[0]).toEqual({ range: `bytes=${20 * MIB}-${22 * MIB - 1}` })
      const after = rig.events.slice(events)
      expect(ofType(after, 'retry')).toEqual([])
      expect(ofType(after, 'error')).toEqual([])
      // The download is as it was: stopped for the block near the position, and the far blocks do not change that.
      expect(ofType(after, 'storeFull')).toEqual([])
      expect(rig.downloader.state()).toBe('full')
      expect(store.held().ranges()).toEqual([
        { start: 0, end: 9 * MIB },
        { start: 20 * MIB, end: 22 * MIB },
      ])
      await expectHeldBytesRight(store)
    })

    it('answers a read of one block beyond the first gap, and does not count its bytes as let go of', async () => {
      const { rig, store, server } = await fullAtStart()
      const requests = server.requests.length
      const events = rig.events.length

      const bytes = await rig.downloader.read({ start: 20 * MIB, end: 21 * MIB })

      expect(Buffer.compare(bytes, bytesOf(20 * MIB, 21 * MIB))).toBe(0)
      expect(server.requests.slice(requests)).toEqual([
        { range: `bytes=${20 * MIB}-${21 * MIB - 1}` },
      ])
      // The store did not let go of the bytes as soon as it had them, so there is no failure and no pause.
      const after = rig.events.slice(events)
      expect(ofType(after, 'retry')).toEqual([])
      expect(ofType(after, 'error')).toEqual([])
      expect(ofType(after, 'requestEnd').map((end) => end.outcome)).toEqual(['done'])
      expect(store.held().has({ start: 20 * MIB, end: 21 * MIB })).toBe(true)
    })

    it('answers a fetchNow for the end of the file the same way, and goes on at the position when it moves', async () => {
      const { rig, store, server } = await fullAtStart()
      const requests = server.requests.length

      await rig.downloader.fetchNow({ start: 30 * MIB, end: 32 * MIB })
      expect(store.held().has({ start: 30 * MIB, end: 32 * MIB })).toBe(true)
      expect(server.requests.length - requests).toBeLessThanOrEqual(4)

      // The position goes on, and makes room for the block that waits near it; the far blocks are no hindrance, and the read goes on where it stopped.
      rig.downloader.setPosition(5 * MIB)
      await until(() => server.requests.length === requests + 2, 2000)
      expect(server.requests[requests + 1]).toEqual({ range: `bytes=${9 * MIB}-${30 * MIB - 1}` })
      expect(ofType(rig.events, 'restart')).toEqual([])
      expect(ofType(rig.events, 'retry')).toEqual([])
      expect(ofType(rig.events, 'error')).toEqual([])
    })

    it('does not stop for the block of a read ahead of the position that waits while the gap at the seek is open', async () => {
      const size = 40 * MIB
      const store = memoryStore(size, 4 * MIB)
      const stub = stubNetwork((call) => pipeFor(call, size))
      const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

      rig.downloader.setPosition(20 * MIB)
      rig.downloader.start()
      await until(() => stub.pipes.length === 1)
      // The read at 20 MiB fills the four slots of the store.
      stub.pipes[0]?.push(20 * MIB, 24 * MIB)
      await until(() => store.held().heldFrom(20 * MIB) === 4 * MIB)
      expect(rig.downloader.state()).toBe('reading')

      // A seek back: the read ahead of the position goes on, and a second read opens at the seek.
      rig.downloader.setPosition(5 * MIB)
      await until(() => stub.pipes.length === 2)
      expect(stub.calls[1]).toMatchObject({ from: 5 * MIB, to: 20 * MIB - 1 })

      // The read ahead brings its next block, which finds no slot (no block is farther from the position than it is) and waits. It is farther than the gap at the seek, so the store is not full on its account.
      stub.pipes[0]?.push(24 * MIB, 25 * MIB)
      await until(() => store.held().heldFrom(20 * MIB) === 5 * MIB)
      await settle()
      expect(rig.downloader.state()).toBe('reading')
      expect(ofType(rig.events, 'storeFull')).toEqual([])
      expect(stub.calls.map((call) => call.signal.aborted)).toEqual([false, false])

      // The read at the seek brings its block, which takes the slot of the block farthest from the position.
      stub.pipes[1]?.push(5 * MIB, 6 * MIB)
      await until(() => store.held().has({ start: 5 * MIB, end: 6 * MIB }))
      expect(store.held().has({ start: 23 * MIB, end: 24 * MIB })).toBe(false)
      expect(rig.downloader.state()).toBe('reading')
      expect(ofType(rig.events, 'restart')).toEqual([
        { type: 'restart', offset: 5 * MIB, reason: 'seek' },
      ])
    })
  })

  /**
   * 50 seeks to seeded random places, 5 ms apart, on a server that is slow enough for the
   * reads to overlap; then the position stops and the download is waited for. With
   * `fetchBytes` the engine also asks for that many bytes at each target with `fetchNow`
   * before it moves the position there, and calls the request off, with its signal, at the
   * next seek: the reads of a call that is aborted while it waits must all be over by the time
   * `abort` returns. Answers what the tests below look at.
   */
  async function storm(
    size: number,
    fetchBytes = 0,
  ): Promise<{
    rig: Rig
    store: SpyStore
    position: number
    /** The most onward reads that were open at once. */
    mostOpen: number
    /** How many calls were aborted while they waited, with a read of their own that the abort ended. */
    calledOff: number
    /** The last call, which is not aborted. */
    last: { range: ByteRange; outcome: Outcome; ids: number[] } | null
  }> {
    const server = await serve({ size, chunkDelayMs: 2 })
    const store = memoryStore(size, 32 * MIB)
    const open = new Set<number>()
    const priority = new Set<number>()
    // Set while `fetchNow` is called: the requests it sends, it sends within the call.
    let asking = false
    let mostOpen = 0
    const rig = build({
      url: server.url,
      store,
      onEvent: (event) => {
        if (event.type === 'request') {
          open.add(event.id)
          if (asking) priority.add(event.id)
        }
        if (event.type === 'requestEnd') open.delete(event.id)
        let onward = 0
        for (const id of open) if (!priority.has(id)) onward += 1
        mostOpen = Math.max(mostOpen, onward)
      },
    })
    const next = generator(2024)
    rig.downloader.start()
    let position = 0
    let calledOff = 0
    let previous: {
      range: ByteRange
      controller: AbortController
      outcome: Outcome
      ids: number[]
    } | null = null
    for (let seek = 0; seek < 50; seek += 1) {
      position = Math.floor(next() * size)
      if (fetchBytes > 0) {
        if (previous !== null) {
          const waiting = previous.outcome.state === 'pending'
          previous.controller.abort(new Error('the engine moved on'))
          if (waiting && previous.ids.length > 0) {
            calledOff += 1
            for (const id of previous.ids) expect(open.has(id)).toBe(false)
          }
        }
        const range = { start: position, end: Math.min(position + fetchBytes, size) }
        const controller = new AbortController()
        const before = rig.events.length
        asking = true
        const outcome = track(rig.downloader.fetchNow(range, controller.signal))
        asking = false
        const ids = ofType(rig.events.slice(before), 'request').map((request) => request.id)
        previous = { range, controller, outcome, ids }
      }
      rig.downloader.setPosition(position)
      await sleep(5)
    }
    // The position stops: everything from it to the end comes.
    await until(() => rig.downloader.state() === 'done', 20_000)
    const last =
      previous === null
        ? null
        : { range: previous.range, outcome: previous.outcome, ids: previous.ids }
    return { rig, store, position, mostOpen, calledOff, last }
  }

  /** The reads that the last call opened for itself are there, and every one of them ended clean: it needed no retry. */
  async function expectOwnReadsClean(
    rig: Rig,
    last: { range: ByteRange; outcome: Outcome; ids: number[] } | null,
  ): Promise<void> {
    expect(last).not.toBeNull()
    if (last === null) return
    // The last target is far from the reads of the storm: the call opens a read of its own, or two.
    expect(last.ids.length).toBeGreaterThan(0)
    const ended = (): EventOf<'requestEnd'>[] =>
      ofType(rig.events, 'requestEnd').filter((end) => last.ids.includes(end.id))
    await until(() => ended().length === last.ids.length)
    expect(ended().map((end) => end.outcome)).toEqual(last.ids.map(() => 'done'))
  }

  it('keeps two onward reads in a storm of seeks over a file the frontier can hold, and loses and brings nothing twice', async () => {
    const size = 8 * MIB
    const { rig, store, position, mostOpen } = await storm(size)

    expect(mostOpen).toBe(2)
    expect(ofType(rig.events, 'error')).toEqual([])
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(store.held().heldFrom(position)).toBe(size - position)
    await expectHeldBytesRight(store)
    // No byte was brought twice, and nothing was let go of.
    const writes = [...store.writes].sort((a, b) => a.offset - b.offset)
    writes.forEach((write, index) => {
      const previous = writes[index - 1]
      if (previous !== undefined)
        expect(write.offset).toBeGreaterThanOrEqual(previous.offset + previous.length)
    })
    expect(store.evictions).toEqual([])
    expect(ofType(rig.events, 'restart').length).toBeGreaterThan(5)
  }, 30_000)

  it('keeps two onward reads in a storm of seeks over a file with more blocks than the frontier holds, and ends with the right bytes', async () => {
    const size = 16 * MIB
    const { rig, store, position, mostOpen } = await storm(size)

    expect(mostOpen).toBe(2)
    // A read far from the position can find the frontier full of the partial blocks that the reads which yielded left nearer to it: the store refuses that write by its own rule, and the read ends quietly (R48). Nothing is told as an error and nothing is retried after a pause.
    expect(ofType(rig.events, 'error')).toEqual([])
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(store.held().heldFrom(position)).toBe(size - position)
    await expectHeldBytesRight(store)
  }, 30_000)

  it('calls off the read of each target the engine leaves in a storm of seeks that ask for a range at each, and answers the last target with no retry', async () => {
    const size = 8 * MIB
    const { rig, store, position, mostOpen, calledOff, last } = await storm(size, 512 * 1024 + 1)

    expect(mostOpen).toBeLessThanOrEqual(2)
    // The storm did call reads off.
    expect(calledOff).toBeGreaterThan(10)
    expect(last).not.toBeNull()
    await until(() => last?.outcome.state !== 'pending')
    expect(last?.outcome.state).toBe('held')
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(ofType(rig.events, 'error')).toEqual([])
    await expectOwnReadsClean(rig, last)
    if (last !== null) expect(await firstMismatch(store, last.range)).toBe(-1)
    expect(store.held().heldFrom(position)).toBe(size - position)
    await expectHeldBytesRight(store)
    expect(store.evictions).toEqual([])
  }, 30_000)

  it('does the same in a storm of seeks over a file with more blocks than the frontier holds: the last target is answered with no retry of its own', async () => {
    const size = 16 * MIB
    const { rig, store, position, mostOpen, calledOff, last } = await storm(size, 512 * 1024 + 1)

    expect(mostOpen).toBeLessThanOrEqual(2)
    expect(calledOff).toBeGreaterThan(10)
    expect(last).not.toBeNull()
    await until(() => last?.outcome.state !== 'pending')
    expect(last?.outcome.state).toBe('held')
    // A read far from the position can still be refused a write by the frontier; it ends quietly (R48), and the last target's own reads end clean too.
    expect(ofType(rig.events, 'error')).toEqual([])
    expect(ofType(rig.events, 'retry')).toEqual([])
    await expectOwnReadsClean(rig, last)
    if (last !== null) expect(await firstMismatch(store, last.range)).toBe(-1)
    expect(store.held().heldFrom(position)).toBe(size - position)
    await expectHeldBytesRight(store)
  }, 30_000)
})

describe('Downloader: fetchNow', () => {
  it('opens a read at once for the last 64 KiB of a file while the onward read is at the start, and is answered before the onward read gets there', async () => {
    // The onward read is slow (the first request is); the priority read is not.
    vi.useRealTimers()
    const size = 64 * MIB
    const server = await serve({ size, faults: [{ kind: 'delay', ms: 20 }] })
    const store = memoryStore(size)
    const rig = build({ url: server.url, store })
    rig.downloader.start()
    await until(() => store.held().heldFrom(0) > 0)

    const last = { start: size - 64 * 1024, end: size }
    await rig.downloader.fetchNow(last)

    expect(server.requests).toEqual([
      { range: 'bytes=0-' },
      { range: `bytes=${last.start}-${size - 1}` },
    ])
    expect(await firstMismatch(store, last)).toBe(-1)
    // The onward read is near the start still, and open.
    expect(store.held().heldFrom(0)).toBeLessThan(8 * MIB)
    expect(rig.downloader.state()).toBe('reading')
    await until(() => ofType(rig.events, 'requestEnd').length === 1)
    expect(ofType(rig.events, 'request')[1]).toEqual({
      type: 'request',
      id: 2,
      from: last.start,
      to: size - 1,
    })
    expect(ofType(rig.events, 'firstByte')).toContainEqual({ type: 'firstByte', id: 2 })
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 2, bytes: 64 * 1024, outcome: 'done', message: null },
    ])
    // Asking for it is not a seek.
    expect(ofType(rig.events, 'restart')).toEqual([])
  })

  it('opens a read for each gap of the range, before the downloader starts, and is answered when all are held', async () => {
    const size = 8 * MIB
    const store = memoryStore(size)
    await store.write(MIB, bytesOf(MIB, 2 * MIB))
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    const waiting = rig.downloader.fetchNow({ start: 0, end: 3 * MIB })
    await until(() => stub.pipes.length === 2)

    expect(stub.calls.map((call) => [call.from, call.to])).toEqual([
      [0, MIB - 1],
      [2 * MIB, 3 * MIB - 1],
    ])
    expect(ofType(rig.events, 'request')).toEqual([
      { type: 'request', id: 1, from: 0, to: MIB - 1 },
      { type: 'request', id: 2, from: 2 * MIB, to: 3 * MIB - 1 },
    ])
    let answered = false
    void waiting.then(() => {
      answered = true
    })
    stub.pipes[0]?.push(0, MIB)
    stub.pipes[0]?.end()
    await until(() => store.held().has({ start: 0, end: 2 * MIB }))
    await settle()
    expect(answered).toBe(false)

    stub.pipes[1]?.push(2 * MIB, 3 * MIB)
    stub.pipes[1]?.end()
    await waiting
    expect(await firstMismatch(store, { start: 0, end: 3 * MIB })).toBe(-1)
    await until(() => ofType(rig.events, 'requestEnd').length === 2)
    expect(ofType(rig.events, 'requestEnd').map((end) => end.outcome)).toEqual(['done', 'done'])
    // The range is held: asking again opens nothing.
    await rig.downloader.fetchNow({ start: 0, end: 3 * MIB })
    expect(stub.calls).toHaveLength(2)
    // A range of no bytes is held too.
    await rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB })
    expect(stub.calls).toHaveLength(2)
  })

  it.each([
    ['the next byte of a read', 0, 1],
    ['a block past the next byte of a read', BLOCK_BYTES, 1],
    ['more than a block past the next byte of a read', BLOCK_BYTES + 1, 2],
  ])(
    'opens a read for a gap that starts at %s only if no read covers it',
    async (_name, start, calls) => {
      const size = 8 * MIB
      const store = memoryStore(size)
      const stub = stubNetwork((call) => pipeFor(call, size))
      const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
      rig.downloader.start()
      await until(() => stub.pipes.length === 1)

      const waiting = rig.downloader.fetchNow({ start, end: start + 100 })
      await settle()
      expect(stub.calls).toHaveLength(calls)

      // Whichever read brings it, the wait is answered.
      stub.pipes[calls - 1]?.push(calls === 1 ? 0 : start, start + 100)
      await waiting
      expect(await firstMismatch(store, { start, end: start + 100 })).toBe(-1)
    },
  )

  it('does not count a gap as covered by a read that stops before it', async () => {
    const size = 8 * MIB
    const store = memoryStore(size)
    // 100 KiB to 200 KiB is held, so the onward read is of the 100 KiB before it and stops there.
    await store.write(100 * 1024, bytesOf(100 * 1024, 200 * 1024))
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    expect(stub.calls[0]).toMatchObject({ from: 0, to: 100 * 1024 - 1 })

    // The last byte of that read is covered by it; the byte after the held data is not, though it is within a block of the read.
    const covered = rig.downloader.fetchNow({ start: 100 * 1024 - 1, end: 100 * 1024 + 50 })
    await settle()
    expect(stub.calls).toHaveLength(1)
    const beyond = rig.downloader.fetchNow({ start: 200 * 1024, end: 200 * 1024 + 100 })
    await until(() => stub.pipes.length === 2)
    expect(stub.calls[1]).toMatchObject({ from: 200 * 1024, to: 200 * 1024 + 99 })

    stub.pipes[0]?.push(0, 100 * 1024)
    stub.pipes[1]?.push(200 * 1024, 200 * 1024 + 100)
    await Promise.all([covered, beyond])
  })

  it('is rejected with the ReadError when the play fails, and so is every later call', async () => {
    const size = 8 * MIB
    const stub = stubNetwork((call) => (call.index === 1 ? refusal(404) : pipeFor(call, size)))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)

    const waiting = rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 })
    const watching = rig.downloader.whenHeld({ start: 6 * MIB, end: 6 * MIB + 100 })
    const settled = await Promise.allSettled([waiting, watching])
    const failure = rig.downloader.failure()
    expect(failure).toBeInstanceOf(ReadError)
    expect(failure?.fatal).toBe(true)
    expect(failure?.status).toBe(404)
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(
      settled.map((outcome) =>
        outcome.status === 'rejected' ? (outcome.reason as unknown) : null,
      ),
    ).toEqual([failure, failure])
    await expect(rig.downloader.fetchNow({ start: 0, end: 10 })).rejects.toBe(failure)
    await expect(rig.downloader.whenHeld({ start: 0, end: 10 })).rejects.toBe(failure)
    // The play is over: the onward read was let go of, and nothing is left running.
    expect(rig.downloader.state()).toBe('failed')
    expect(stub.calls[0]?.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(ofType(rig.events, 'error')).toHaveLength(1)
  })

  it('is rejected when the downloader closes first, and so is every later call', async () => {
    const size = 8 * MIB
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    const waiting = rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 })
    const watching = rig.downloader.whenHeld({ start: 6 * MIB, end: 6 * MIB + 100 })
    await until(() => stub.pipes.length === 2)

    const settled = Promise.allSettled([waiting, watching])
    await rig.downloader.close()

    for (const outcome of await settled) {
      expect(outcome.status).toBe('rejected')
      expect(outcome.status === 'rejected' ? (outcome.reason as unknown) : null).toMatchObject({
        name: 'StoreError',
        kind: 'closed',
      })
    }
    for (const attempt of [
      rig.downloader.fetchNow({ start: 0, end: 10 }),
      rig.downloader.whenHeld({ start: 0, end: 10 }),
    ]) {
      await expect(attempt).rejects.toMatchObject({ name: 'StoreError', kind: 'closed' })
    }
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([true, true])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a range that is not within the file', async () => {
    const size = 2 * MIB
    const rig = build({ url: 'http://stub.invalid/file', store: memoryStore(size) })
    for (const range of [
      { start: -1, end: 10 },
      { start: 10, end: 5 },
      { start: 0, end: size + 1 },
      { start: 0.5, end: 10 },
      { start: 0, end: Number.NaN },
    ]) {
      await expect(rig.downloader.fetchNow(range)).rejects.toBeInstanceOf(RangeError)
      await expect(rig.downloader.whenHeld(range)).rejects.toBeInstanceOf(RangeError)
      await expect(rig.downloader.read(range)).rejects.toBeInstanceOf(RangeError)
    }
  })

  it('retries a priority read with a pause and a count of its own, while the onward read has its own', async () => {
    const size = 8 * MIB
    // The onward read is refused once; the priority read is refused once too, and neither is the second failure of the other.
    const stub = stubNetwork((call) => {
      if (call.index === 0) return refusal(503)
      if (call.index === 1) return refusal(503)
      return pipeFor(call, size)
    })
    const store = memoryStore(size)
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    rig.downloader.start()
    await until(() => rig.downloader.state() === 'waiting')

    const waiting = rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 })
    await until(() => ofType(rig.events, 'retry').length === 2)

    expect(ofType(rig.events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: 500, offset: 0 },
      { type: 'retry', attempt: 1, delayMs: 500, offset: 5 * MIB },
    ])
    expect(stub.calls).toHaveLength(2)
    // Two pauses, side by side.
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => stub.pipes.length === 2)
    expect(stub.calls.map((call) => call.from)).toEqual([0, 5 * MIB, 0, 5 * MIB])

    stub.pipes[1]?.push(5 * MIB, 5 * MIB + 100)
    await waiting
    expect(await firstMismatch(store, { start: 5 * MIB, end: 5 * MIB + 100 })).toBe(-1)
  })

  it('counts the pause of a priority read again from the base after a read of the same wait ended clean', async () => {
    const size = 8 * MIB
    const store = memoryStore(size)
    await store.write(MIB, bytesOf(MIB, 2 * MIB))
    // The wait has two gaps, so two reads: the second is refused twice, and the first ends clean between the two.
    const stub = stubNetwork((call) =>
      call.index === 1 || call.index === 2 ? refusal(503) : pipeFor(call, size),
    )
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    const waiting = rig.downloader.fetchNow({ start: 0, end: 3 * MIB })
    void waiting.catch(() => undefined)
    await until(() => ofType(rig.events, 'retry').length === 1)
    stub.pipes[0]?.push(0, MIB)
    stub.pipes[0]?.end()
    await until(() => ofType(rig.events, 'requestEnd').some((end) => end.outcome === 'done'))
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => ofType(rig.events, 'retry').length === 2)

    expect(ofType(rig.events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: 500, offset: 2 * MIB },
      { type: 'retry', attempt: 1, delayMs: 500, offset: 2 * MIB },
    ])
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => stub.pipes.length === 2)
    stub.pipes[1]?.push(2 * MIB, 3 * MIB)
    await waiting
  })

  it('goes on reading onward while a priority read waits out a failure', async () => {
    const size = 8 * MIB
    const stub = stubNetwork((call) =>
      call.index === 1 ? refusal(503, '20') : pipeFor(call, size),
    )
    const store = memoryStore(size)
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)

    void rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 }).catch(() => undefined)
    await until(() => ofType(rig.events, 'retry').length === 1)

    // The pause of the priority read does not stop the onward read, nor change what the downloader is doing.
    expect(rig.downloader.state()).toBe('reading')
    stub.pipes[0]?.push(0, MIB)
    await until(() => store.held().heldFrom(0) === MIB)
    expect(stub.calls).toHaveLength(2)
  })

  it('retries a priority read that the store refused with a RangeError', async () => {
    const size = 8 * MIB
    const stub = stubNetwork((call) => pipeFor(call, size))
    const store = memoryStore(size)
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    store.failNextWrite = new RangeError('the frontier is full')

    const waiting = rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 })
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(5 * MIB, 5 * MIB + 100)
    await until(() => ofType(rig.events, 'retry').length === 1)

    expect(ofType(rig.events, 'error')).toEqual([
      expect.objectContaining({ from: 'engine', code: null }),
    ])
    expect(ofType(rig.events, 'requestEnd')[0]?.outcome).toBe('failed')
    expect(ofType(rig.events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: 500, offset: 5 * MIB },
    ])
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => stub.pipes.length === 2)
    stub.pipes[1]?.push(5 * MIB, 5 * MIB + 100)
    await waiting
    expect(await firstMismatch(store, { start: 5 * MIB, end: 5 * MIB + 100 })).toBe(-1)
  })

  it('cuts the pause of a priority read short on online, and on a return to the page only with the network up', async () => {
    const size = 8 * MIB
    const stub = stubNetwork((call) =>
      call.index === 0 ? refusal(503, '20') : pipeFor(call, size),
    )
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })
    rig.connectivity.isOnline = false

    void rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 }).catch(() => undefined)
    await until(() => ofType(rig.events, 'retry').length === 1)
    expect(rig.connectivity.listeners()).toBe(2)

    rig.connectivity.fireVisible()
    await settle()
    expect(stub.calls).toHaveLength(1)

    rig.connectivity.isOnline = true
    rig.connectivity.fireOnline()
    await until(() => stub.calls.length === 2)
    // The pause's listeners are gone; the reopened read has the downloader's own two.
    expect(rig.connectivity.listeners()).toBe(2)
  })

  it('does not read a range again in a tight loop when the store lets go of it at once', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    store.forget = true
    const stub = stubNetwork((call) => wholeRange(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    const waiting = rig.downloader.fetchNow({ start: 2 * MIB, end: 2 * MIB + 1000 })
    await until(() => ofType(rig.events, 'retry').length === 1)
    await settle()

    // The bytes came and were let go of: the next try is after a pause, as after any failure.
    expect(stub.calls).toHaveLength(1)
    expect(ofType(rig.events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: 500, offset: 2 * MIB },
    ])
    expect(ofType(rig.events, 'error')).toEqual([
      expect.objectContaining({ from: 'engine', code: null }),
    ])
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => ofType(rig.events, 'retry').length === 2)
    expect(stub.calls).toHaveLength(2)
    expect(ofType(rig.events, 'retry')[1]).toMatchObject({ attempt: 2, delayMs: 1000 })

    // The store keeps what it is given: the next try is the last.
    store.forget = false
    await vi.advanceTimersByTimeAsync(1000)
    await waiting
    expect(stub.calls).toHaveLength(3)
  })

  it('is answered by an onward read that brings the range, with no read of its own', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    const waiting = rig.downloader.fetchNow({ start: 0, end: 500 })
    await settle()
    expect(stub.calls).toHaveLength(1)

    stub.pipes[0]?.push(0, 100)
    await settle()
    stub.pipes[0]?.push(100, 600)
    await waiting
    expect(stub.calls).toHaveLength(1)
  })
})

describe('Downloader: calling off a priority read', () => {
  const KIB = 1024
  const size = 32 * MIB

  /** A downloader on a stub whose every read is a pipe that the test feeds; it has not started. */
  function stubbed(
    options: {
      store?: SpyStore
      answer?: (call: StubCall) => Answer
      now?: () => number
    } = {},
  ): { rig: Rig; stub: Stub; store: SpyStore } {
    const store = options.store ?? memoryStore(size)
    const stub = stubNetwork(options.answer ?? ((call) => pipeFor(call, size)))
    const rig = build({
      url: 'http://stub.invalid/file',
      store,
      fetch: stub.fetch,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    return { rig, stub, store }
  }

  const targets = [4, 8, 12, 16, 20].map((block) => ({
    start: block * MIB,
    end: block * MIB + 200 * KIB,
  }))

  it('leaves only the read of the last target open when each call is aborted by the next, and answers it with no retry', async () => {
    const { rig, stub } = stubbed()
    const reasons = targets.map((_range, index) => new Error(`target ${index} was left`))
    const controllers = targets.map(() => new AbortController())
    const outcomes: Outcome[] = []
    for (const [index, range] of targets.entries()) {
      // The engine calls the last one off as it asks for the next.
      controllers[index - 1]?.abort(reasons[index - 1])
      outcomes.push(track(rig.downloader.fetchNow(range, controllers[index]?.signal)))
      await until(() => stub.calls.length === index + 1)
    }
    await settle()

    expect(ofType(rig.events, 'request').map((request) => request.from)).toEqual(
      targets.map((range) => range.start),
    )
    expect(ofType(rig.events, 'requestEnd')).toEqual(
      [1, 2, 3, 4].map((id) => ({
        type: 'requestEnd',
        id,
        bytes: 0,
        outcome: 'aborted',
        message: null,
      })),
    )
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([true, true, true, true, false])
    expect(outcomes.map((outcome) => outcome.state)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'pending',
    ])
    // Each is rejected with the reason of its own signal.
    reasons.slice(0, 4).forEach((reason, index) => {
      expect(outcomes[index]?.reason).toBe(reason)
    })

    const last = targets[4]
    if (last === undefined) throw new Error('five targets')
    stub.pipes[4]?.push(last.start, last.end)
    stub.pipes[4]?.end()
    await until(() => outcomes[4]?.state === 'held')
    await until(() => ofType(rig.events, 'requestEnd').length === 5)
    expect(ofType(rig.events, 'requestEnd')[4]).toMatchObject({ id: 5, outcome: 'done' })
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(ofType(rig.events, 'error')).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('calls off every read that a call asked for in the same turn as the next, and answers the last', async () => {
    const { rig, stub } = stubbed()
    const controllers = targets.map(() => new AbortController())
    const outcomes: Outcome[] = []
    for (const [index, range] of targets.entries()) {
      controllers[index - 1]?.abort(new Error('left'))
      outcomes.push(track(rig.downloader.fetchNow(range, controllers[index]?.signal)))
    }
    await until(() => stub.calls.some((call) => !call.signal.aborted))
    await settle()

    // Every request that was made is called off but the last target's.
    expect(stub.calls.filter((call) => !call.signal.aborted).map((call) => call.from)).toEqual([
      20 * MIB,
    ])
    expect(ofType(rig.events, 'request')).toHaveLength(5)
    expect(ofType(rig.events, 'requestEnd').map((end) => end.outcome)).toEqual([
      'aborted',
      'aborted',
      'aborted',
      'aborted',
    ])
    expect(ofType(rig.events, 'firstByte').every((event) => event.id === 5)).toBe(true)
    expect(outcomes.filter((outcome) => outcome.state === 'rejected')).toHaveLength(4)
    const index = stub.calls.findIndex((call) => !call.signal.aborted)
    stub.pipes[index]?.push(20 * MIB, 20 * MIB + 200 * KIB)
    await until(() => outcomes[4]?.state === 'held')
    expect(ofType(rig.events, 'retry')).toEqual([])
  })

  it('leaves the onward read alone when a priority read is called off', async () => {
    const { rig, stub, store } = stubbed()
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    const controller = new AbortController()
    const reason = new Error('the engine moved on')
    const outcome = track(
      rig.downloader.fetchNow({ start: 20 * MIB, end: 20 * MIB + 200 * KIB }, controller.signal),
    )
    await until(() => stub.pipes.length === 2)

    controller.abort(reason)
    await settle()

    expect(outcome).toEqual({ state: 'rejected', reason })
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([false, true])
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 2, bytes: 0, outcome: 'aborted', message: null },
    ])
    expect(rig.downloader.state()).toBe('reading')
    // The onward read goes on: a piece is written.
    stub.pipes[0]?.push(0, 100 * KIB)
    await until(() => store.held().has({ start: 0, end: 100 * KIB }))
  })

  it('keeps a read that another call still waits on, and answers that call', async () => {
    const { rig, stub, store } = stubbed()
    const controller = new AbortController()
    const reason = new Error('the first call was left')
    const first = track(
      rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 300 * KIB }, controller.signal),
    )
    await until(() => stub.pipes.length === 1)
    // The second range begins where the read will be: it opens nothing of its own, and counts on that read.
    const second = track(
      rig.downloader.fetchNow({ start: 5 * MIB + 100 * KIB, end: 5 * MIB + 200 * KIB }),
    )
    await settle()
    expect(stub.calls).toHaveLength(1)

    controller.abort(reason)
    await settle()

    expect(first).toEqual({ state: 'rejected', reason })
    expect(second.state).toBe('pending')
    expect(stub.calls[0]?.signal.aborted).toBe(false)
    expect(ofType(rig.events, 'requestEnd')).toEqual([])
    stub.pipes[0]?.push(5 * MIB, 5 * MIB + 300 * KIB)
    await until(() => second.state === 'held')
    expect(await firstMismatch(store, { start: 5 * MIB, end: 5 * MIB + 300 * KIB })).toBe(-1)
    expect(stub.calls).toHaveLength(1)
  })

  it.each([
    ['the first call, then the second', 0],
    ['the second call, then the first', 1],
  ])(
    'calls the read off when the last of the calls that wait on it is aborted: %s',
    async (_order, firstToAbort) => {
      const { rig, stub } = stubbed()
      const controllers = [new AbortController(), new AbortController()]
      const reasons = [new Error('the first was left'), new Error('the second was left')]
      const outcomes = [
        track(
          rig.downloader.fetchNow(
            { start: 5 * MIB, end: 5 * MIB + 300 * KIB },
            controllers[0]?.signal,
          ),
        ),
        track(
          rig.downloader.fetchNow(
            { start: 5 * MIB + 100 * KIB, end: 5 * MIB + 200 * KIB },
            controllers[1]?.signal,
          ),
        ),
      ]
      await until(() => stub.pipes.length === 1)
      await settle()
      expect(stub.calls).toHaveLength(1)

      const early = firstToAbort
      const late = 1 - firstToAbort
      controllers[early]?.abort(reasons[early])
      await settle()
      expect(stub.calls[0]?.signal.aborted).toBe(false)
      expect(ofType(rig.events, 'requestEnd')).toEqual([])

      controllers[late]?.abort(reasons[late])
      await settle()
      expect(stub.calls[0]?.signal.aborted).toBe(true)
      expect(ofType(rig.events, 'requestEnd')).toEqual([
        { type: 'requestEnd', id: 1, bytes: 0, outcome: 'aborted', message: null },
      ])
      expect(outcomes[0]?.reason).toBe(reasons[0])
      expect(outcomes[1]?.reason).toBe(reasons[1])
      expect(ofType(rig.events, 'retry')).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('calls off every read that was made for a call, one for each part of its range that was not held', async () => {
    const store = memoryStore(size)
    // 100 KiB to 300 KiB of the range is held: the call reads the 100 KiB before it and the 200 KiB after it.
    await store.write(5 * MIB + 100 * KIB, bytesOf(5 * MIB + 100 * KIB, 5 * MIB + 300 * KIB))
    const { rig, stub } = stubbed({ store })
    const controller = new AbortController()
    const reason = new Error('left')
    const outcome = track(
      rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 500 * KIB }, controller.signal),
    )
    await until(() => stub.pipes.length === 2)
    expect(stub.calls.map((call) => [call.from, call.to])).toEqual([
      [5 * MIB, 5 * MIB + 100 * KIB - 1],
      [5 * MIB + 300 * KIB, 5 * MIB + 500 * KIB - 1],
    ])

    controller.abort(reason)
    await settle()

    expect(outcome).toEqual({ state: 'rejected', reason })
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([true, true])
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: 0, outcome: 'aborted', message: null },
      { type: 'requestEnd', id: 2, bytes: 0, outcome: 'aborted', message: null },
    ])
  })

  it('calls off a read that has gone quiet and the read that was opened beside it for the same bytes, when the last call that waits for them is aborted', async () => {
    const { rig, stub } = stubbed({ now: () => Date.now() })
    const range = { start: 5 * MIB, end: 5 * MIB + 200 * KIB }
    const first = new AbortController()
    const second = new AbortController()
    const reasons = [new Error('the first was left'), new Error('the second was left')]
    const outcomes = [
      track(rig.downloader.fetchNow(range, first.signal)),
      // The first call's read covers where this one begins, so it opens none: a look is set for when that read will have been quiet for STALL_COVER_MS.
      track(rig.downloader.fetchNow(range, second.signal)),
    ]
    await until(() => stub.pipes.length === 1)
    await settle()
    expect(stub.calls).toHaveLength(1)

    // The read says nothing: the second call gets a read of its own for the same bytes.
    await vi.advanceTimersByTimeAsync(STALL_COVER_MS + 2)
    await until(() => stub.pipes.length === 2)
    expect(stub.calls.map((call) => [call.from, call.to])).toEqual([
      [5 * MIB, 5 * MIB + 200 * KIB - 1],
      [5 * MIB, 5 * MIB + 200 * KIB - 1],
    ])

    // Each call needs the bytes of both reads, so the first to go leaves both open.
    first.abort(reasons[0])
    await settle()
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([false, false])
    expect(ofType(rig.events, 'requestEnd')).toEqual([])

    second.abort(reasons[1])
    await settle()
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([true, true])
    expect(ofType(rig.events, 'requestEnd').map((end) => [end.id, end.outcome])).toEqual([
      [1, 'aborted'],
      [2, 'aborted'],
    ])
    expect(outcomes[0]?.reason).toBe(reasons[0])
    expect(outcomes[1]?.reason).toBe(reasons[1])
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hands a read that is kept to the call that still waits, so that its failure is that call’s to retry, after that call’s pause', async () => {
    const { rig, stub, store } = stubbed()
    const controller = new AbortController()
    const first = track(
      rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 300 * KIB }, controller.signal),
    )
    await until(() => stub.pipes.length === 1)
    const second = track(
      rig.downloader.fetchNow({ start: 5 * MIB + 100 * KIB, end: 5 * MIB + 200 * KIB }),
    )
    await settle()
    stub.pipes[0]?.push(5 * MIB, 5 * MIB + 50 * KIB)
    await until(() => store.held().has({ start: 5 * MIB, end: 5 * MIB + 50 * KIB }))
    controller.abort(new Error('left'))
    await settle()
    expect(first.state).toBe('rejected')

    // The read that was kept breaks: the call that is left pauses before it tries again.
    stub.pipes[0]?.fail()
    await until(() => ofType(rig.events, 'retry').length === 1)
    expect(ofType(rig.events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: 5 * MIB + 100 * KIB },
    ])
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1)
    await settle()
    expect(stub.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await until(() => stub.pipes.length === 2)
    expect(stub.calls[1]).toMatchObject({ from: 5 * MIB + 100 * KIB, to: 5 * MIB + 200 * KIB - 1 })
    stub.pipes[1]?.push(5 * MIB + 100 * KIB, 5 * MIB + 200 * KIB)
    await until(() => second.state === 'held')
    expect(
      await firstMismatch(store, { start: 5 * MIB + 100 * KIB, end: 5 * MIB + 200 * KIB }),
    ).toBe(-1)
  })

  it('does not keep a read for a wait that only watches: whenHeld opens no read and is no reason to keep one', async () => {
    const { rig, stub } = stubbed()
    const controller = new AbortController()
    const range = { start: 5 * MIB, end: 5 * MIB + 200 * KIB }
    const priority = track(rig.downloader.fetchNow(range, controller.signal))
    await until(() => stub.pipes.length === 1)
    const watching = track(rig.downloader.whenHeld(range))
    await settle()

    controller.abort(new Error('left'))
    await settle()

    expect(priority.state).toBe('rejected')
    expect(watching.state).toBe('pending')
    expect(stub.calls[0]?.signal.aborted).toBe(true)
  })

  it('ends the wait of a call that is aborted in a pause: no read is opened when the pause would have ended', async () => {
    const { rig, stub } = stubbed({
      answer: (call) => (call.index === 0 ? refusal(503) : pipeFor(call, size)),
    })
    const controller = new AbortController()
    const reason = new Error('left')
    const outcome = track(
      rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 200 * KIB }, controller.signal),
    )
    await until(() => ofType(rig.events, 'retry').length === 1)
    expect(vi.getTimerCount()).toBe(1)
    expect(rig.connectivity.listeners()).toBe(2)

    controller.abort(reason)
    await settle()

    expect(outcome).toEqual({ state: 'rejected', reason })
    expect(vi.getTimerCount()).toBe(0)
    expect(rig.connectivity.listeners()).toBe(0)
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS)
    await settle()
    expect(stub.calls).toHaveLength(1)
  })

  it('does not leave the downloader without a read when the priority read it was counting on is called off', async () => {
    const { rig, stub } = stubbed()
    const controller = new AbortController()
    // The priority read at the start of the file is what the onward read counts on when the download starts.
    const outcome = track(rig.downloader.fetchNow({ start: 0, end: 100 * KIB }, controller.signal))
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    expect(stub.calls[0]).toMatchObject({ from: 0, to: 100 * KIB - 1 })
    expect(rig.downloader.state()).toBe('reading')

    controller.abort(new Error('left'))
    await until(() => stub.pipes.length === 2)

    expect(outcome.state).toBe('rejected')
    expect(stub.calls[1]).toMatchObject({ from: 0, to: null })
    expect(rig.downloader.state()).toBe('reading')
    expect(ofType(rig.events, 'restart')).toEqual([])
  })

  it('rejects at once with the reason of a signal that has aborted already, and opens no read', async () => {
    const { rig, stub } = stubbed()
    const aborted = AbortSignal.abort(new Error('already'))

    await expect(
      rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 }, aborted),
    ).rejects.toBe(aborted.reason)
    await expect(rig.downloader.read({ start: 5 * MIB, end: 5 * MIB + 100 }, aborted)).rejects.toBe(
      aborted.reason,
    )

    await settle()
    expect(stub.calls).toEqual([])
    expect(ofType(rig.events, 'request')).toEqual([])
  })

  it('lets go of the signal of a call that was answered, and an abort after that changes nothing', async () => {
    const { rig, stub, store } = stubbed()
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = track(
      rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 100 }, controller.signal),
    )
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(5 * MIB, 5 * MIB + 100)
    stub.pipes[0]?.end()
    await until(() => outcome.state === 'held')
    await until(() => ofType(rig.events, 'requestEnd').length === 1)
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    const ends = ofType(rig.events, 'requestEnd')

    controller.abort(new Error('too late'))
    await settle()

    expect(outcome.state).toBe('held')
    expect(ofType(rig.events, 'requestEnd')).toEqual(ends)
    expect(await firstMismatch(store, { start: 5 * MIB, end: 5 * MIB + 100 })).toBe(-1)
  })

  it('calls a read off when the engine aborts the read that waits for it', async () => {
    const { rig, stub } = stubbed()
    const controller = new AbortController()
    const reason = new Error('the engine moved on')
    const outcome = track(
      rig.downloader.read({ start: 5 * MIB, end: 5 * MIB + 200 * KIB }, controller.signal),
    )
    await until(() => stub.pipes.length === 1)

    controller.abort(reason)
    await settle()

    expect(outcome).toEqual({ state: 'rejected', reason })
    expect(stub.calls[0]?.signal.aborted).toBe(true)
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: 0, outcome: 'aborted', message: null },
    ])
  })

  it('rejects a read with the reason of its signal when that aborts while the store reads the bytes', async () => {
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, MIB))
    const { rig } = stubbed({ store })
    let release: (bytes: Uint8Array) => void = () => undefined
    vi.spyOn(store, 'read').mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        release = resolve
      }),
    )
    const controller = new AbortController()
    const reason = new Error('the engine moved on')
    const outcome = track(rig.downloader.read({ start: 0, end: 100 }, controller.signal))
    await settle()
    expect(outcome.state).toBe('pending')

    controller.abort(reason)
    release(bytesOf(0, 100))
    await settle()

    expect(outcome).toEqual({ state: 'rejected', reason })
  })

  it('reads as before with a signal that never aborts', async () => {
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, MIB))
    const { rig } = stubbed({ store })

    const bytes = await rig.downloader.read({ start: 100, end: 1100 }, new AbortController().signal)

    expect(Buffer.compare(bytes, bytesOf(100, 1100))).toBe(0)
  })
})

describe('Downloader: a priority read in a full store', () => {
  it('goes on when the store is full, and does not say again that the download stopped', async () => {
    const size = 12 * MIB
    const server = await serve({ size })
    const store = memoryStore(size, 4 * MIB)
    const rig = build({ url: server.url, store })
    rig.downloader.start()
    await until(() => rig.downloader.state() === 'full')

    // The store is full of nearer data: the block far from the position waits in the frontier, and the answer is full again.
    await rig.downloader.fetchNow({ start: 10 * MIB, end: 10 * MIB + 200_000 })

    expect(await firstMismatch(store, { start: 10 * MIB, end: 10 * MIB + 200_000 })).toBe(-1)
    expect(rig.downloader.state()).toBe('full')
    expect(ofType(rig.events, 'storeFull')).toEqual([
      { type: 'storeFull', on: true, storedBytes: 4 * MIB },
    ])
    expect(ofType(rig.events, 'error')).toEqual([])
  })

  it('stops the onward reads and not the priority reads', async () => {
    const size = 12 * MIB
    const store = memoryStore(size, MIB)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    const waiting = rig.downloader.fetchNow({ start: 10 * MIB, end: 10 * MIB + 200_000 })
    await until(() => stub.pipes.length === 2)

    // Two blocks into a store of one: the second finds no room.
    stub.pipes[0]?.push(0, 2 * MIB)
    await until(() => rig.downloader.state() === 'full')

    expect(ofType(rig.events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: 2 * MIB, outcome: 'aborted', message: null },
    ])
    expect(stub.calls.map((call) => call.signal.aborted)).toEqual([true, false])
    stub.pipes[1]?.push(10 * MIB, 10 * MIB + 200_000)
    await waiting
    stub.pipes[1]?.end()
    await until(() => ofType(rig.events, 'requestEnd').length === 2)
    expect(ofType(rig.events, 'requestEnd')[1]).toMatchObject({ id: 2, outcome: 'done' })
    expect(ofType(rig.events, 'storeFull')).toHaveLength(1)
    expect(rig.downloader.state()).toBe('full')
  })

  it('holds two onward reads, two priority reads and the blocks they leave, with no write refused', async () => {
    const size = 40 * MIB
    const store = await diskStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    const bring = async (read: number, start: number, end: number): Promise<void> => {
      stub.pipes[read]?.push(start, end)
      await until(() => store.held().has({ start, end }))
    }

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    await bring(0, 0, 100 * 1024)
    // Three seeks, each leaving the block of the read that yielded partly filled, in the frontier.
    for (const block of [1, 2, 3]) {
      rig.downloader.setPosition(block * MIB)
      await until(() => stub.pipes.length === block + 1)
      await bring(block, block * MIB, block * MIB + 100 * 1024)
    }
    // Back at the start: the read at 3 MiB is ahead, and a second onward read opens at the first gap.
    rig.downloader.setPosition(0)
    await until(() => stub.pipes.length === 5)
    // Two priority reads far from the position: blocks of the frontier that are nearer than they are cannot be let go of for them.
    const first = rig.downloader.fetchNow({ start: 20 * MIB, end: 21 * MIB })
    const second = rig.downloader.fetchNow({ start: 30 * MIB, end: 31 * MIB })
    await until(() => stub.pipes.length === 7)
    stub.pipes[5]?.push(20 * MIB, 21 * MIB)
    stub.pipes[6]?.push(30 * MIB, 31 * MIB)
    await Promise.all([first, second])
    stub.pipes[4]?.push(100 * 1024, MIB)
    await until(() => store.held().has({ start: 0, end: MIB }))

    expect(ofType(rig.events, 'error')).toEqual([])
    expect(ofType(rig.events, 'retry')).toEqual([])
    await expectHeldBytesRight(store)
  })
})

describe('Downloader: whenHeld and read', () => {
  it('answers at once for a range that is held, and opens no read for one that is not', async () => {
    const size = 8 * MIB
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, MIB))
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })

    await rig.downloader.whenHeld({ start: 100, end: 200 })
    await rig.downloader.whenHeld({ start: 5 * MIB, end: 5 * MIB })
    let answered = false
    rig.downloader.whenHeld({ start: 5 * MIB, end: 5 * MIB + 10 }).then(
      () => {
        answered = true
      },
      () => undefined,
    )
    await settle()

    expect(answered).toBe(false)
    expect(stub.calls).toEqual([])
    expect(ofType(rig.events, 'request')).toEqual([])
  })

  it('is answered by the write that makes the range held', async () => {
    const size = 8 * MIB
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    let answered = false
    const waiting = rig.downloader.whenHeld({ start: 1000, end: 3000 }).then(() => {
      answered = true
    })

    stub.pipes[0]?.push(0, 2999)
    await until(() => store.held().heldFrom(0) === 2999)
    await settle()
    expect(answered).toBe(false)

    stub.pipes[0]?.push(2999, 3500)
    await waiting
    expect(answered).toBe(true)
    expect(stub.calls).toHaveLength(1)
  })

  it('is rejected with the reason of a signal that aborts, at the call or after it, and lets go of the signal', async () => {
    const size = 8 * MIB
    const rig = build({ url: 'http://stub.invalid/file', store: memoryStore(size) })
    const controller = new AbortController()
    const waiting = rig.downloader.whenHeld({ start: 0, end: 100 }, controller.signal)
    await settle()
    const reason = new Error('the engine moved on')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)

    const aborted = AbortSignal.abort(new Error('already'))
    await expect(rig.downloader.whenHeld({ start: 0, end: 100 }, aborted)).rejects.toBe(
      aborted.reason,
    )

    // A wait that was answered lets go of the signal.
    const answered = new AbortController()
    const removed = vi.spyOn(answered.signal, 'removeEventListener')
    const stub = stubNetwork((call) => pipeFor(call, size))
    const other = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })
    other.downloader.start()
    await until(() => stub.pipes.length === 1)
    const quick = other.downloader.whenHeld({ start: 0, end: 10 }, answered.signal)
    stub.pipes[0]?.push(0, 10)
    await quick
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('reads the bytes of a range that is held', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, 2 * MIB))
    const rig = build({ url: 'http://stub.invalid/file', store })

    const bytes = await rig.downloader.read({ start: 500_000, end: 1_500_000 })

    expect(Buffer.compare(bytes, bytesOf(500_000, 1_500_000))).toBe(0)
    expect(store.reads).toBe(1)
  })

  it('reads a range that was let go of before the call: it is fetched again and its bytes are right', async () => {
    const size = 12 * MIB
    const server = await serve({ size })
    const store = memoryStore(size, 4 * MIB)
    const rig = build({ url: server.url, store })
    // The play moves on as the download waits, until the file is down and the first blocks are gone.
    rig.downloader.start()
    let position = 0
    for (;;) {
      await until(() => rig.downloader.state() !== 'reading')
      if (rig.downloader.state() !== 'full') break
      position = Math.min(position + MIB, size)
      rig.downloader.setPosition(position)
      await sleep(2)
    }
    expect(rig.downloader.state()).toBe('done')
    expect(store.held().has({ start: 0, end: 100 })).toBe(false)
    const requests = server.requests.length

    const bytes = await rig.downloader.read({ start: 0, end: 100 })

    expect(Buffer.compare(bytes, bytesOf(0, 100))).toBe(0)
    expect(server.requests.slice(requests)).toEqual([{ range: 'bytes=0-99' }])
  })

  it('asks again with fetchNow when the store answers null, because the range was let go of in between', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, MIB))
    const rig = build({ url: 'http://stub.invalid/file', store })
    store.nullReads = 1

    const bytes = await rig.downloader.read({ start: 0, end: 1000 })

    expect(Buffer.compare(bytes, bytesOf(0, 1000))).toBe(0)
    expect(store.reads).toBe(2)
  })

  it('gives up after three rounds of a range that is let go of every time, with a failure that a later try may mend', async () => {
    const size = 4 * MIB
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, MIB))
    const rig = build({ url: 'http://stub.invalid/file', store })
    store.nullReads = Number.POSITIVE_INFINITY

    const failure = await rig.downloader
      .read({ start: 0, end: 1000 })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ReadError)
    expect((failure as ReadError).fatal).toBe(false)
    expect((failure as ReadError).message).toContain('let go of')
    expect(store.reads).toBe(3)
    // The play goes on: this is not the play's failure.
    expect(rig.downloader.failure()).toBeNull()
  })

  it('rejects a read when the store is closed', async () => {
    const size = 2 * MIB
    const store = memoryStore(size)
    await store.write(0, bytesOf(0, MIB))
    const rig = build({ url: 'http://stub.invalid/file', store })
    await rig.downloader.close()

    await expect(rig.downloader.read({ start: 0, end: 100 })).rejects.toMatchObject({
      name: 'StoreError',
      kind: 'closed',
    })
  })
})

describe('Downloader: the rate', () => {
  it('counts what came in the last RATE_WINDOW_MS, over the time since the first byte until that is a whole window', async () => {
    const size = 8 * MIB
    let clock = 0
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({
      url: 'http://stub.invalid/file',
      store,
      fetch: stub.fetch,
      now: () => clock,
    })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    expect(rig.downloader.rate()).toBeNull()

    clock = 100
    stub.pipes[0]?.push(0, 100 * 1024)
    await until(() => store.held().heldFrom(0) === 100 * 1024)
    // The first byte came at 100 ms: less than RATE_EARLY_MS of receiving is no rate, and then it is the bytes over the time.
    clock = 100 + RATE_EARLY_MS - 1
    expect(rig.downloader.rate()).toBeNull()
    clock = 100 + RATE_EARLY_MS
    expect(rig.downloader.rate()).toBe((100 * 1024) / (RATE_EARLY_MS / 1000))
    clock = 1100
    expect(rig.downloader.rate()).toBe(100 * 1024)

    clock = 2100
    stub.pipes[0]?.push(100 * 1024, 300 * 1024)
    await until(() => store.held().heldFrom(0) === 300 * 1024)
    expect(rig.downloader.rate()).toBe((300 * 1024) / 2)

    // Just short of a window: all of it counts, over the time since the first byte.
    clock = 5099
    expect(rig.downloader.rate()).toBeCloseTo((300 * 1024) / 4.999, 6)
    // A window: what came at its very start has left it.
    clock = 5100
    expect(rig.downloader.rate()).toBe((200 * 1024) / 5)
    // Nothing came for a window: the rate is 0, not unknown.
    clock = 7100
    expect(rig.downloader.rate()).toBe(0)
  })

  it('counts what every read brings', async () => {
    const size = 8 * MIB
    let clock = 0
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({
      url: 'http://stub.invalid/file',
      store,
      fetch: stub.fetch,
      now: () => clock,
    })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    const waiting = rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 1000 })
    await until(() => stub.pipes.length === 2)

    stub.pipes[0]?.push(0, 3000)
    stub.pipes[1]?.push(5 * MIB, 5 * MIB + 1000)
    await waiting
    await until(() => store.held().heldFrom(0) === 3000)
    clock = 2000

    expect(rig.downloader.rate()).toBe(2000)
  })

  it('is the speed of a throttled server: unknown in the first quarter second, and within a quarter of it after three', async () => {
    vi.useRealTimers()
    const size = 8 * MIB
    // 64 KiB every 62 ms is a MiB a second.
    const server = await serve({ size, faults: [{ kind: 'delay', ms: 62 }] })
    const rig = build({ url: server.url, store: memoryStore(size) })
    expect(rig.downloader.rate()).toBeNull()

    rig.downloader.start()
    await sleep(100)
    expect(rig.downloader.rate()).toBeNull()
    await sleep(2800)

    const rate = rig.downloader.rate()
    expect(rate).not.toBeNull()
    expect(rate).toBeGreaterThan(0.75 * MIB)
    expect(rate).toBeLessThan(1.25 * MIB)
  })
})

describe('Downloader: a read that goes quiet', () => {
  // The clock of these tests is the fake one, so that the time a read has been quiet moves with the timers.
  const now = (): number => Date.now()
  const KIB = 1024
  const size = 8 * MIB

  /** A downloader on a stub whose every read is a pipe that the test feeds, started and with its first read open. */
  async function reading(
    options: { store?: SpyStore; total?: number } = {},
  ): Promise<{ rig: Rig; stub: Stub; store: SpyStore }> {
    const total = options.total ?? size
    const store = options.store ?? memoryStore(total)
    const stub = stubNetwork((call) => pipeFor(call, total))
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch, now })
    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    return { rig, stub, store }
  }

  /** The pipe of a call (every read of these tests is a pipe, in the order of the calls). */
  function pipeOf(stub: Stub, call: StubCall | undefined): Pipe | undefined {
    return call === undefined ? undefined : stub.pipes[call.index]
  }

  it('gives up on a read that sends nothing for READ_IDLE_MS, tries it again from its next byte after the usual pause, and logs why', async () => {
    const { rig, stub, store } = await reading()
    stub.pipes[0]?.push(0, 100 * KIB)
    await until(() => store.held().heldFrom(0) === 100 * KIB)

    await vi.advanceTimersByTimeAsync(READ_IDLE_MS - 1)
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(stub.calls[0]?.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => ofType(rig.events, 'retry').length === 1)

    expect(rig.downloader.state()).toBe('waiting')
    expect(rig.downloader.failure()).toBeNull()
    expect(ofType(rig.events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: 100 * KIB },
    ])
    expect(ofType(rig.events, 'requestEnd')).toEqual([
      {
        type: 'requestEnd',
        id: 1,
        bytes: 100 * KIB,
        outcome: 'failed',
        message: `The server sent nothing for ${READ_IDLE_MS / 1000} s for bytes 0-, after 102400 of ${size} bytes.`,
      },
    ])
    // The connection was let go of, and the play did not end: nothing was said to be an error.
    expect(stub.calls[0]?.signal.aborted).toBe(true)
    expect(ofType(rig.events, 'error')).toEqual([])

    // The pause is the usual one, and the read reopens at the exact next byte.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1)
    expect(stub.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => stub.pipes.length === 2)
    expect(stub.calls[1]).toMatchObject({ from: 100 * KIB, to: null })
    expect(ofType(rig.events, 'request')[1]).toEqual({
      type: 'request',
      id: 2,
      from: 100 * KIB,
      to: null,
    })

    stub.pipes[1]?.push(100 * KIB, size)
    await until(() => rig.downloader.state() === 'done')
    expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
  })

  it('gives up on a request that gets no answer, and reopens it after the pause', async () => {
    const store = memoryStore(size)
    const later = stubNetwork((call) => wholeRange(call, size))
    // The first request is never answered: its fetch waits for the abort, as a real one does.
    let firstSignal: AbortSignal | null = null
    const hanging: typeof fetch = (input, init) => {
      if (firstSignal !== null) return later.fetch(input, init)
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('the stub was given no signal')
      firstSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    const rig = build({ url: 'http://stub.invalid/file', store, fetch: hanging, now })

    rig.downloader.start()
    await until(() => firstSignal !== null)
    await vi.advanceTimersByTimeAsync(READ_IDLE_MS)
    await until(() => ofType(rig.events, 'retry').length === 1)

    expect(ofType(rig.events, 'retry')[0]).toEqual({
      type: 'retry',
      attempt: 1,
      delayMs: RETRY_BASE_MS,
      offset: 0,
    })
    expect(ofType(rig.events, 'requestEnd')[0]).toMatchObject({
      id: 1,
      bytes: 0,
      outcome: 'failed',
      message: `The server sent nothing for ${READ_IDLE_MS / 1000} s after the request for bytes 0-.`,
    })
    expect(ofType(rig.events, 'firstByte')).toEqual([])
    expect(firstSignal).toMatchObject({ aborted: true })
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => rig.downloader.state() === 'done')
    expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
  })

  it('goes on with the usual, growing pauses when it goes quiet again and again', async () => {
    const { rig, stub } = await reading()

    for (const delayMs of [RETRY_BASE_MS, 2 * RETRY_BASE_MS, 4 * RETRY_BASE_MS]) {
      await vi.advanceTimersByTimeAsync(READ_IDLE_MS)
      await until(() => ofType(rig.events, 'retry').at(-1)?.delayMs === delayMs)
      await vi.advanceTimersByTimeAsync(delayMs)
      await until(() => rig.downloader.state() === 'reading')
    }

    expect(ofType(rig.events, 'retry').map((retry) => retry.attempt)).toEqual([1, 2, 3])
    expect(stub.calls).toHaveLength(4)
  })

  it('does not give up on a slow body that keeps moving', async () => {
    const { rig, stub, store } = await reading()

    // A piece every 9 s for a minute: no wait is as long as READ_IDLE_MS.
    for (let piece = 0; piece < 7; piece += 1) {
      await vi.advanceTimersByTimeAsync(READ_IDLE_MS - 1000)
      stub.pipes[0]?.push(piece * 100 * KIB, (piece + 1) * 100 * KIB)
      await until(() => store.held().heldFrom(0) === (piece + 1) * 100 * KIB)
    }

    expect(stub.calls).toHaveLength(1)
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(ofType(rig.events, 'requestEnd')).toEqual([])
    expect(rig.downloader.state()).toBe('reading')
  })

  it('does not count the time the store takes to write: a store that is slower than READ_IDLE_MS is not a stall', async () => {
    const store = memoryStore(size)
    store.writeDelayMs = 3 * READ_IDLE_MS
    const { rig, stub } = await reading({ store })
    stub.pipes[0]?.push(0, 100 * KIB)
    stub.pipes[0]?.push(100 * KIB, 200 * KIB)

    // Two writes of 30 s each, one after the other, and the network is never waited on for more than an instant.
    await vi.advanceTimersByTimeAsync(2 * 3 * READ_IDLE_MS)
    await until(() => store.held().heldFrom(0) === 200 * KIB)

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.signal.aborted).toBe(false)
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(ofType(rig.events, 'requestEnd')).toEqual([])
    expect(rig.downloader.state()).toBe('reading')
  })

  it('counts the quiet from the last write that finished, so that a slow store does not make a healthy read look like a stall to the engine', async () => {
    const store = memoryStore(size)
    store.writeDelayMs = 5_000
    const { rig, stub } = await reading({ store })
    stub.pipes[0]?.push(0, 100 * KIB)
    await vi.advanceTimersByTimeAsync(5_000)
    await until(() => store.held().heldFrom(0) === 100 * KIB)

    // The write took longer than STALL_COVER_MS, and the read has just moved: it covers the byte after what it wrote.
    void rig.downloader.fetchNow({ start: 100 * KIB, end: 100 * KIB + 10 }).catch(() => undefined)
    await settle()

    expect(stub.calls).toHaveLength(1)
  })

  it('answers the engine through a read of its own when the read that would have brought its bytes goes quiet, with no further call from the engine', async () => {
    const { rig, stub, store } = await reading()
    stub.pipes[0]?.push(0, 100 * KIB)
    await until(() => store.held().heldFrom(0) === 100 * KIB)

    // The engine asks for the next 64 KiB while the read is moving, as the stalled-read probe does: the read covers them.
    await vi.advanceTimersByTimeAsync(200)
    let answer: Uint8Array | null = null
    rig.downloader.read({ start: 100 * KIB, end: 164 * KIB }).then(
      (bytes) => {
        answer = bytes
      },
      () => undefined,
    )
    await settle()
    expect(stub.calls).toHaveLength(1)

    // The read goes quiet: after STALL_COVER_MS it covers nothing, and the engine's bytes are asked for.
    await vi.advanceTimersByTimeAsync(STALL_COVER_MS - 200)
    await settle()
    expect(stub.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await until(() => stub.pipes.length === 2)
    expect(stub.calls[1]).toMatchObject({ from: 100 * KIB, to: 164 * KIB - 1 })
    expect(ofType(rig.events, 'retry')).toEqual([])

    stub.pipes[1]?.push(100 * KIB, 164 * KIB)
    await until(() => answer !== null)
    expect(answer).toEqual(bytesOf(100 * KIB, 164 * KIB))
    // All of this was before the quiet read was given up on.
    expect(ofType(rig.events, 'retry')).toEqual([])
    expect(stub.calls[0]?.signal.aborted).toBe(false)
  })

  it('opens a read of its own at once for a range that the engine asks for after the quiet began', async () => {
    const { rig, stub, store } = await reading()
    stub.pipes[0]?.push(0, 100 * KIB)
    await until(() => store.held().heldFrom(0) === 100 * KIB)
    await vi.advanceTimersByTimeAsync(3_000)

    void rig.downloader.fetchNow({ start: 100 * KIB, end: 164 * KIB }).catch(() => undefined)
    await until(() => stub.pipes.length === 2)

    expect(stub.calls[1]).toMatchObject({ from: 100 * KIB, to: 164 * KIB - 1 })
  })

  it('does not open an onward read where a quiet one is when the position moves: that read is given up on by its own limit', async () => {
    const { rig, stub, store } = await reading()
    stub.pipes[0]?.push(0, 100 * KIB)
    await until(() => store.held().heldFrom(0) === 100 * KIB)
    await vi.advanceTimersByTimeAsync(3 * STALL_COVER_MS)

    rig.downloader.setPosition(50 * KIB)
    await settle()

    expect(stub.calls).toHaveLength(1)
    expect(ofType(rig.events, 'restart')).toEqual([])
  })

  it('gives up on a priority read that goes quiet, and reads from its next byte after its own pause', async () => {
    const { rig, stub, store } = await reading()
    const waiting = rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 300 * KIB })
    await until(() => stub.pipes.length === 2)
    stub.pipes[1]?.push(5 * MIB, 5 * MIB + 100 * KIB)
    await until(() => store.held().has({ start: 5 * MIB, end: 5 * MIB + 100 * KIB }))

    await vi.advanceTimersByTimeAsync(READ_IDLE_MS)
    await until(() => ofType(rig.events, 'retry').length >= 2)

    // The onward read, which had nothing, has its own retry; the priority read's is at its next byte.
    const retries = ofType(rig.events, 'retry')
    expect(retries.filter((retry) => retry.offset === 5 * MIB + 100 * KIB)).toEqual([
      { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: 5 * MIB + 100 * KIB },
    ])
    expect(ofType(rig.events, 'requestEnd').find((end) => end.id === 2)).toMatchObject({
      outcome: 'failed',
      bytes: 100 * KIB,
    })
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => stub.calls.some((call) => call.from === 5 * MIB + 100 * KIB))
    const again = stub.calls.find((call) => call.from === 5 * MIB + 100 * KIB)
    expect(again).toMatchObject({ to: 5 * MIB + 300 * KIB - 1 })
    pipeOf(stub, again)?.push(5 * MIB + 100 * KIB, 5 * MIB + 300 * KIB)
    await waiting
    expect(await firstMismatch(store, { start: 5 * MIB, end: 5 * MIB + 300 * KIB })).toBe(-1)
  })

  describe('and the network comes back', () => {
    const comings: [string, (connectivity: FakeConnectivity) => void][] = [
      [
        'online',
        (connectivity) => {
          connectivity.fireOnline()
        },
      ],
      [
        'the page becoming visible while online',
        (connectivity) => {
          connectivity.fireVisible()
        },
      ],
    ]

    it.each(comings)(
      'restarts a read that has been quiet for more than STALL_COVER_MS at its next byte at once, with no pause: %s',
      async (_name, fire) => {
        const { rig, stub, store } = await reading()
        stub.pipes[0]?.push(0, 100 * KIB)
        await until(() => store.held().heldFrom(0) === 100 * KIB)
        await vi.advanceTimersByTimeAsync(3_000)

        fire(rig.connectivity)
        await until(() => stub.pipes.length === 2)

        expect(stub.calls[1]).toMatchObject({ from: 100 * KIB, to: null })
        expect(stub.calls[0]?.signal.aborted).toBe(true)
        expect(ofType(rig.events, 'retry')).toEqual([])
        expect(ofType(rig.events, 'restart')).toEqual([])
        expect(ofType(rig.events, 'error')).toEqual([])
        expect(ofType(rig.events, 'requestEnd')).toEqual([
          {
            type: 'requestEnd',
            id: 1,
            bytes: 100 * KIB,
            outcome: 'failed',
            message: 'The read had been quiet for 3 s when the network came back.',
          },
        ])
        expect(rig.downloader.state()).toBe('reading')

        stub.pipes[1]?.push(100 * KIB, size)
        await until(() => rig.downloader.state() === 'done')
        expect(await firstMismatch(store, { start: 0, end: size })).toBe(-1)
      },
    )

    it.each(comings)(
      'leaves a read that moved within STALL_COVER_MS alone: %s',
      async (_name, fire) => {
        const { rig, stub, store } = await reading()
        stub.pipes[0]?.push(0, 100 * KIB)
        await until(() => store.held().heldFrom(0) === 100 * KIB)
        await vi.advanceTimersByTimeAsync(STALL_COVER_MS)

        fire(rig.connectivity)
        await settle()

        expect(stub.calls).toHaveLength(1)
        expect(stub.calls[0]?.signal.aborted).toBe(false)
      },
    )

    it('does not hear the page become visible while the network is down', async () => {
      const { rig, stub, store } = await reading()
      stub.pipes[0]?.push(0, 100 * KIB)
      await until(() => store.held().heldFrom(0) === 100 * KIB)
      await vi.advanceTimersByTimeAsync(3_000)
      rig.connectivity.isOnline = false

      rig.connectivity.fireVisible()
      await settle()

      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.signal.aborted).toBe(false)
    })

    it('restarts a priority read that has been quiet, and the wait is answered by the new one', async () => {
      const { rig, stub, store } = await reading()
      const waiting = rig.downloader.fetchNow({ start: 5 * MIB, end: 5 * MIB + 300 * KIB })
      await until(() => stub.pipes.length === 2)
      stub.pipes[1]?.push(5 * MIB, 5 * MIB + 100 * KIB)
      await until(() => store.held().has({ start: 5 * MIB, end: 5 * MIB + 100 * KIB }))
      await vi.advanceTimersByTimeAsync(3_000)

      rig.connectivity.fireOnline()
      await until(() => stub.calls.some((call) => call.from === 5 * MIB + 100 * KIB))

      expect(stub.calls[1]?.signal.aborted).toBe(true)
      const again = stub.calls.filter(
        (call) => call.from === 5 * MIB + 100 * KIB && call.to === 5 * MIB + 300 * KIB - 1,
      )
      expect(again).toHaveLength(1)
      expect(ofType(rig.events, 'retry')).toEqual([])
      pipeOf(stub, again[0])?.push(5 * MIB + 100 * KIB, 5 * MIB + 300 * KIB)
      await waiting
      expect(await firstMismatch(store, { start: 5 * MIB, end: 5 * MIB + 300 * KIB })).toBe(-1)
    })

    it('opens one read for a gap, not two, when the network comes back to a pause and to a quiet read together', async () => {
      const store = memoryStore(size)
      // The first onward read is at 6 MiB; the position moves back, and the second, at 1 MiB, is refused for a long while.
      const stub = stubNetwork((call) =>
        call.index === 1 ? refusal(503, '20') : pipeFor(call, size),
      )
      const rig = build({ url: 'http://stub.invalid/file', store, fetch: stub.fetch, now })
      rig.downloader.setPosition(6 * MIB)
      rig.downloader.start()
      await until(() => stub.pipes.length === 1)
      stub.pipes[0]?.push(6 * MIB, 6 * MIB + 100 * KIB)
      await until(() => store.held().has({ start: 6 * MIB, end: 6 * MIB + 100 * KIB }))
      rig.downloader.setPosition(MIB)
      await until(() => ofType(rig.events, 'retry').length === 1)
      expect(stub.calls.map((call) => call.from)).toEqual([6 * MIB, MIB])
      await vi.advanceTimersByTimeAsync(3_000)

      rig.connectivity.fireOnline()
      await until(() => stub.pipes.length === 2)
      await settle()

      expect(stub.calls.map((call) => call.from)).toEqual([6 * MIB, MIB, MIB])
      expect(stub.calls[0]?.signal.aborted).toBe(true)
    })

    it('listens while a read is open, and lets go of the listeners when the downloader closes', async () => {
      const { rig } = await reading()
      expect(rig.connectivity.listeners()).toBe(2)

      await rig.downloader.close()

      expect(rig.connectivity.listeners()).toBe(0)
    })
  })

  describe('and a place is said to be covered', () => {
    /** A downloader whose first read has brought `bytes` from 0 at 100 ms, on a clock that the test sets, at 1100 ms: a second of receiving, so the rate is known. */
    async function measured(
      bytes: number,
      total = 32 * MIB,
    ): Promise<{ rig: Rig; stub: Stub; clock: { now: number } }> {
      const clock = { now: 0 }
      const store = memoryStore(total, 64 * MIB)
      const stub = stubNetwork((call) => pipeFor(call, total))
      const rig = build({
        url: 'http://stub.invalid/file',
        store,
        fetch: stub.fetch,
        now: () => clock.now,
      })
      rig.downloader.start()
      await until(() => stub.pipes.length === 1)
      clock.now = 100
      stub.pipes[0]?.push(0, bytes)
      await until(() => store.held().heldFrom(0) === bytes)
      clock.now = 1100
      return { rig, stub, clock }
    }

    /** Asks for ten bytes at `start`, and answers whether a read of its own was opened for them. */
    async function opensARead(rig: Rig, stub: Stub, start: number): Promise<boolean> {
      const before = stub.calls.length
      void rig.downloader.fetchNow({ start, end: start + 10 }).catch(() => undefined)
      await settle()
      return stub.calls.length > before
    }

    it('reaches half a second ahead of the read at the rate it is received, when that is less than a block', async () => {
      const { rig, stub } = await measured(100 * KIB)
      expect(rig.downloader.rate()).toBe(100 * KIB)

      // 100 KiB a second reaches 50 KiB ahead of the 100 KiB it has brought.
      expect(await opensARead(rig, stub, 150 * KIB)).toBe(false)
      expect(await opensARead(rig, stub, 150 * KIB + 1)).toBe(true)
      expect(stub.calls[1]).toMatchObject({ from: 150 * KIB + 1, to: 150 * KIB + 10 })
    })

    it('reaches no more than a block, however fast the read is', async () => {
      const { rig, stub } = await measured(4 * MIB)
      expect(rig.downloader.rate()).toBe(4 * MIB)

      expect(await opensARead(rig, stub, 4 * MIB + BLOCK_BYTES)).toBe(false)
      expect(await opensARead(rig, stub, 4 * MIB + BLOCK_BYTES + 1)).toBe(true)
    })

    it('reaches a block while the rate is not known yet', async () => {
      const { rig, stub, clock } = await measured(100 * KIB)
      clock.now = RATE_EARLY_MS - 1
      expect(rig.downloader.rate()).toBeNull()

      expect(await opensARead(rig, stub, 100 * KIB + BLOCK_BYTES)).toBe(false)
      expect(await opensARead(rig, stub, 100 * KIB + BLOCK_BYTES + 1)).toBe(true)
    })

    it('reaches a few bytes of a trickle, and always the byte the read is at', async () => {
      const { rig, stub } = await measured(KIB)
      expect(rig.downloader.rate()).toBe(KIB)

      expect(await opensARead(rig, stub, KIB)).toBe(false)
      expect(await opensARead(rig, stub, KIB + KIB / 2)).toBe(false)
      expect(await opensARead(rig, stub, KIB + KIB / 2 + 1)).toBe(true)
    })
  })

  it('counts the quiet from the last piece that came, also while it is being written', async () => {
    const store = memoryStore(size)
    const { rig, stub } = await reading({ store })
    stub.pipes[0]?.push(0, 100 * KIB)
    await until(() => store.held().heldFrom(0) === 100 * KIB)

    // The next piece comes after 1.9 s and takes a second to write: 2.4 s since the last write, but 0.5 s since the piece.
    await vi.advanceTimersByTimeAsync(1_900)
    store.writeDelayMs = 1_000
    stub.pipes[0]?.push(100 * KIB, 200 * KIB)
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    void rig.downloader.fetchNow({ start: 100 * KIB, end: 100 * KIB + 10 }).catch(() => undefined)
    await settle()

    expect(stub.calls).toHaveLength(1)
  })

  it('leaves no timer of its own once the wait is answered, and none after close', async () => {
    // A file of 200 KiB: the read that answers the wait brings its end, so that nothing else runs.
    const { rig, stub } = await reading({ total: 200 * KIB })
    stub.pipes[0]?.push(0, 100 * KIB)
    await settle()
    const waiting = rig.downloader.fetchNow({ start: 100 * KIB, end: 164 * KIB })
    await settle()
    // The read covers the wait's bytes, and a look is set for when it would have gone quiet.

    stub.pipes[0]?.push(100 * KIB, 200 * KIB)
    await waiting
    await until(() => rig.downloader.state() === 'done')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer of its own after close, whatever it waited for', async () => {
    const { rig, stub, store } = await reading()
    stub.pipes[0]?.push(0, 100 * KIB)
    await until(() => store.held().heldFrom(0) === 100 * KIB)
    const waiting = rig.downloader.fetchNow({ start: 100 * KIB, end: 164 * KIB })
    waiting.catch(() => undefined)
    await settle()

    await rig.downloader.close()

    await expect(waiting).rejects.toMatchObject({ kind: 'closed' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('pageConnectivity', () => {
  /** A stand-in for the page's event targets, which keeps its listeners. */
  function target(extra: Record<string, unknown> = {}): {
    listeners: Map<string, Set<() => void>>
    fire(type: string): void
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
  } & Record<string, unknown> {
    const listeners = new Map<string, Set<() => void>>()
    return {
      listeners,
      fire(type: string) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener()
      },
      addEventListener(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener)
      },
      ...extra,
    }
  }

  it('reads navigator.onLine, and says online where the page does not say', () => {
    const connectivity = pageConnectivity()
    vi.stubGlobal('navigator', { onLine: false })
    expect(connectivity.online()).toBe(false)
    vi.stubGlobal('navigator', { onLine: true })
    expect(connectivity.online()).toBe(true)
    vi.stubGlobal('navigator', {})
    expect(connectivity.online()).toBe(true)
  })

  it('listens for the online event on the page and lets go of it', () => {
    const page = target()
    vi.stubGlobal('addEventListener', (type: string, listener: () => void) => {
      page.addEventListener(type, listener)
    })
    vi.stubGlobal('removeEventListener', (type: string, listener: () => void) => {
      page.removeEventListener(type, listener)
    })
    const connectivity = pageConnectivity()
    let calls = 0
    const off = connectivity.onOnline(() => {
      calls += 1
    })

    page.fire('online')
    expect(calls).toBe(1)
    off()
    page.fire('online')
    expect(calls).toBe(1)
    expect(page.listeners.get('online')?.size).toBe(0)
  })

  it('listens for visibilitychange and calls only when the page is visible', () => {
    const document = target({ visibilityState: 'hidden' })
    vi.stubGlobal('document', document)
    const connectivity = pageConnectivity()
    let calls = 0
    const off = connectivity.onVisible(() => {
      calls += 1
    })

    document.fire('visibilitychange')
    expect(calls).toBe(0)
    document.visibilityState = 'visible'
    document.fire('visibilitychange')
    expect(calls).toBe(1)
    off()
    document.fire('visibilitychange')
    expect(calls).toBe(1)
    expect(document.listeners.get('visibilitychange')?.size).toBe(0)
  })

  it('gives listeners that do nothing where there is no page', () => {
    const connectivity = pageConnectivity()

    expect(typeof connectivity.onOnline(() => undefined)).toBe('function')
    expect(typeof connectivity.onVisible(() => undefined)).toBe('function')
    expect(() => {
      connectivity.onOnline(() => undefined)()
      connectivity.onVisible(() => undefined)()
    }).not.toThrow()
  })
})

// The text that a timeline takes (`timelineEventSchema`): up to 300 characters, no U+0000 and no
// half of a surrogate pair. A message that breaks it makes the recorder drop the whole event.
describe('clip and messageOf', () => {
  it('leaves a short text as it is', () => {
    expect(clip('The server answered 503 for bytes 0-.')).toBe(
      'The server answered 503 for bytes 0-.',
    )
    expect(clip('')).toBe('')
  })

  it('cuts a text at 300 characters', () => {
    expect(clip('a'.repeat(300))).toHaveLength(300)
    expect(clip('a'.repeat(301))).toHaveLength(300)
    expect(clip('a'.repeat(5000))).toHaveLength(300)
  })

  it('takes out U+0000 and a half of a surrogate pair, and keeps a whole pair', () => {
    expect(clip('a\u0000b')).toBe('ab')
    expect(clip('a\ud800b')).toBe('ab')
    expect(clip('a\udc00b')).toBe('ab')
    expect(clip('a\u{1f600}b')).toBe('a\u{1f600}b')
  })

  it('does not cut a pair in two at the end', () => {
    const clipped = clip(`${'a'.repeat(299)}\u{1f600}`)
    expect(clipped).toBe('a'.repeat(299))
    expect(clipped.isWellFormed()).toBe(true)
  })

  it('makes messageOf an error’s message, or any other value’s text, clipped', () => {
    expect(messageOf(new Error('broke'))).toBe('broke')
    expect(messageOf('plain')).toBe('plain')
    expect(messageOf(new Error(`${'x'.repeat(400)}\u0000`))).toHaveLength(300)
    expect(messageOf(42)).toBe('42')
  })
})

describe('Downloader: the store view', () => {
  it('shows the backend, the cap, what is held and the stats of its store, and is the store as it is now', async () => {
    const size = 4 * MIB
    const store = memoryStore(size, 8 * MIB)
    const rig = build({ url: 'http://stub.invalid/file', store })
    const { store: view } = rig.downloader

    expect(view.backend).toBe('memory')
    expect(view.capBytes).toBe(store.capBytes)
    expect(view.held().ranges()).toEqual([])
    expect(view.stats().storedBytes).toBe(0)

    await store.write(0, bytesOf(0, MIB))
    expect(view.held().ranges()).toEqual([{ start: 0, end: MIB }])
    expect(view.stats().storedBytes).toBe(MIB)
    expect(view.stats().backend).toBe('memory')
  })

  it('has no way to write, read, move the position or close the store', () => {
    const store = memoryStore(MIB)
    const rig = build({ url: 'http://stub.invalid/file', store })
    const view = rig.downloader.store as unknown as Record<string, unknown>
    for (const name of ['write', 'read', 'setPosition', 'close', 'fileSize']) {
      expect(view[name]).toBeUndefined()
    }
  })
})

// R41 item 7: the engine holds the onward reads back until the index is open (the head's own read and the priority
// reads go on), and then releases them.
describe('Downloader: the onward reads held back until released', () => {
  const size = 8 * MIB

  it('opens no onward read while held, serves a priority read, and opens the onward read when released', async () => {
    const store = memoryStore(size)
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({
      url: 'http://stub.invalid/file',
      store,
      fetch: stub.fetch,
      holdOnward: true,
    })
    rig.downloader.start()
    await settle()
    expect(stub.pipes).toHaveLength(0)
    expect(rig.downloader.state()).toBe('waiting')

    // A priority read (the feeder's tail and index reads) works before the release.
    const held = rig.downloader.fetchNow({ start: size - 1000, end: size })
    await until(() => stub.pipes.length === 1)
    stub.pipes[0]?.push(size - 1000, size)
    await held
    expect(store.held().heldFrom(size - 1000)).toBe(1000)
    // The end of that read opened no onward read either.
    await settle()
    expect(stub.pipes).toHaveLength(1)

    rig.downloader.releaseOnward()
    await until(() => stub.pipes.length === 2)
    expect(stub.calls[1]?.from).toBe(0)
    expect(rig.downloader.state()).toBe('reading')
    // A second release changes nothing.
    rig.downloader.releaseOnward()
    await settle()
    expect(stub.pipes).toHaveLength(2)
  })
})
