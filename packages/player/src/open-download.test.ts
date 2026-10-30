import { getEventListeners } from 'node:events'
import type { MessagePort } from 'node:worker_threads'
import { setTimeout as sleep } from 'node:timers/promises'
import { timelineEventSchema } from '@dfs/shared'
import type { TimelineEventInput } from '@dfs/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connectivity, Downloader } from './downloader.ts'
import {
  HEAD_BYTES,
  MEMORY_CAP_BYTES,
  READ_IDLE_MS,
  RETRY_BASE_MS,
  STORE_OPEN_MS,
} from './limits.ts'
import { openDownload } from './open-download.ts'
import type { OpenDownloadOptions } from './open-download.ts'
import type { StoreWorker } from './open.ts'
import { PLAYS_DIRECTORY, lockName } from './opfs.ts'
import { ReadError } from './read.ts'
import type * as readModule from './read.ts'
import type { OpenReadOptions, RangeRead } from './read.ts'
import { serveStore } from './serve.ts'
import { byteAt, startRangeServer } from './testing/range-server.ts'
import type { Fault, RangeServer } from './testing/range-server.ts'
import { TestPlayDirectory, testLock } from './testing/play-directory.ts'

// Opening a download (DESIGN.md §10.4; the iron-clad spec §4.7): the head read says the size of the
// file, the store opens while the head's bytes go on coming, and the downloader is handed the rest
// of that read as its first. Most tests read from the test server; those about a pause use fake
// timers, which stand in for the clock and nothing else, and those about a slow server use the
// real ones, which the server waits with.

const MIB = 1024 * 1024
const SEED = 7

// `./read.ts` is its own, except where a test sets `reads.override`: a head that fails with a
// message that no real answer gives (every message of a read is short), to see what is done
// with a long one.
const reads = vi.hoisted(() => ({
  override: null as ((options: OpenReadOptions) => Promise<RangeRead>) | null,
}))
vi.mock('./read.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof readModule>()
  return {
    ...actual,
    openRead: (options: OpenReadOptions) => (reads.override ?? actual.openRead)(options),
  }
})

const servers: RangeServer[] = []
const downloaders: Downloader[] = []
const ports: MessagePort[] = []

afterEach(async () => {
  reads.override = null
  await Promise.all(downloaders.splice(0).map((downloader) => downloader.close()))
  for (const port of ports.splice(0)) port.close()
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

function fakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
}

type EventOf<T extends TimelineEventInput['type']> = Extract<TimelineEventInput, { type: T }>

function ofType<T extends TimelineEventInput['type']>(
  events: readonly TimelineEventInput[],
  type: T,
): EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.type === type)
}

