import { setTimeout as sleep } from 'node:timers/promises'
import type { ByteRange } from '@dfs/mp4'
import type { TimelineEventInput } from '@dfs/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Downloader, pageConnectivity } from './downloader.ts'
import type { Connectivity } from './downloader.ts'
import { StoreError } from './errors.ts'
import { BLOCK_BYTES, LEVEL_EVERY_MS, RETRY_BASE_MS, RETRY_MAX_MS } from './limits.ts'
import { ReadError } from './read.ts'
import { RangeSet } from './ranges.ts'
import { CoreStore } from './store.ts'
import type { PlayStore, StoreStats, WriteOutcome } from './store.ts'
import { byteAt, startRangeServer } from './testing/range-server.ts'
import type { Fault, RangeServer } from './testing/range-server.ts'

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
    if (this.failNextWrite !== null) {
      const failure = this.failNextWrite
      this.failNextWrite = null
      throw failure
    }
    if (bytes.length > 0) {
      this.writes.push({ offset, length: bytes.length })
      this.hidden.remove({ start: offset, end: offset + bytes.length })
    }
    const outcome = await this.#inner.write(offset, bytes)
    for (const range of outcome.evicted) {
      this.evictions.push({ range, position: this.position })
    }
    return outcome
  }

  read(start: number, end: number): Promise<Uint8Array | null> {
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

async function serve(options: { size: number; faults?: Fault[] }): Promise<RangeServer> {
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
      { type: 'storeLevel', storedBytes: size, aheadBytes: size, evictedBytes: 0 },
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
      { type: 'storeLevel', storedBytes: size, aheadBytes: size, evictedBytes: 0 },
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

  it('ignores online and visible outside a pause', async () => {
    const size = 2 * MIB
    const stub = stubNetwork((call) => pipeFor(call, size))
    const rig = build({
      url: 'http://stub.invalid/file',
      store: memoryStore(size),
      fetch: stub.fetch,
    })

    rig.downloader.start()
    await until(() => stub.pipes.length === 1)
    expect(rig.connectivity.listeners()).toBe(0)
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
    const size = 2 * MIB
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
      { type: 'storeLevel', storedBytes: MIB, aheadBytes: MIB, evictedBytes: 0 },
    ])
    await vi.advanceTimersByTimeAsync(LEVEL_EVERY_MS)
    expect(ofType(rig.events, 'storeLevel')).toHaveLength(2)

    // The position is where the ahead is counted from.
    rig.downloader.setPosition(MIB / 2)
    await vi.advanceTimersByTimeAsync(LEVEL_EVERY_MS)
    expect(ofType(rig.events, 'storeLevel')[2]).toMatchObject({ aheadBytes: MIB / 2 })

    stub.pipes[0]?.push(MIB, size)
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
