import { setTimeout as sleep } from 'node:timers/promises'
import type { MessagePort } from 'node:worker_threads'
import type { TimelineEventInput } from '@dfs/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoreError } from './errors.ts'
import type { StoreErrorKind } from './errors.ts'
import {
  BLOCK_BYTES,
  DISK_CAP_BYTES,
  DISK_FLOOR_BYTES,
  ESTIMATE_MS,
  LATE_TIMER_MS,
  MEMORY_CAP_BYTES,
  STORE_CALL_MS,
  STORE_OPEN_MS,
  WAKE_GRACE_MS,
} from './limits.ts'
import { openPlayStore } from './open.ts'
import type { StoreWorker } from './open.ts'
import { parseRequest } from './protocol.ts'
import type { OpenDirectory } from './protocol.ts'
import { serveStore } from './serve.ts'
import type { PlayStore } from './store.ts'
import { TestPlayDirectory, testLock } from './testing/play-directory.ts'
import { WorkerStore } from './worker-store.ts'

// A play's store is opened on disk, through a worker, when the browser allows it, and in
// memory when it does not; and a disk that fills or fails during the play does not stop
// the play (DESIGN.md §10.4; the iron-clad spec §4.7). The tests make the worker from a
// `MessageChannel` and `serveStore`, over an in-memory directory, as the tests of the
// worker's client do, and tell the file to fail or the worker to die where a browser would.

const MIB = BLOCK_BYTES
const GIB = 1024 ** 3

/** A generator of numbers in [0, 1) from a seed (mulberry32): the same bytes on every run and every machine. */
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

/** One block of bytes, which the blocks of the file are made from. */
const BASE = (() => {
  const next = generator(7)
  const bytes = new Uint8Array(MIB)
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = Math.floor(next() * 256)
  return bytes
})()

/** Block `index` of the file that the tests play: a copy of its own (a write may give its buffer away), marked with the block's number so that no two blocks are alike. */
function block(index: number): Uint8Array<ArrayBuffer> {
  const bytes = BASE.slice()
  const view = new DataView(bytes.buffer)
  view.setUint32(0, index)
  view.setUint32(MIB / 2, index)
  view.setUint32(MIB - 4, index)
  return bytes
}

/** The file range of blocks `from` up to, not including, `to`. */
function blocks(from: number, to: number): { start: number; end: number } {
  return { start: from * MIB, end: to * MIB }
}

/** The 10 bytes around the end of block 0, as the file has them: the last 5 bytes of block 0 and the first 5 of block 1. */
function joined(first: number, second: number): Uint8Array {
  const bytes = new Uint8Array(10)
  bytes.set(block(first).subarray(MIB - 5), 0)
  bytes.set(block(second).subarray(0, 5), 5)
  return bytes
}

/** Expects `actual` to be bytes, equal to `expected` (compared whole, so that a failure doesn't print a megabyte). */
function expectSame(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual).not.toBeNull()
  if (actual === null) return
  expect(actual.length).toBe(expected.length)
  expect(Buffer.compare(actual, expected)).toBe(0)
}

/** The error that `attempt` fails with, or a failure of the test if it succeeds. */
async function failureOf(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt
  } catch (error) {
    return error
  }
  throw new Error('the attempt was expected to fail and did not')
}

/** Expects `attempt` to fail as a `StoreError` of the given kind. */
async function expectStoreError(attempt: Promise<unknown>, kind: StoreErrorKind): Promise<void> {
  const error = await failureOf(attempt)
  expect(error).toBeInstanceOf(StoreError)
  expect((error as StoreError).kind).toBe(kind)
}

/** Every port a test opens, and every store, so that they are all closed and vitest can exit. */
const ports: MessagePort[] = []
const stores: PlayStore[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const port of ports.splice(0)) port.close()
})

/** A worker made of a port: it counts how many times it was ended, and ending it closes the port. */
type TestWorker = MessagePort & StoreWorker & { terminations: number }

function workerOver(port: MessagePort, log: string[]): TestWorker {
  const worker: TestWorker = Object.assign(port, {
    terminations: 0,
    terminate() {
      worker.terminations += 1
      log.push('worker terminated')
      port.close()
    },
  })
  return worker
}

/** What a browser with a roomy origin says. */
const ROOMY = (): Promise<{ quota: number; usage: number }> =>
  Promise.resolve({ quota: 10 * GIB, usage: 0 })

/** The estimate of a browser that has `quota` bytes in all and has used `usage` of them. */
function estimateOf(quota: number, usage: number): () => Promise<{ quota: number; usage: number }> {
  return () => Promise.resolve({ quota, usage })
}

interface Rig {
  log: string[]
  /** What the timeline was sent. */
  events: TimelineEventInput[]
  directory: TestPlayDirectory
  /** The workers made so far, in order. */
  workers: TestWorker[]
  /** The types of the requests that the workers received, in order. */
  requests: string[]
  /** The caps that the workers were asked to open with, in order. */
  opens: number[]
  makeWorker: () => StoreWorker
  open: (options?: Partial<Parameters<typeof openPlayStore>[0]>) => Promise<PlayStore>
}

/** A worker over an in-memory directory and a logging lock, made as often as `makeWorker` is called, and what the test needs to see of them. */
function rig(instead: { openDirectory?: OpenDirectory } = {}): Rig {
  const log: string[] = []
  const events: TimelineEventInput[] = []
  const workers: TestWorker[] = []
  const requests: string[] = []
  const opens: number[] = []
  const directory = new TestPlayDirectory(log)
  const makeWorker = (): StoreWorker => {
    const { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    port2.on('message', (value: unknown) => {
      const request = parseRequest(value)
      if (request === null) return
      requests.push(request.type)
      if (request.type === 'open') opens.push(request.capBytes)
    })
    serveStore(port2, instead.openDirectory ?? (() => Promise.resolve(directory)), testLock(log))
    const worker = workerOver(port1, log)
    workers.push(worker)
    return worker
  }
  return {
    log,
    events,
    directory,
    workers,
    requests,
    opens,
    makeWorker,
    open: async (options = {}) => {
      const store = await openPlayStore({
        playId: 'play-1',
        fileSize: 8 * MIB,
        makeWorker,
        estimate: ROOMY,
        onEvent: (event) => {
          events.push(event)
        },
        ...options,
      })
      stores.push(store)
      return store
    },
  }
}

/** Writes blocks `from` up to, not including, `to`, one write each. */
async function fill(store: PlayStore, from: number, to: number): Promise<void> {
  for (let index = from; index < to; index += 1) await store.write(index * MIB, block(index))
}

/** Tells a store that its worker failed, as the browser does when a worker dies. */
function kill(worker: TestWorker | undefined): void {
  if (worker === undefined) throw new Error('the test has no worker to kill')
  worker.dispatchEvent(new Event('error'))
}

/** The clock of the timers, and nothing else: the messages between the page and the worker stay real. */
function fakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
}