/** The bytes of the test file from `start` up to, not including, `end`. */
function bytesOf(start: number, end: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(end - start)
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = byteAt(SEED, start + at)
  return bytes
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

/** A door that a test opens when it likes: what the browser's estimate waits for, to hold the opening of the store back. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/**
 * Options that hold the opening of the store back until the door is opened: the browser's
 * estimate waits for it, and then says there is no room, so that the store is in memory and
 * no worker is made.
 */
function heldBack(door: {
  wait: Promise<void>
}): Pick<OpenDownloadOptions, 'makeWorker' | 'estimate'> {
  return {
    makeWorker: () => {
      throw new Error('no worker is to be made when there is no room')
    },
    estimate: async () => {
      await door.wait
      return { quota: 0, usage: 0 }
    },
  }
}

/** A store worker over a `MessageChannel` and an in-memory directory, as the tests of the store's client make it; what it did is in `log`. */
function diskWorkers(): {
  makeWorker: () => StoreWorker
  workers: StoreWorker[]
  log: string[]
  directory: TestPlayDirectory
} {
  const log: string[] = []
  const workers: StoreWorker[] = []
  const directory = new TestPlayDirectory(log)
  const makeWorker = (): StoreWorker => {
    const { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    serveStore(port2, () => Promise.resolve(directory), testLock(log))
    const worker: StoreWorker & { terminations: number } = Object.assign(port1, {
      terminations: 0,
      terminate() {
        worker.terminations += 1
        log.push('worker terminated')
        port1.close()
      },
    })
    workers.push(worker)
    return worker
  }
  return { makeWorker, workers, log, directory }
}

/** A worker that nobody serves: it receives what is sent it and answers nothing, as a worker that is alive but hung. */
function unservedWorker(): {
  makeWorker: () => StoreWorker
  received: () => number
  terminations: () => number
} {
  let received = 0
  let terminations = 0
  return {
    received: () => received,
    terminations: () => terminations,
    makeWorker: () => {
      const { port1, port2 } = new MessageChannel()
      ports.push(port1, port2)
      port2.on('message', () => {
        received += 1
      })
      return Object.assign(port1, {
        terminate() {
          terminations += 1
          port1.close()
        },
      })
    },
  }
}

interface Rig {
  events: TimelineEventInput[]
  connectivity: FakeConnectivity
  /** Opens the download at the server; what is given overrides the defaults. */
  open: (extra?: Partial<OpenDownloadOptions>) => Promise<Downloader>
}

function rig(server: RangeServer): Rig {
  const events: TimelineEventInput[] = []
  const connectivity = new FakeConnectivity()
  return {
    events,
    connectivity,
    open: async (extra = {}) => {
      const downloader = await openDownload({
        url: server.url,
        playId: 'play-1',
        makeWorker: null,
        onEvent: (event) => {
          events.push(event)
        },
        connectivity,
        random: () => 0.5,
        ...extra,
      })
      downloaders.push(downloader)
      return downloader
    },
  }
}

/** The bytes of a range, read from the downloader, equal the file's. */
async function expectBytesRight(downloader: Downloader, start: number, end: number): Promise<void> {
  const bytes = await downloader.read({ start, end })
  expect(Buffer.compare(bytes, bytesOf(start, end))).toBe(0)
}

describe('openDownload: the head', () => {
  it('rejects with the fatal ReadError, and says so on the timeline, when the file is not there', async () => {
    const server = await serve({ size: 2 * MIB, faults: [{ kind: 'status', status: 404 }] })
    const { open, events } = rig(server)

    const failure: unknown = await open().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ReadError)
    expect((failure as ReadError).fatal).toBe(true)
    expect((failure as ReadError).status).toBe(404)
    expect(server.requests).toHaveLength(1)
    const message = (failure as ReadError).message
    expect(events).toEqual([
      { type: 'request', id: 1, from: 0, to: HEAD_BYTES - 1 },
      { type: 'requestEnd', id: 1, bytes: 0, outcome: 'failed', message },
      { type: 'error', from: 'engine', code: 404, message },
    ])
  })

  it('clips the messages of a head that fails for good, so that the recorder keeps both events', async () => {
    const server = await serve({ size: 2 * MIB })
    const { open, events } = rig(server)
    // More than 300 characters, with a U+0000 and half of a surrogate pair among them.
    const message = `${'a'.repeat(250)}\u0000${'b'.repeat(250)}\ud800c`
    reads.override = () => Promise.reject(new ReadError(message, { fatal: true, status: 404 }))

    const failure: unknown = await open().catch((error: unknown) => error)

    // The failure is the read's own, as it was; it is the events that are cut to what a timeline takes.
    expect(failure).toBeInstanceOf(ReadError)
    expect((failure as ReadError).message).toBe(message)
    expect(server.requests).toEqual([])
    expect(events.map((event) => event.type)).toEqual(['request', 'requestEnd', 'error'])
    for (const event of events) {
      const parsed = timelineEventSchema.safeParse({ ...event, t: 0 })
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    }
    const clipped = `${'a'.repeat(250)}${'b'.repeat(50)}`
    expect(ofType(events, 'requestEnd')[0]?.message).toBe(clipped)
    expect(ofType(events, 'error')[0]).toEqual({
      type: 'error',
      from: 'engine',
      code: 404,
      message: clipped,
    })
  })

  it('takes the size of the file from Content-Range, holds the head, and hands the read on', async () => {
    // A size that is not a number of blocks.
    const size = 3 * MIB + 123
    const server = await serve({ size })
    const { open, events } = rig(server)

    const downloader = await open()
    await downloader.whenHeld({ start: 0, end: HEAD_BYTES })
    await expectBytesRight(downloader, 0, HEAD_BYTES)

    // The store was opened for the file's size: a range past it is refused, and the whole file comes.
    await expect(downloader.whenHeld({ start: 0, end: size + 1 })).rejects.toBeInstanceOf(
      RangeError,
    )
    await downloader.whenHeld({ start: 0, end: size })
    await expectBytesRight(downloader, size - 1000, size)
    // The head was asked for once; the downloader's own read went on from where it ended, and its ids go on from the head's.
    expect(server.requests).toEqual([
      { range: `bytes=0-${HEAD_BYTES - 1}` },
      { range: `bytes=${HEAD_BYTES}-` },
    ])
    expect(ofType(events, 'request')).toEqual([
      { type: 'request', id: 1, from: 0, to: HEAD_BYTES - 1 },
      { type: 'request', id: 2, from: HEAD_BYTES, to: null },
    ])
    expect(ofType(events, 'firstByte').map((event) => event.id)).toEqual([1, 2])
    await until(() => ofType(events, 'requestEnd').length === 2)
    expect(ofType(events, 'requestEnd').map((end) => [end.id, end.outcome])).toEqual([
      [1, 'done'],
      [2, 'done'],
    ])
    expect(ofType(events, 'requestEnd')[0]?.bytes).toBe(HEAD_BYTES)
    // The hand-over is not a seek, and nothing failed.
    expect(ofType(events, 'restart')).toEqual([])
    expect(ofType(events, 'error')).toEqual([])
    expect(ofType(events, 'retry')).toEqual([])
  })

  it('opens the store in memory when there is no worker to make, and says why', async () => {
    const server = await serve({ size: 2 * MIB })
    const { open, events } = rig(server)

    await open({ makeWorker: null })

    expect(ofType(events, 'store')).toEqual([
      { type: 'store', backend: 'memory', capBytes: MEMORY_CAP_BYTES, reason: 'no-worker' },
    ])
  })

  it('opens the store on disk through a worker, and fills it with the head and the rest of the file', async () => {
    const size = 2 * MIB + 5
    const server = await serve({ size })
    const { open, events } = rig(server)
    const disk = diskWorkers()

    const downloader = await open({
      makeWorker: disk.makeWorker,
      estimate: () => Promise.resolve({ quota: 10 * 1024 ** 3, usage: 0 }),
    })
    await downloader.whenHeld({ start: 0, end: size })
    await expectBytesRight(downloader, 0, size)

    expect(ofType(events, 'store')).toEqual([
      expect.objectContaining({ type: 'store', backend: 'disk', reason: null }),
    ])
    expect(disk.directory.file.writes.length).toBeGreaterThan(0)
    await downloader.close()
    expect(disk.log).toContain('worker terminated')
  })

  it('resolves as soon as the store is open, while the head goes on coming', async () => {
    const size = 3 * MIB
    // 64 KiB every 20 ms: the head alone takes a third of a second.
    const server = await serve({ size, chunkDelayMs: 20 })
    const { open, events } = rig(server)

    const downloader = await open()

    // The head's response is open still, and nothing has said that its read ended.
    expect(server.openResponses()).toBe(1)
    expect(ofType(events, 'requestEnd')).toEqual([])
    expect(downloader.state()).toBe('reading')
    expect(ofType(events, 'store')).toHaveLength(1)
    // The rest of the head goes into the store as the downloader's first read, and the file comes after it.
    await downloader.whenHeld({ start: 0, end: HEAD_BYTES })
    await expectBytesRight(downloader, HEAD_BYTES - 1000, HEAD_BYTES)
    await until(() => ofType(events, 'request').length === 2)
    expect(ofType(events, 'requestEnd')[0]).toMatchObject({ id: 1, outcome: 'done' })
    await downloader.whenHeld({ start: 0, end: size })
    await expectBytesRight(downloader, 0, size)
  })

  it('works for a file shorter than the head: it is all there, and the download is done', async () => {
    const size = 300_000
    const server = await serve({ size })
    const { open, events } = rig(server)

    const downloader = await open()
    await until(() => downloader.state() === 'done')

    expect(server.requests).toEqual([{ range: `bytes=0-${HEAD_BYTES - 1}` }])
    await expectBytesRight(downloader, 0, size)
    await expect(downloader.whenHeld({ start: 0, end: size + 1 })).rejects.toBeInstanceOf(
      RangeError,
    )
    expect(ofType(events, 'storeLevel')).toEqual([
      { type: 'storeLevel', storedBytes: size, aheadBytes: size, evictedBytes: 0 },
    ])
    expect(ofType(events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: size, outcome: 'done', message: null },
    ])
  })

  it('writes the bytes of the head that came before the store was open, once it is open', async () => {
    const size = 2 * MIB
    const server = await serve({ size })
    const { open, events } = rig(server)
    const door = gate()

    // The browser takes its time to say how much room there is, and the store is not open until it does.
    const opening = open(heldBack(door))
    await until(() => ofType(events, 'firstByte').length === 1)
    await until(() => server.openResponses() === 0)
    await sleep(50)
    expect(ofType(events, 'store')).toEqual([])

    door.open()
    const downloader = await opening

    await downloader.whenHeld({ start: 0, end: HEAD_BYTES })
    await expectBytesRight(downloader, 0, HEAD_BYTES)
    expect(ofType(events, 'store')).toEqual([
      { type: 'store', backend: 'memory', capBytes: MEMORY_CAP_BYTES, reason: 'quota' },
    ])
    // The head's request was open before the store, and its end is after.
    const types = events.map((event) => event.type)
    expect(types.indexOf('firstByte')).toBeLessThan(types.indexOf('store'))
    expect(types.indexOf('store')).toBeLessThan(types.indexOf('requestEnd'))
    expect(server.requests[0]).toEqual({ range: `bytes=0-${HEAD_BYTES - 1}` })
  })

  it('counts the bytes of the head in the rate at the time they came, and not at the time they were written', async () => {
    const size = HEAD_BYTES
    const server = await serve({ size })
    const { open, events } = rig(server)
    const door = gate()
    let clock = 0

    const opening = open({ now: () => clock, ...heldBack(door) })
    await until(() => ofType(events, 'firstByte').length === 1)
    await until(() => server.openResponses() === 0)
    await sleep(50)
    // The store opens three seconds later.
    clock = 3000
    door.open()
    const downloader = await opening
    await downloader.whenHeld({ start: 0, end: size })

    clock = 3500
    expect(downloader.rate()).toBe(HEAD_BYTES / 3.5)
  })

  it('leaves the retry of a head body that broke before the store opened to the downloader', async () => {
    const size = 2 * MIB
    const server = await serve({ size, faults: [{ kind: 'drop', afterBytes: 300_000 }] })
    const { open, events } = rig(server)
    const door = gate()

    const opening = open(heldBack(door))
    await until(() => ofType(events, 'firstByte').length === 1)
    await until(() => server.openResponses() === 0)
    await sleep(50)
    expect(ofType(events, 'store')).toEqual([])
    door.open()
    const downloader = await opening

    // What came is written, the break is a failure of the read, and the read goes on from where it broke.
    await downloader.whenHeld({ start: 0, end: size })
    await expectBytesRight(downloader, 0, size)
    expect(ofType(events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: 300_000 },
    ])
    expect(server.requests).toEqual([
      { range: `bytes=0-${HEAD_BYTES - 1}` },
      { range: 'bytes=300000-' },
    ])
    expect(ofType(events, 'requestEnd')[0]).toMatchObject({
      id: 1,
      bytes: 300_000,
      outcome: 'failed',
    })
  })
})

describe('openDownload: a head that fails before its headers', () => {
  it('retries a 503 on the head after a pause, with a new request, and goes on', async () => {
    fakeTimers()
    const size = 2 * MIB
    const server = await serve({ size, faults: [{ kind: 'status', status: 503 }] })
    const { open, events } = rig(server)

    const opening = open()
    await until(() => ofType(events, 'retry').length === 1)

    expect(ofType(events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: 0 },
    ])
    const ended = ofType(events, 'requestEnd')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ id: 1, bytes: 0, outcome: 'failed' })
    expect(ended[0]?.message).toContain('503')
    // The pause is a pause: nothing is asked until it is over.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1)
    expect(server.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const downloader = await opening

    await downloader.whenHeld({ start: 0, end: size })
    expect(ofType(events, 'request')[1]).toEqual({
      type: 'request',
      id: 2,
      from: 0,
      to: HEAD_BYTES - 1,
    })
    expect(ofType(events, 'firstByte').map((event) => event.id)).toEqual([2, 3])
    // The pauses of the head do not make the first pause of the downloader longer, and nothing failed twice.
    expect(ofType(events, 'error')).toEqual([])
    expect(ofType(events, 'retry')).toHaveLength(1)
  })

  it('retries for as long as it takes, with pauses that grow, and believes a Retry-After as a least', async () => {
    fakeTimers()
    const server = await serve({
      size: 2 * MIB,
      faults: [
        { kind: 'status', status: 503 },
        { kind: 'status', status: 503, retryAfter: '3' },
        { kind: 'status', status: 429, retryAfter: '0' },
      ],
    })
    const { open, events } = rig(server)

    const opening = open()
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await until(() => ofType(events, 'retry').length === attempt)
      await vi.advanceTimersByTimeAsync(ofType(events, 'retry')[attempt - 1]?.delayMs ?? 0)
    }
    // 500 ms; the 3 s the server asked for; the 2 s of the third failure, which a Retry-After of 0 does not shorten.
    expect(ofType(events, 'retry').map((retry) => [retry.attempt, retry.delayMs])).toEqual([
      [1, 500],
      [2, 3000],
      [3, 2000],
    ])
    // Four asks for the head, and the downloader's own read after it, whose id goes on from the head's.
    const downloader = await opening
    await downloader.whenHeld({ start: 0, end: 2 * MIB })
    expect(ofType(events, 'request').map((request) => request.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('ends a pause of the head on online, and on a return to the page only when the network is up', async () => {
    fakeTimers()
    const server = await serve({
      size: 2 * MIB,
      faults: [{ kind: 'status', status: 503, retryAfter: '20' }],
    })
    const { open, events, connectivity } = rig(server)
    connectivity.isOnline = false

    const opening = open()
    await until(() => ofType(events, 'retry').length === 1)
    expect(ofType(events, 'retry')[0]?.delayMs).toBe(20_000)
    expect(connectivity.listeners()).toBe(2)

    connectivity.fireVisible()
    await vi.advanceTimersByTimeAsync(1000)
    expect(server.requests).toHaveLength(1)

    connectivity.isOnline = true
    connectivity.fireOnline()
    const downloader = await opening
    // The head was asked for again at once, and not after the 20 s.
    expect(server.requests.length).toBeGreaterThanOrEqual(2)
    expect(server.requests[1]).toEqual({ range: `bytes=0-${HEAD_BYTES - 1}` })
    // The pause's listeners are gone; the downloader, which reads on, hears the network until it has read the file.
    await until(() => downloader.state() === 'done')
    expect(connectivity.listeners()).toBe(0)
  })

  it('stops asking when the signal aborts during a pause, and leaves no timer and no listener', async () => {
    fakeTimers()
    const server = await serve({
      size: 2 * MIB,
      faults: [{ kind: 'status', status: 503, retryAfter: '20' }],
    })
    const { open, events, connectivity } = rig(server)
    const controller = new AbortController()

    const opening = open({ signal: controller.signal })
    const settled = opening.then(
      () => 'opened',
      (error: unknown) => error,
    )
    await until(() => ofType(events, 'retry').length === 1)
    const reason = new Error('the view moved on')
    controller.abort(reason)

    expect(await settled).toBe(reason)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(connectivity.listeners()).toBe(0)
  })

  it('rejects at once, lets the head go, and closes the store when it opens, when the signal aborts while the store opens', async () => {
    // 64 KiB every 40 ms: the head takes most of a second to come, if it is let to.
    const server = await serve({ size: 2 * MIB, chunkDelayMs: 40 })
    const { open, events } = rig(server)
    const door = gate()
    const controller = new AbortController()

    const disk = diskWorkers()
    const opening = open({
      signal: controller.signal,
      makeWorker: disk.makeWorker,
      estimate: async () => {
        await door.wait
        return { quota: 10 * 1024 ** 3, usage: 0 }
      },
    })
    const settled = opening.then(
      () => 'opened',
      (error: unknown) => error,
    )
    await until(() => ofType(events, 'firstByte').length === 1)
    const reason = new Error('the view moved on')
    controller.abort(reason)

    // It does not wait for the store: the door is still shut.
    expect(await settled).toBe(reason)
    // The head's connection is let go of, long before the head would have come.
    await until(() => server.openResponses() === 0, 300)
    expect(ofType(events, 'requestEnd')).toEqual([
      expect.objectContaining({ id: 1, outcome: 'aborted' }),
    ])
    expect(ofType(events, 'store')).toEqual([])
    expect(disk.workers).toEqual([])

    // The store that opens for a play that did not go on is closed, and its worker ended.
    door.open()
    await until(() => disk.log.includes('worker terminated'))
    expect(ofType(events, 'store')).toHaveLength(1)
    expect(disk.workers).toHaveLength(1)
    expect(disk.log.slice(-3)).toEqual([
      'directory removed',
      'lock released play-1',
      'worker terminated',
    ])
    expect(ofType(events, 'requestEnd')).toHaveLength(1)
  })

  it('leaves no listener on the signal once the download is open', async () => {
    const server = await serve({ size: 2 * MIB })
    const { open } = rig(server)
    const controller = new AbortController()
    await open({ signal: controller.signal })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('rejects at once when the signal aborts as the store arrives, and closes it', async () => {
    const server = await serve({ size: 2 * MIB })
    const controller = new AbortController()
    const reason = new Error('the view moved on')
    const disk = diskWorkers()
    const events: TimelineEventInput[] = []
    const opening = openDownload({
      url: server.url,
      playId: 'play-1',
      makeWorker: disk.makeWorker,
      estimate: () => Promise.resolve({ quota: 10 * 1024 ** 3, usage: 0 }),
      connectivity: new FakeConnectivity(),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        // The viewer leaves in the turn after the store has opened, when the opening has nearly answered.
        if (event.type === 'store') {
          queueMicrotask(() => {
            queueMicrotask(() => {
              controller.abort(reason)
            })
          })
        }
      },
    })
    await expect(opening).rejects.toBe(reason)
    await until(() => disk.log.includes('worker terminated'))
    expect(ofType(events, 'requestEnd')).toEqual([
      expect.objectContaining({ id: 1, outcome: 'aborted' }),
    ])
  })

  it('rejects at once when the signal aborts while a worker that does not answer is opening, and the worker is ended when its open expires', async () => {
    fakeTimers()
    const server = await serve({ size: 2 * MIB })
    const { open, events } = rig(server)
    const silent = unservedWorker()
    const controller = new AbortController()

    const opening = open({
      signal: controller.signal,
      makeWorker: silent.makeWorker,
      estimate: () => Promise.resolve({ quota: 10 * 1024 ** 3, usage: 0 }),
    })
    let state = 'pending'
    const settled = opening.then(
      () => 'opened',
      (error: unknown) => {
        state = 'rejected'
        return error
      },
    )
    await until(() => silent.received() === 1)
    const reason = new Error('the view moved on')
    controller.abort(reason)

    // No time has passed on the clock of the timers: the worker has not been given up, and the opening is over.
    await until(() => state === 'rejected')
    expect(await settled).toBe(reason)
    expect(silent.terminations()).toBe(0)
    expect(ofType(events, 'requestEnd')).toEqual([
      expect.objectContaining({ id: 1, outcome: 'aborted' }),
    ])

    // The worker that never answered is given up when its time is over, and does not keep its lock for the life of the tab.
    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS)
    await until(() => silent.terminations() === 1)
    expect(ofType(events, 'store')).toEqual([
      { type: 'store', backend: 'memory', capBytes: MEMORY_CAP_BYTES, reason: 'refused' },
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('plays on in memory when the worker of the store does not answer the open', async () => {
    fakeTimers()
    const server = await serve({ size: 2 * MIB })
    const { open, events } = rig(server)
    const silent = unservedWorker()

    const opening = open({
      makeWorker: silent.makeWorker,
      estimate: () => Promise.resolve({ quota: 10 * 1024 ** 3, usage: 0 }),
    })
    await until(() => silent.received() === 1)
    // The head's bytes are on their way over real sockets, which the fake clock does not move: they are in before it does.
    await until(() => server.openResponses() === 0)
    await sleep(50)
    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS)
    const downloader = await opening

    expect(silent.terminations()).toBe(1)
    expect(ofType(events, 'store')).toEqual([
      { type: 'store', backend: 'memory', capBytes: MEMORY_CAP_BYTES, reason: 'refused' },
    ])
    await downloader.whenHeld({ start: 0, end: HEAD_BYTES })
    await expectBytesRight(downloader, 0, HEAD_BYTES)
  })
})

describe('openDownload: a head that goes quiet', () => {
  const size = 2 * MIB
  const KIB = 1024

  interface Call {
    range: string
    from: number
    to: number
    signal: AbortSignal
  }

  /**
   * A `fetch` for the tests of the head: what the first request gets is `first`, a body that
   * the test feeds (`'feed'`), or no answer at all, which gives up when the request is
   * aborted, as a real one does (`'none'`); every later request gets all of its range.
   */
  function network(first: 'feed' | 'none'): {
    fetch: typeof fetch
    calls: Call[]
    push: (start: number, end: number) => void
  } {
    const calls: Call[] = []
    let feed: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchStub: typeof fetch = (_input, init) => {
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('the stub was given no signal')
      const range = new Headers(init?.headers).get('Range') ?? ''
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      const from = Number(match?.[1])
      const to = match?.[2] === '' ? size - 1 : Number(match?.[2])
      calls.push({ range, from, to, signal })
      const headers = { 'Content-Range': `bytes ${from}-${to}/${size}` }
      if (calls.length > 1) {
        return Promise.resolve(new Response(bytesOf(from, to + 1), { status: 206, headers }))
      }
      if (first === 'none') {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          feed = controller
          signal.addEventListener('abort', () => {
            try {
              controller.error(signal.reason)
            } catch {
              // A body that is over has nothing to break.
            }
          })
        },
      })
      return Promise.resolve(new Response(stream, { status: 206, headers }))
    }
    return {
      fetch: fetchStub,
      calls,
      push: (start, end) => {
        feed?.enqueue(bytesOf(start, end))
      },
    }
  }

  /** Options that keep the store from opening for STORE_OPEN_MS: its worker is alive and says nothing. */
  function slowStore(): Pick<OpenDownloadOptions, 'makeWorker' | 'estimate'> {
    return {
      makeWorker: unservedWorker().makeWorker,
      estimate: () => Promise.resolve({ quota: 10 * 1024 ** 3, usage: 0 }),
    }
  }

  it('gives up on a head that has no answer, and asks for it again after the usual pause', async () => {
    fakeTimers()
    const server = await serve({ size })
    const { open, events } = rig(server)
    const net = network('none')

    const opening = open({ fetch: net.fetch })
    await until(() => net.calls.length === 1)
    await vi.advanceTimersByTimeAsync(READ_IDLE_MS - 1)
    expect(ofType(events, 'retry')).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await until(() => ofType(events, 'retry').length === 1)

    expect(ofType(events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: 0 },
    ])
    expect(ofType(events, 'requestEnd')).toEqual([
      {
        type: 'requestEnd',
        id: 1,
        bytes: 0,
        outcome: 'failed',
        message: `The server sent nothing for ${READ_IDLE_MS / 1000} s after the request for bytes 0-${HEAD_BYTES - 1}.`,
      },
    ])
    expect(net.calls[0]?.signal.aborted).toBe(true)

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    const downloader = await opening
    expect(net.calls[1]).toMatchObject({ from: 0, to: HEAD_BYTES - 1 })
    await downloader.whenHeld({ start: 0, end: HEAD_BYTES })
    await expectBytesRight(downloader, 0, HEAD_BYTES)
  })

  it('gives up on a head whose body goes quiet, also while the store is opening, and the downloader reads on from the next byte', async () => {
    fakeTimers()
    const server = await serve({ size })
    const { open, events } = rig(server)
    const net = network('feed')

    const opening = open({ fetch: net.fetch, ...slowStore() })
    await until(() => net.calls.length === 1)
    net.push(0, 100 * KIB)
    await sleep(20)
    // The store has not opened, the head is quiet: its own limit ends it, and the downloader finds that when it takes the head over.
    await vi.advanceTimersByTimeAsync(READ_IDLE_MS)
    expect(ofType(events, 'retry')).toEqual([])
    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS - READ_IDLE_MS)
    const downloader = await opening
    await until(() => ofType(events, 'retry').length === 1)

    expect(ofType(events, 'retry')).toEqual([
      { type: 'retry', attempt: 1, delayMs: RETRY_BASE_MS, offset: 100 * KIB },
    ])
    expect(ofType(events, 'requestEnd')).toEqual([
      {
        type: 'requestEnd',
        id: 1,
        bytes: 100 * KIB,
        outcome: 'failed',
        message: `The server sent nothing for ${READ_IDLE_MS / 1000} s for bytes 0-${HEAD_BYTES - 1}, after 102400 of ${HEAD_BYTES} bytes.`,
      },
    ])
    expect(net.calls[0]?.signal.aborted).toBe(true)

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS)
    await until(() => net.calls.length === 2)
    expect(net.calls[1]).toMatchObject({ from: 100 * KIB })
    await until(() => downloader.state() === 'done')
    await expectBytesRight(downloader, 0, size)
  })

  it('does not count the time the store takes to open: a head that has all its bytes waits for as long as the store needs', async () => {
    fakeTimers()
    const whole = HEAD_BYTES
    const server = await serve({ size: whole })
    const { open, events } = rig(server)

    const opening = open({ ...slowStore() })
    await until(() => server.requests.length === 1)
    await until(() => server.openResponses() === 0)
    await sleep(50)
    // The store takes three times READ_IDLE_MS to open; the head has had all its bytes from the start.
    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS)
    const downloader = await opening
    await until(() => downloader.state() === 'done')

    expect(ofType(events, 'retry')).toEqual([])
    expect(server.requests).toHaveLength(1)
    expect(ofType(events, 'requestEnd')).toEqual([
      { type: 'requestEnd', id: 1, bytes: whole, outcome: 'done', message: null },
    ])
    await expectBytesRight(downloader, 0, whole)
  })

  it('does not give up on a head that is slow but keeps moving', async () => {
    fakeTimers()
    const server = await serve({ size })
    const { open, events } = rig(server)
    const net = network('feed')

    const opening = open({ fetch: net.fetch, ...slowStore() })
    await until(() => net.calls.length === 1)
    // A piece every 9 s: the head lasts 90 s, and no wait for a piece is as long as the limit. The store opens in the middle of it.
    for (let piece = 0; piece < 10; piece += 1) {
      await vi.advanceTimersByTimeAsync(READ_IDLE_MS - 1000)
      net.push(piece * 100 * KIB, (piece + 1) * 100 * KIB)
      await sleep(5)
    }
    const downloader = await opening
    await until(() => downloader.state() === 'reading')
    await sleep(20)

    expect(ofType(events, 'retry')).toEqual([])
    expect(net.calls).toHaveLength(1)
    expect(net.calls[0]?.signal.aborted).toBe(false)
  })
})