/** Waits, on the real clock, until the condition holds (`vi.waitFor` moves the fake clock when it is faked). */
async function until(condition: () => boolean, limitMs = 5_000): Promise<void> {
  const began = performance.now()
  while (!condition()) {
    if (performance.now() - began > limitMs) throw new Error('timed out waiting for a condition')
    await sleep(1)
  }
}

/** The state of a promise, learned without waiting for it. */
function watch<T>(promise: Promise<T>): { state: 'pending' | 'settled'; value?: T } {
  const watched: { state: 'pending' | 'settled'; value?: T } = { state: 'pending' }
  promise.then(
    (value) => {
      watched.state = 'settled'
      watched.value = value
    },
    () => {
      watched.state = 'settled'
    },
  )
  return watched
}

/** Makes a worker alive and silent: what the page sends it from now on is lost, and it answers nothing. */
function silence(worker: TestWorker | undefined): void {
  if (worker === undefined) throw new Error('the test has no worker to silence')
  Object.assign(worker, { postMessage: () => undefined })
}

/** Makes a worker slow: what the page sends it from now on arrives `delayMs` later, by the fake clock. */
function slowdown(worker: TestWorker | undefined, delayMs: number): void {
  if (worker === undefined) throw new Error('the test has no worker to slow down')
  const send = worker.postMessage.bind(worker)
  Object.assign(worker, {
    postMessage: (message: unknown, transfer: ArrayBuffer[]) => {
      setTimeout(() => {
        send(message, transfer)
      }, delayMs)
    },
  })
}

/** Gives a worker its speed back, so that the close that ends the test does not wait for the real clock. */
function speedUp(worker: TestWorker | undefined): void {
  if (worker === undefined) throw new Error('the test has no worker to speed up')
  Reflect.deleteProperty(worker, 'postMessage')
}

/** Workers that are slow from the start, as `slowdown` makes them. */
function slowed(made: Rig, delayMs: number): () => StoreWorker {
  return () => {
    const worker = made.makeWorker()
    slowdown(made.workers.at(-1), delayMs)
    return worker
  }
}

/** Workers that nobody serves, which receive what is sent them and answer nothing: the test's `rig` ends them like the others. */
function unservedWorkers(made: Rig): { makeWorker: () => StoreWorker; received: () => number } {
  let received = 0
  return {
    received: () => received,
    makeWorker: () => {
      const { port1, port2 } = new MessageChannel()
      ports.push(port1, port2)
      port2.on('message', () => {
        received += 1
      })
      const worker = workerOver(port1, made.log)
      made.workers.push(worker)
      return worker
    },
  }
}

/** The `store` event for a disk store as asked. */
function opened(capBytes: number): TimelineEventInput {
  return { type: 'store', backend: 'disk', capBytes, reason: null }
}

/** The `store` event for a store in memory. */
function inMemory(reason: string): TimelineEventInput {
  return { type: 'store', backend: 'memory', capBytes: MEMORY_CAP_BYTES, reason }
}

describe('the cap of the disk store', () => {
  it('is the most a play may keep when the origin has room for far more', async () => {
    const { open, events } = rig()
    const store = await open({ estimate: estimateOf(10 * GIB, 0) })
    expect(store.backend).toBe('disk')
    expect(store.capBytes).toBe(DISK_CAP_BYTES)
    expect(events).toEqual([opened(DISK_CAP_BYTES)])
  })

  it.each([
    // 80% of 500 MB is 381.47 blocks.
    { quota: 1e9, usage: 5e8, blocks: 381 },
    // 80% of 512 MiB is 409.6 blocks.
    { quota: 1 * GIB, usage: 0.5 * GIB, blocks: 409 },
  ])(
    'is 80% of the free quota ($quota - $usage), in whole blocks: $blocks',
    async ({ quota, usage, blocks: count }) => {
      const { open, events, opens } = rig()
      const store = await open({ estimate: estimateOf(quota, usage) })
      expect(store.backend).toBe('disk')
      // The worker is asked for whole blocks.
      expect(opens).toEqual([count * MIB])
      expect(store.capBytes).toBe(count * MIB)
      expect(events).toEqual([opened(count * MIB)])
    },
  )

  it('uses a disk whose cap is exactly the floor, and memory for one block less', async () => {
    const atFloor = rig()
    // 80% of 81 MiB is 64.8 MiB: 64 blocks.
    const store = await atFloor.open({ estimate: estimateOf(81 * MIB, 0) })
    expect(store.backend).toBe('disk')
    expect(store.capBytes).toBe(DISK_FLOOR_BYTES)

    const below = rig()
    // 80% of 79 MiB is 63.2 MiB: 63 blocks.
    const memory = await below.open({ estimate: estimateOf(79 * MIB, 0) })
    expect(memory.backend).toBe('memory')
    expect(below.events).toEqual([inMemory('quota')])
  })

  it('goes to memory, with the reason quota, and makes no worker, when the cap is under the floor', async () => {
    const { open, events, workers } = rig()
    const store = await open({ estimate: estimateOf(70 * MIB, 0) })
    expect(store.backend).toBe('memory')
    expect(store.capBytes).toBe(MEMORY_CAP_BYTES)
    expect(events).toEqual([inMemory('quota')])
    expect(workers).toEqual([])
  })

  it('counts a quota that is all used, or more, as none', async () => {
    for (const usage of [1 * GIB, 2 * GIB]) {
      const { open, events, workers } = rig()
      const store = await open({ estimate: estimateOf(1 * GIB, usage) })
      expect(store.backend).toBe('memory')
      expect(events).toEqual([inMemory('quota')])
      expect(workers).toEqual([])
    }
  })

  it.each([
    { what: 'an estimate that rejects', estimate: () => Promise.reject(new Error('no estimate')) },
    {
      what: 'an estimate that throws',
      estimate: (): Promise<{ quota?: number; usage?: number }> => {
        throw new Error('no estimate')
      },
    },
    { what: 'an estimate with nothing in it', estimate: () => Promise.resolve({}) },
    { what: 'an estimate with no usage', estimate: () => Promise.resolve({ quota: 1e9 }) },
    { what: 'an estimate with no quota', estimate: () => Promise.resolve({ usage: 5e8 }) },
    {
      what: 'a quota that is not a number',
      estimate: () => Promise.resolve({ quota: Number.NaN, usage: 0 }),
    },
    {
      what: 'a quota that is infinite',
      estimate: () => Promise.resolve({ quota: Number.POSITIVE_INFINITY, usage: 0 }),
    },
  ])('is the most a play may keep with $what', async ({ estimate }) => {
    const { open, events } = rig()
    const store = await open({ estimate })
    expect(store.backend).toBe('disk')
    expect(store.capBytes).toBe(DISK_CAP_BYTES)
    expect(events).toEqual([opened(DISK_CAP_BYTES)])
  })

  it('asks the browser for its estimate when it is not given one, as a call of the storage', async () => {
    const storage = {
      estimate(this: unknown): Promise<{ quota: number; usage: number }> {
        // A browser throws "illegal invocation" when it is called without its storage.
        if (this !== storage) return Promise.reject(new TypeError('Illegal invocation'))
        return Promise.resolve({ quota: 90 * MIB, usage: 0 })
      },
    }
    vi.stubGlobal('navigator', { storage })
    const { open, events } = rig()
    const store = await open({ estimate: undefined })
    // 80% of 90 MiB.
    expect(store.capBytes).toBe(72 * MIB)
    expect(events).toEqual([opened(72 * MIB)])
  })

  it('is the most a play may keep when the browser has no estimate to give', async () => {
    vi.stubGlobal('navigator', {})
    const { open } = rig()
    const store = await open({ estimate: undefined })
    expect(store.backend).toBe('disk')
    expect(store.capBytes).toBe(DISK_CAP_BYTES)
  })
})

describe('choosing the store', () => {
  it('uses memory when there is no worker to make, and does not ask the browser for an estimate', async () => {
    const { open, events } = rig()
    const estimate = vi.fn(ROOMY)
    const store = await open({ makeWorker: null, estimate })
    expect(store.backend).toBe('memory')
    expect(store.capBytes).toBe(MEMORY_CAP_BYTES)
    expect(events).toEqual([inMemory('no-worker')])
    expect(estimate).not.toHaveBeenCalled()
  })

  it('uses memory when the worker cannot be made', async () => {
    const { open, events } = rig()
    const store = await open({
      makeWorker: () => {
        throw new Error('the content security policy refused the worker')
      },
    })
    expect(store.backend).toBe('memory')
    expect(events).toEqual([inMemory('no-worker')])
  })

  it('uses memory, with the reason refused, when the worker cannot open the file, and ends the worker', async () => {
    const { open, events, directory, workers, log } = rig()
    directory.openFailure = new DOMException('the file is locked', 'NoModificationAllowedError')
    const store = await open()
    expect(store.backend).toBe('memory')
    expect(events).toEqual([inMemory('refused')])
    expect(workers.map((worker) => worker.terminations)).toEqual([1])
    // The worker undid its open before it was ended.
    expect(log.slice(-2)).toEqual(['lock released play-1', 'worker terminated'])
  })

  it('uses memory, with the reason no-opfs, when the browser has no private file system, and ends the worker', async () => {
    const { open, events, workers } = rig({
      openDirectory: () => Promise.reject(new StoreError('no-opfs', 'no private file system')),
    })
    const store = await open()
    expect(store.backend).toBe('memory')
    expect(events).toEqual([inMemory('no-opfs')])
    expect(workers.map((worker) => worker.terminations)).toEqual([1])
  })

  it('uses memory, with the reason quota, when the disk is too full to try the file, and ends the worker', async () => {
    const { open, events, directory, workers } = rig()
    directory.file.failNextWrite('QuotaExceededError')
    const store = await open()
    expect(store.backend).toBe('memory')
    expect(events).toEqual([inMemory('quota')])
    expect(workers.map((worker) => worker.terminations)).toEqual([1])
  })

  it('uses memory, with the reason refused, when the worker dies while it opens, and ends it', async () => {
    const { log, events, workers } = rig()
    const store = await openPlayStore({
      playId: 'play-1',
      fileSize: 8 * MIB,
      estimate: ROOMY,
      onEvent: (event) => {
        events.push(event)
      },
      // A worker that never answers, and then fails.
      makeWorker: () => {
        const { port1, port2 } = new MessageChannel()
        ports.push(port1, port2)
        const worker = workerOver(port1, log)
        workers.push(worker)
        setTimeout(() => {
          kill(worker)
        }, 5)
        return worker
      },
    })
    stores.push(store)
    expect(store.backend).toBe('memory')
    expect(events).toEqual([inMemory('refused')])
    expect(workers.map((worker) => worker.terminations)).toEqual([1])
  })

  it('rejects a size that is not the size of a file, and makes no worker', async () => {
    const { open, workers, events } = rig()
    await expect(open({ fileSize: -1 })).rejects.toBeInstanceOf(RangeError)
    await expect(open({ fileSize: 1.5 })).rejects.toBeInstanceOf(RangeError)
    await expect(open({ fileSize: 1.5, makeWorker: null })).rejects.toBeInstanceOf(RangeError)
    expect(workers).toEqual([])
    expect(events).toEqual([])
  })

  it('sends one event when it opens, and no more for a store that does not fail', async () => {
    const { open, events } = rig()
    const store = await open()
    await fill(store, 0, 3)
    store.setPosition(2 * MIB)
    await store.read(0, MIB)
    expect(events).toHaveLength(1)
  })

  it('does not fail because the timeline does', async () => {
    const { open } = rig()
    const store = await open({
      onEvent: () => {
        throw new Error('the recorder is broken')
      },
    })
    expect(store.backend).toBe('disk')
  })
})