describe('openDownload: the clean-up of leftovers', () => {
  /** A private file system with a directory of plays, and locks, as far as the clean-up looks at them. */
  function privateFileSystem(
    playIds: string[],
    live: string[],
    hold: Promise<void>,
  ): { removed: string[] } {
    const removed: string[] = []
    const entries = new Set(playIds)
    const plays = {
      removeEntry(name: string): Promise<void> {
        removed.push(name)
        entries.delete(name)
        return Promise.resolve()
      },
      async *keys(): AsyncGenerator<string> {
        await Promise.resolve()
        for (const name of [...entries]) yield name
      },
    }
    const root = {
      getDirectoryHandle: async (name: string) => {
        await hold
        if (name !== PLAYS_DIRECTORY) throw new DOMException('not there', 'NotFoundError')
        return plays
      },
    }
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(root) },
      locks: {
        request: async (
          name: string,
          _options: unknown,
          callback: (lock: { name: string } | null) => Promise<unknown>,
        ) => await callback(live.some((id) => lockName(id) === name) ? null : { name }),
      },
    })
    return { removed }
  }

  it('removes the directory of a play that crashed, and not that of a play that is live, without waiting for it', async () => {
    const server = await serve({ size: 2 * MIB })
    const { open } = rig(server)
    const door = gate()
    const system = privateFileSystem(['crashed', 'live'], ['live'], door.wait)

    // The clean-up waits for the door; the download does not wait for the clean-up.
    const downloader = await open()
    await downloader.whenHeld({ start: 0, end: HEAD_BYTES })
    expect(system.removed).toEqual([])

    door.open()
    await until(() => system.removed.length > 0)
    await sleep(20)
    expect(system.removed).toEqual(['crashed'])
  })
})