describe('a store in memory', () => {
  it('writes, reads and closes like any other, with the cap of memory', async () => {
    const { open } = rig()
    const store = await open({ makeWorker: null, fileSize: 4 * MIB })
    expect(store.backend).toBe('memory')
    expect(store.fileSize).toBe(4 * MIB)
    expect(store.capBytes).toBe(MEMORY_CAP_BYTES)
    await fill(store, 0, 2)
    expect(store.held().ranges()).toEqual([blocks(0, 2)])
    expectSame(await store.read(MIB - 5, MIB + 5), joined(0, 1))
    expect(store.stats()).toEqual({
      backend: 'memory',
      capBytes: MEMORY_CAP_BYTES,
      storedBytes: 2 * MIB,
      evictedBytes: 0,
    })
    await store.close()
    await expectStoreError(store.read(0, 10), 'closed')
    await expectStoreError(store.write(0, block(0)), 'closed')
    await store.close()
  })

  it('answers a range error as a range error', async () => {
    const { open } = rig()
    const store = await open({ makeWorker: null, fileSize: 2 * MIB })
    expect(await failureOf(store.write(MIB + 1, block(0)))).toBeInstanceOf(RangeError)
    expect(() => {
      store.setPosition(3 * MIB)
    }).toThrow(RangeError)
  })
})

describe('a store on disk', () => {
  it("writes and reads through the worker, and does not give away the caller's bytes", async () => {
    const { open, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    expect(store.backend).toBe('disk')
    expect(workers).toHaveLength(1)

    const bytes = block(0)
    const expected = block(0)
    await store.write(0, bytes)
    // The worker's client gives a buffer away when it writes; the caller's stays whole.
    expect(bytes.byteLength).toBe(MIB)
    expectSame(bytes, expected)
    expectSame(await store.read(0, MIB), expected)
    expect(store.held().ranges()).toEqual([blocks(0, 1)])
  })

  it('removes the directory, lets go of the lock, and then ends the worker when it closes', async () => {
    const { open, log, workers, directory } = rig()
    const store = await open()
    await store.write(0, block(0))
    log.length = 0
    await store.close()
    expect(log).toEqual([
      'file closed',
      'directory removed',
      'lock released play-1',
      'worker terminated',
    ])
    expect(directory.removals).toBe(1)
    expect(workers.map((worker) => worker.terminations)).toEqual([1])
    await expectStoreError(store.read(0, 10), 'closed')
    await expectStoreError(store.write(0, block(0)), 'closed')
    expect(() => {
      store.setPosition(0)
    }).toThrow(StoreError)
    await store.close()
    expect(workers.map((worker) => worker.terminations)).toEqual([1])
  })

  it('answers a range error as a range error, and goes on with the disk', async () => {
    const { open, events } = rig()
    const store = await open({ fileSize: 2 * MIB })
    expect(await failureOf(store.write(MIB + 1, block(0)))).toBeInstanceOf(RangeError)
    expect(await failureOf(store.read(5, 2))).toBeInstanceOf(RangeError)
    expect(() => {
      store.setPosition(3 * MIB)
    }).toThrow(RangeError)
    expect(store.backend).toBe('disk')
    expect(events).toHaveLength(1)
  })
})

describe('a disk that fills during the play', () => {
  /** A disk store of a file of 67 blocks, in which blocks 0 up to `used` are held. */
  async function filled(used: number): Promise<Rig & { store: PlayStore }> {
    const made = rig()
    const store = await made.open({ fileSize: 67 * MIB })
    await fill(store, 0, used)
    return { ...made, store }
  }

  it('keeps the blocks it holds as its cap, says so, and answers the write that met the full disk', async () => {
    const { store, directory, events, requests } = await filled(64)
    directory.file.failNextWrite('QuotaExceededError')
    const outcome = await store.write(64 * MIB, block(64))

    // The write is answered: block 64 is held, and waits for a slot as the position keeps the blocks that are held.
    expect(outcome).toEqual({ full: true, evictedBytes: 0, evicted: [] })
    expect(store.backend).toBe('disk')
    expect(store.capBytes).toBe(64 * MIB)
    expect(store.stats().capBytes).toBe(64 * MIB)
    expect(events).toEqual([opened(DISK_CAP_BYTES), { ...opened(64 * MIB), reason: 'quota' }])
    expect(requests.filter((type) => type === 'shrink')).toHaveLength(1)
    expect(store.held().ranges()).toEqual([blocks(0, 65)])
    expectSame(await store.read(64 * MIB, 65 * MIB), block(64))
    expectSame(await store.read(0, MIB), block(0))

    // The store works within its new cap: when the position moves, block 64 takes the slot of block 0.
    store.setPosition(64 * MIB)
    const placed = await store.write(64 * MIB, new Uint8Array(0))
    expect(placed).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
    expect(store.capBytes).toBe(64 * MIB)
    expect(store.stats().storedBytes).toBe(64 * MIB)
  })

  it("does not give the write its caller's buffer away when it tries it again", async () => {
    const { store, directory, events } = await filled(64)
    directory.file.failNextWrite('QuotaExceededError')
    const bytes = block(64)
    await store.write(64 * MIB, bytes)
    expect(bytes.byteLength).toBe(MIB)
    // A second try that was given a buffer that is gone would not have reached the worker, and the play would have moved to memory.
    expect(store.backend).toBe('disk')
    expect(events).toHaveLength(2)
  })

  it('moves to memory, with the reason quota, when the blocks it holds are fewer than the floor', async () => {
    const { store, directory, events, workers, log } = await filled(3)
    directory.file.failNextWrite('QuotaExceededError')
    const outcome = await store.write(3 * MIB, block(3))

    expect(outcome).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(store.backend).toBe('memory')
    expect(store.capBytes).toBe(MEMORY_CAP_BYTES)
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('quota')])
    // What the disk held is not read from it any more: memory holds the write and nothing else.
    expect(store.held().ranges()).toEqual([blocks(3, 4)])
    expect(await store.read(0, MIB)).toBeNull()
    expectSame(await store.read(3 * MIB, 4 * MIB), block(3))
    // The disk store is closed, its directory is removed, and its worker is ended.
    await vi.waitFor(() => {
      expect(workers[0]?.terminations).toBe(1)
    })
    expect(log.slice(-3)).toEqual([
      'directory removed',
      'lock released play-1',
      'worker terminated',
    ])
  })

  it('moves to memory, with the reason disk-error, when the disk is full again on the second try', async () => {
    const { store, directory, events } = await filled(66)
    // The position is at the end, so that the second try finds a block to let go of and writes its slot.
    store.setPosition(66 * MIB)
    vi.spyOn(directory.file, 'write').mockImplementation(() => {
      throw new DOMException('no room', 'QuotaExceededError')
    })
    const outcome = await store.write(66 * MIB, block(66))

    expect(outcome).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(store.backend).toBe('memory')
    expect(events).toEqual([
      opened(DISK_CAP_BYTES),
      { ...opened(66 * MIB), reason: 'quota' },
      inMemory('disk-error'),
    ])
    expect(store.held().ranges()).toEqual([blocks(66, 67)])
  })

  it('shrinks once, and says so once, for writes that meet the full disk together', async () => {
    const { store, directory, events, requests } = await filled(64)
    vi.spyOn(directory.file, 'write')
      .mockImplementationOnce(() => {
        throw new DOMException('no room', 'QuotaExceededError')
      })
      .mockImplementationOnce(() => {
        throw new DOMException('no room', 'QuotaExceededError')
      })
    // Neither block has a slot to be sealed into, and both of them meet the full disk.
    store.setPosition(66 * MIB)
    const outcomes = await Promise.all([
      store.write(65 * MIB, block(65)),
      store.write(66 * MIB, block(66)),
    ])

    expect(store.backend).toBe('disk')
    expect(requests.filter((type) => type === 'shrink')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'store')).toHaveLength(2)
    expect(outcomes).toHaveLength(2)
    expectSame(await store.read(65 * MIB, 66 * MIB), block(65))
    expectSame(await store.read(66 * MIB, 67 * MIB), block(66))
  })
})

describe('a disk that fails during the play', () => {
  it('moves to memory once when a failing disk is found out by two calls, one of them a shrink', async () => {
    const made = rig()
    const store = await made.open({ fileSize: 67 * MIB })
    await fill(store, 0, 64)
    // The shrink of the full disk waits until the test lets it go on, so that the play moves to memory first.
    let shrinks = 0
    let fail: (error: Error) => void = () => undefined
    vi.spyOn(WorkerStore.prototype, 'shrinkToUsed').mockImplementation(() => {
      shrinks += 1
      return new Promise((_resolve, reject) => {
        fail = reject
      })
    })
    made.directory.file.failNextWrite('QuotaExceededError')
    const full = store.write(64 * MIB, block(64))
    await vi.waitFor(() => {
      expect(shrinks).toBe(1)
    })
    made.directory.file.failNextWrite('InvalidStateError')
    await store.write(65 * MIB, block(65))
    expect(store.backend).toBe('memory')

    // The shrink fails now, for the disk store that the play has left: that is not a second change.
    fail(new StoreError('disk', 'the worker is gone'))
    await full
    expect(made.events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    expect(store.held().ranges()).toEqual([blocks(64, 66)])
  })

  it('moves to memory when a read meets a full disk, which only a write is shrunk for', async () => {
    const { open, events, requests } = rig()
    const store = await open({ fileSize: 4 * MIB })
    await fill(store, 0, 2)
    vi.spyOn(WorkerStore.prototype, 'read').mockRejectedValueOnce(
      new StoreError('quota', 'the browser has no room'),
    )
    expect(await store.read(0, MIB)).toBeNull()
    expect(store.backend).toBe('memory')
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    expect(requests).not.toContain('shrink')
  })

  it('moves to memory on the first failed write, holding nothing of the disk, and answers the write', async () => {
    const { open, events, directory, workers, log } = rig()
    const store = await open({ fileSize: 8 * MIB })
    await fill(store, 0, 2)
    expect(store.held().ranges()).toEqual([blocks(0, 2)])

    directory.file.failNextWrite('InvalidStateError')
    const outcome = await store.write(2 * MIB, block(2))

    expect(outcome).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(store.backend).toBe('memory')
    expect(store.capBytes).toBe(MEMORY_CAP_BYTES)
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    // The bytes of the disk cannot be read any more, so they are not held: the downloader fetches them again.
    expect(store.held().ranges()).toEqual([blocks(2, 3)])
    expect(await store.read(0, MIB)).toBeNull()
    expectSame(await store.read(2 * MIB, 3 * MIB), block(2))
    // The next writes and reads are the memory's.
    await store.write(5 * MIB, block(5))
    expectSame(await store.read(5 * MIB, 6 * MIB), block(5))
    expect(store.held().ranges()).toEqual([blocks(2, 3), blocks(5, 6)])
    expect(events).toHaveLength(2)

    // The disk store is closed in the background, and its worker ended once it has closed.
    await vi.waitFor(() => {
      expect(workers[0]?.terminations).toBe(1)
    })
    expect(log.slice(-4)).toEqual([
      'file closed',
      'directory removed',
      'lock released play-1',
      'worker terminated',
    ])
  })

  it('moves to memory when a read fails on the disk, and answers the read', async () => {
    const { open, events, directory } = rig()
    const store = await open()
    await fill(store, 0, 2)
    directory.file.failNextRead('InvalidStateError')
    expect(await store.read(0, MIB)).toBeNull()
    expect(store.backend).toBe('memory')
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    expect(store.held().ranges()).toEqual([])
  })

  it('moves to memory when a block fails to open, as a disk error', async () => {
    const { open, events, directory } = rig()
    const store = await open()
    await fill(store, 0, 2)
    directory.file.garbleNextRead()
    expect(await store.read(0, MIB)).toBeNull()
    expect(store.backend).toBe('memory')
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
  })

  it('moves to memory at the first call after the worker dies, and ends the worker without a word to it', async () => {
    const { open, events, workers, log } = rig()
    const store = await open({ fileSize: 4 * MIB })
    kill(workers[0])

    const outcome = await store.write(MIB, block(1))
    expect(outcome).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(store.backend).toBe('memory')
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    expectSame(await store.read(MIB, 2 * MIB), block(1))
    // The dead worker cannot close the file: it is ended, and the directory is left for the next start of the app.
    await vi.waitFor(() => {
      expect(workers[0]?.terminations).toBe(1)
    })
    expect(log).not.toContain('directory removed')
  })

  it("keeps the caller's bytes for the write that was in flight when the worker died, and writes them to memory", async () => {
    const { open, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    const bytes = block(1)
    const writing = store.write(MIB, bytes)
    // The buffer that the worker was sent is a copy, and the caller's is whole.
    expect(bytes.byteLength).toBe(MIB)
    kill(workers[0])
    expect(await writing).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(bytes.byteLength).toBe(MIB)
    expect(store.held().ranges()).toEqual([blocks(1, 2)])
    expectSame(await store.read(MIB, 2 * MIB), block(1))
  })

  it('moves to memory when the position is given to a worker that is gone, and keeps the position', async () => {
    const { open, events, workers } = rig()
    const store = await open({ fileSize: 300 * MIB })
    store.setPosition(299 * MIB)
    kill(workers[0])
    // The disk is found to be gone at this call, and the position goes to the memory.
    store.setPosition(299 * MIB)
    expect(store.backend).toBe('memory')
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    expect(() => {
      store.setPosition(300 * MIB + 1)
    }).toThrow(RangeError)

    // The memory fills to its cap, and the next block, nearer to the position than block 0, takes the place of block 0.
    const slots = MEMORY_CAP_BYTES / MIB
    await fill(store, 0, slots)
    const outcome = await store.write(slots * MIB, block(slots))
    expect(outcome).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
    expect(store.stats().evictedBytes).toBe(MIB)
  })

  it('does not record a position that is not one, even for a worker that is gone', async () => {
    const { open, events, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    kill(workers[0])
    expect(() => {
      store.setPosition(5 * MIB)
    }).toThrow(RangeError)
    // The call that was refused did not find out that the disk is gone.
    expect(store.backend).toBe('disk')
    expect(events).toHaveLength(1)
    // And the position that it refused is not the one the memory is given when the play does move.
    expect(await store.write(0, block(0))).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(store.backend).toBe('memory')
    expectSame(await store.read(0, MIB), block(0))
  })

  it('answers two writes that are in flight when the disk fails, both on memory, with one switch', async () => {
    const { open, events, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    const first = store.write(0, block(0))
    const second = store.write(MIB, block(1))
    kill(workers[0])

    const outcomes = await Promise.all([first, second])
    expect(outcomes).toEqual([
      { full: false, evictedBytes: 0, evicted: [] },
      { full: false, evictedBytes: 0, evicted: [] },
    ])
    expect(store.backend).toBe('memory')
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    expect(store.held().ranges()).toEqual([blocks(0, 2)])
    expectSame(await store.read(0, MIB), block(0))
    expectSame(await store.read(MIB, 2 * MIB), block(1))
    await vi.waitFor(() => {
      expect(workers[0]?.terminations).toBe(1)
    })
  })

  it('reads again, on memory, a read that was in flight when the disk failed', async () => {
    const { open, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    const reading = store.read(0, MIB)
    kill(workers[0])
    // The position finds out that the disk is gone, at once, and the play is on memory before the read fails.
    store.setPosition(0)
    expect(store.backend).toBe('memory')
    await store.write(0, block(0))
    // The read was sent to the disk and failed with it. It reads again, on memory, and meets what the write wrote.
    expectSame(await reading, block(0))
  })

  it('writes again, on memory, a write that the disk accepted after another failed', async () => {
    const { open, events, directory } = rig()
    const store = await open({ fileSize: 4 * MIB })
    // The worker answers the first write with a failure and the second with success, one after the other.
    directory.file.failNextWrite('InvalidStateError')
    const first = store.write(0, block(0))
    const second = store.write(MIB, block(1))

    await Promise.all([first, second])
    expect(store.backend).toBe('memory')
    expect(events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    // The second write succeeded on the disk that was given up, so it is made again on memory: both are held.
    expect(store.held().ranges()).toEqual([blocks(0, 2)])
    expectSame(await store.read(MIB, 2 * MIB), block(1))
  })

  it('counts what the disk evicted in what the play has evicted, after it moves to memory', async () => {
    // 80% of 90 MiB is 72 blocks.
    const { open, workers } = rig()
    const store = await open({ fileSize: 74 * MIB, estimate: estimateOf(90 * MIB, 0) })
    expect(store.capBytes).toBe(72 * MIB)
    store.setPosition(73 * MIB)
    await fill(store, 0, 74)
    expect(store.stats().evictedBytes).toBe(2 * MIB)

    kill(workers[0])
    await store.write(73 * MIB, new Uint8Array(0))
    expect(store.backend).toBe('memory')
    expect(store.stats()).toEqual({
      backend: 'memory',
      capBytes: MEMORY_CAP_BYTES,
      storedBytes: 0,
      evictedBytes: 2 * MIB,
    })
    await store.write(MIB, block(1))
    expect(store.stats().evictedBytes).toBe(2 * MIB)
    expect(store.stats().storedBytes).toBe(MIB)
  })

  it('does not hide a failure of the memory store, which none is expected to have', async () => {
    const { open, workers } = rig()
    const store = await open({ fileSize: 2 * MIB })
    kill(workers[0])
    await store.write(0, block(0))
    expect(await failureOf(store.write(MIB + 1, block(0)))).toBeInstanceOf(RangeError)
  })

  it('answers closed, and nothing else, to a call that meets the close of the play', async () => {
    const { open, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    const closing = store.close()
    // The worker has not answered the close, and a call made now is refused at once.
    await expectStoreError(store.write(0, block(0)), 'closed')
    await closing
    // A worker that failed is not a reason to move a play that has ended.
    kill(workers[0])
    await expectStoreError(store.read(0, 10), 'closed')
    expect(store.backend).toBe('disk')
  })

  it('answers closed to a call that was in flight when the play closed and the worker failed, and does not move', async () => {
    const { open, events, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    const writing = store.write(0, block(0))
    kill(workers[0])
    const closing = store.close()
    await expectStoreError(writing, 'closed')
    await closing
    expect(events).toHaveLength(1)
    await vi.waitFor(() => {
      expect(workers[0]?.terminations).toBe(1)
    })
  })

  it('closes a store that moved to memory, and a worker that is gone', async () => {
    const { open, workers } = rig()
    const store = await open({ fileSize: 4 * MIB })
    kill(workers[0])
    await store.write(0, block(0))
    await store.close()
    await expectStoreError(store.read(0, 10), 'closed')
    await expectStoreError(store.write(0, block(0)), 'closed')
    await vi.waitFor(() => {
      expect(workers[0]?.terminations).toBe(1)
    })
  })

  it('does not fail a write because the timeline does', async () => {
    const { open, workers } = rig()
    let failing = false
    const store = await open({
      fileSize: 4 * MIB,
      onEvent: () => {
        if (failing) throw new Error('the recorder is broken')
      },
    })
    failing = true
    kill(workers[0])
    expect(await store.write(0, block(0))).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(store.backend).toBe('memory')
  })
})

// A worker that is alive but does not answer is a worker that is gone, after a deadline: the
// play goes on in memory, with the reason, and the worker is ended (DESIGN.md §10.4). The
// timers are the tests' own, and the messages between the page and the worker are real.
describe('a worker that does not answer', () => {
  const NONE = { full: false, evictedBytes: 0, evicted: [] }

  it('uses memory, with the reason refused, and ends the worker, when the open is not answered in STORE_OPEN_MS', async () => {
    fakeTimers()
    const made = rig()
    const silent = unservedWorkers(made)
    const opening = watch(made.open({ makeWorker: silent.makeWorker }))
    await until(() => silent.received() === 1)

    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS - 1)
    expect(opening.state).toBe('pending')
    expect(made.events).toEqual([])
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])

    await vi.advanceTimersByTimeAsync(1)
    await until(() => opening.state === 'settled')
    expect(opening.value?.backend).toBe('memory')
    expect(made.events).toEqual([inMemory('refused')])
    expect(made.workers.map((worker) => worker.terminations)).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('opens the disk when the worker answers the open just inside STORE_OPEN_MS', async () => {
    fakeTimers()
    const made = rig()
    const opening = watch(made.open({ makeWorker: slowed(made, STORE_OPEN_MS - 1) }))
    await until(() => made.workers.length === 1)
    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS - 1)
    await until(() => opening.state === 'settled')
    expect(opening.value?.backend).toBe('disk')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])
    expect(vi.getTimerCount()).toBe(0)
    speedUp(made.workers[0])
  })

  it('answers a read and a write from memory when the worker stops answering mid-play, in STORE_CALL_MS, with one event', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB })
    await store.write(0, block(0))
    silence(made.workers[0])

    const reading = watch(store.read(0, MIB))
    const writing = watch(store.write(MIB, block(1)))
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS - 1)
    expect(reading.state).toBe('pending')
    expect(writing.state).toBe('pending')
    expect(store.backend).toBe('disk')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])

    await vi.advanceTimersByTimeAsync(1)
    await until(() => reading.state === 'settled' && writing.state === 'settled')
    // What the disk held is not read from the dead worker, and the write is the memory's.
    expect(reading.value).toBeNull()
    expect(writing.value).toEqual(NONE)
    expect(store.backend).toBe('memory')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    expect(store.held().ranges()).toEqual([blocks(1, 2)])
    expectSame(await store.read(MIB, 2 * MIB), block(1))
    await until(() => made.workers[0]?.terminations === 1)
    // The dead worker is not asked to close, and the directory is left for the next start of the app.
    expect(made.log).not.toContain('directory removed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('moves to memory when a write alone is not answered, and answers it', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB })
    silence(made.workers[0])
    const writing = watch(store.write(0, block(0)))
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS)
    await until(() => writing.state === 'settled')
    expect(writing.value).toEqual(NONE)
    expect(store.backend).toBe('memory')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
  })

  it('does not move the play for a worker that answers just inside STORE_CALL_MS, and leaves no timer behind', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB })
    slowdown(made.workers[0], STORE_CALL_MS - 1)

    const writing = watch(store.write(0, block(0)))
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS - 1)
    await until(() => writing.state === 'settled')
    expect(writing.value).toEqual(NONE)
    expect(store.backend).toBe('disk')
    expect(store.held().ranges()).toEqual([blocks(0, 1)])
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])
    expect(vi.getTimerCount()).toBe(0)

    // Past the deadline that the answered request had, the disk is the store still.
    await vi.advanceTimersByTimeAsync(2 * STORE_CALL_MS)
    const reading = watch(store.read(0, MIB))
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS - 1)
    await until(() => reading.state === 'settled')
    expectSame(reading.value ?? null, block(0))
    expect(store.backend).toBe('disk')
    expect(made.events).toHaveLength(1)
    speedUp(made.workers[0])
  })

  it('closes a store whose worker does not answer, in STORE_CALL_MS, and ends the worker', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB })
    await store.write(0, block(0))
    silence(made.workers[0])

    const closing = watch(store.close())
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS - 1)
    expect(closing.state).toBe('pending')
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])

    await vi.advanceTimersByTimeAsync(1)
    await until(() => closing.state === 'settled')
    await until(() => made.workers[0]?.terminations === 1)
    expect(vi.getTimerCount()).toBe(0)
    await expectStoreError(store.read(0, 10), 'closed')
    await expectStoreError(store.write(0, block(0)), 'closed')
    // A second close is the first's answer, and ends nothing twice.
    await store.close()
    expect(made.workers.map((worker) => worker.terminations)).toEqual([1])
  })

  it('answers the close of the play, and ends the worker, in STORE_CALL_MS even when the store never settles its own close', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB })
    vi.spyOn(WorkerStore.prototype, 'close').mockImplementation(() => new Promise(() => undefined))

    const closing = watch(store.close())
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS - 1)
    expect(closing.state).toBe('pending')
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await until(() => closing.state === 'settled')
    expect(made.workers.map((worker) => worker.terminations)).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends the worker of a disk that the play left in STORE_CALL_MS even when the store never settles its own close', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB })
    vi.spyOn(WorkerStore.prototype, 'close').mockImplementation(() => new Promise(() => undefined))
    made.directory.file.failNextWrite('InvalidStateError')
    expect(await store.write(0, block(0))).toEqual(NONE)
    expect(store.backend).toBe('memory')

    await vi.advanceTimersByTimeAsync(STORE_CALL_MS - 1)
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    await until(() => made.workers[0]?.terminations === 1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer behind when the store closes in the ordinary way', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB })
    await store.write(0, block(0))
    await store.close()
    expect(made.workers.map((worker) => worker.terminations)).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)

    // Nor when the play left the disk and its worker closed it.
    const second = rig()
    const moved = await second.open({ fileSize: 4 * MIB })
    second.directory.file.failNextWrite('InvalidStateError')
    await moved.write(0, block(0))
    await until(() => second.workers[0]?.terminations === 1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// A page that was asleep, frozen or throttled fires its timers late, with the worker's answers
// still waiting to be handled: a deadline that fires more than `LATE_TIMER_MS` late by the clock
// is given `WAKE_GRACE_MS` more, once, so that a laptop that is closed and opened does not cost
// the play its disk store (DESIGN.md §10.4). The clock is the test's own, which it moves by hand.
describe('a page that stood still while it waited', () => {
  const NONE = { full: false, evictedBytes: 0, evicted: [] }

  /** A clock that the test moves, in milliseconds. */
  function handClock(): { now: () => number; to: (ms: number) => void } {
    let at = 0
    return {
      now: () => at,
      to: (ms) => {
        at = ms
      },
    }
  }

  it('keeps the disk, and says nothing, when the worker answers in the grace after the page slept', async () => {
    fakeTimers()
    const clock = handClock()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB, now: clock.now })
    await store.write(0, block(0))
    // The request reaches the worker 0.5 s after its deadline, as if the page had held it back.
    slowdown(made.workers[0], STORE_CALL_MS + 500)
    const writing = watch(store.write(MIB, block(1)))

    // The page slept: the timer of the request fires late by the clock.
    clock.to(STORE_CALL_MS + LATE_TIMER_MS + 1)
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS)
    expect(writing.state).toBe('pending')
    expect(store.backend).toBe('disk')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])

    await vi.advanceTimersByTimeAsync(500)
    await until(() => writing.state === 'settled')
    expect(writing.value).toEqual(NONE)
    expect(store.backend).toBe('disk')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])
    expect(store.held().ranges()).toEqual([blocks(0, 2)])
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])
    expect(vi.getTimerCount()).toBe(0)
    speedUp(made.workers[0])
  })

  it('moves to memory, with the reason disk-error, when the grace is over and the worker has not answered', async () => {
    fakeTimers()
    const clock = handClock()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB, now: clock.now })
    await store.write(0, block(0))
    silence(made.workers[0])
    const writing = watch(store.write(MIB, block(1)))

    clock.to(STORE_CALL_MS + LATE_TIMER_MS + 1)
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS)
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS - 1)
    expect(writing.state).toBe('pending')
    expect(store.backend).toBe('disk')
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])

    await vi.advanceTimersByTimeAsync(1)
    await until(() => writing.state === 'settled')
    expect(writing.value).toEqual(NONE)
    expect(store.backend).toBe('memory')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
    await until(() => made.workers[0]?.terminations === 1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('moves to memory at once when the deadline fires on time by the clock', async () => {
    fakeTimers()
    const clock = handClock()
    const made = rig()
    const store = await made.open({ fileSize: 4 * MIB, now: clock.now })
    silence(made.workers[0])
    const writing = watch(store.write(0, block(0)))

    // The clock has gone as far as the deadline and one second more: that is not late enough.
    clock.to(STORE_CALL_MS + LATE_TIMER_MS)
    await vi.advanceTimersByTimeAsync(STORE_CALL_MS)
    await until(() => writing.state === 'settled')
    expect(store.backend).toBe('memory')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES), inMemory('disk-error')])
  })

  it('opens the disk when the worker answers the open in the grace after the page slept', async () => {
    fakeTimers()
    const clock = handClock()
    const made = rig()
    const opening = watch(
      made.open({ now: clock.now, makeWorker: slowed(made, STORE_OPEN_MS + 500) }),
    )
    await until(() => made.workers.length === 1)

    clock.to(STORE_OPEN_MS + LATE_TIMER_MS + 1)
    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS)
    expect(opening.state).toBe('pending')
    expect(made.events).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    await until(() => opening.state === 'settled')
    expect(opening.value?.backend).toBe('disk')
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])
    expect(vi.getTimerCount()).toBe(0)
    speedUp(made.workers[0])
  })

  it('uses memory, with the reason refused, when the grace of the open is over', async () => {
    fakeTimers()
    const clock = handClock()
    const made = rig()
    const silent = unservedWorkers(made)
    const opening = watch(made.open({ now: clock.now, makeWorker: silent.makeWorker }))
    await until(() => silent.received() === 1)

    clock.to(STORE_OPEN_MS + LATE_TIMER_MS + 1)
    await vi.advanceTimersByTimeAsync(STORE_OPEN_MS + WAKE_GRACE_MS - 1)
    expect(opening.state).toBe('pending')
    expect(made.workers.map((worker) => worker.terminations)).toEqual([0])

    await vi.advanceTimersByTimeAsync(1)
    await until(() => opening.state === 'settled')
    expect(opening.value?.backend).toBe('memory')
    expect(made.events).toEqual([inMemory('refused')])
    expect(made.workers.map((worker) => worker.terminations)).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('an estimate that does not come', () => {
  it('gives the disk its full cap when the estimate has not come in ESTIMATE_MS', async () => {
    fakeTimers()
    const made = rig()
    const opening = watch(made.open({ estimate: () => new Promise(() => undefined) }))
    await until(() => vi.getTimerCount() === 1)

    await vi.advanceTimersByTimeAsync(ESTIMATE_MS - 1)
    expect(opening.state).toBe('pending')
    expect(made.workers).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await until(() => opening.state === 'settled')
    expect(opening.value?.backend).toBe('disk')
    expect(opening.value?.capBytes).toBe(DISK_CAP_BYTES)
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("gives the disk its full cap when the browser's own estimate does not come", async () => {
    fakeTimers()
    vi.stubGlobal('navigator', { storage: { estimate: () => new Promise(() => undefined) } })
    const made = rig()
    const opening = watch(made.open({ estimate: undefined }))
    await until(() => vi.getTimerCount() === 1)
    await vi.advanceTimersByTimeAsync(ESTIMATE_MS)
    await until(() => opening.state === 'settled')
    expect(opening.value?.capBytes).toBe(DISK_CAP_BYTES)
    expect(made.events).toEqual([opened(DISK_CAP_BYTES)])
  })

  it('takes an estimate that comes just inside ESTIMATE_MS, and leaves no timer behind', async () => {
    fakeTimers()
    const made = rig()
    const opening = watch(
      made.open({
        // 80% of 90 MiB.
        estimate: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ quota: 90 * MIB, usage: 0 })
            }, ESTIMATE_MS - 1)
          }),
      }),
    )
    await until(() => vi.getTimerCount() === 2)
    await vi.advanceTimersByTimeAsync(ESTIMATE_MS - 1)
    await until(() => opening.state === 'settled')
    expect(opening.value?.capBytes).toBe(72 * MIB)
    expect(made.events).toEqual([opened(72 * MIB)])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not wait for the estimate when there is no worker to make, and sets no timer', async () => {
    fakeTimers()
    const made = rig()
    const store = await made.open({ makeWorker: null })
    expect(store.backend).toBe('memory')
    expect(vi.getTimerCount()).toBe(0)
  })
})