// A share link has its token in the path (`/api/s/:token/files/:id/content`), and a timeline
// is kept by the server: no event of a play names any part of the file's route.
describe('openDownload: the route of a share link', () => {
  const TOKEN = 'SECRETTOKEN123'

  it('is in no event, whether the head, the body or a later read fails, or the play ends', async () => {
    fakeTimers()
    const server = await serve({
      size: 2 * MIB,
      faults: [
        { kind: 'status', status: 503 },
        { kind: 'drop', afterBytes: 300_000 },
        { kind: 'status', status: 404 },
      ],
    })
    const url = new URL(`/api/s/${TOKEN}/files/f1/content?play=1`, server.url).href
    const { open, events } = rig(server)

    // The head is refused once (open-download's own messages), then its body breaks (the downloader's), then the play ends.
    const opening = open({ url })
    await until(() => ofType(events, 'retry').length === 1)
    await vi.advanceTimersByTimeAsync(ofType(events, 'retry')[0]?.delayMs ?? 0)
    await opening
    await until(() => ofType(events, 'retry').length === 2)
    await vi.advanceTimersByTimeAsync(ofType(events, 'retry')[1]?.delayMs ?? 0)
    await until(() => ofType(events, 'error').length === 1)

    expect(server.requests).toEqual([
      { range: `bytes=0-${HEAD_BYTES - 1}` },
      { range: `bytes=0-${HEAD_BYTES - 1}` },
      { range: 'bytes=300000-' },
    ])
    const failed = ofType(events, 'requestEnd').filter((end) => end.outcome === 'failed')
    expect(failed.map((end) => end.message)).toEqual([
      `The server answered 503 for bytes 0-${HEAD_BYTES - 1}.`,
      expect.stringContaining('bytes 0-'),
      'The server answered 404 for bytes 300000-.',
    ])
    expect(ofType(events, 'error')).toEqual([
      {
        type: 'error',
        from: 'engine',
        code: 404,
        message: 'The server answered 404 for bytes 300000-.',
      },
    ])
    const record = JSON.stringify(events)
    for (const part of [TOKEN, '/api/', 'content', '127.0.0.1', 'play=1', '?']) {
      expect(record).not.toContain(part)
    }
  })
})
