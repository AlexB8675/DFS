import type { MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoreError } from './errors.ts'
import type { StoreErrorKind } from './errors.ts'
import { BLOCK_BYTES } from './limits.ts'
import { parseReply, parseRequest } from './protocol.ts'
import type { OpenDirectory, PlayLock, StoreReply, StoreRequest } from './protocol.ts'
import { SEAL_OVERHEAD, newPlayKey } from './seal.ts'
import { serveStore } from './serve.ts'
import { CoreStore } from './store.ts'
import type { PlayStore, StoreStats, WriteOutcome } from './store.ts'
import { TestSlotFile } from './testing/slot-file.ts'
import { TestPlayDirectory, testLock } from './testing/play-directory.ts'
import { WorkerStore } from './worker-store.ts'

// A play's disk store runs in a worker that holds its key and its file, and the page
// talks to it through `WorkerStore`, which answers the same questions as the store
// itself (DESIGN.md §10.4; the iron-clad spec §4.7). The tests join the client and
// `serveStore` with a `MessageChannel`, over an in-memory directory and a lock that
// logs; the browser has its own suite for the real thing.

const MIB = BLOCK_BYTES

/** The size of a slot on disk: a whole block and what sealing adds to it. */
const SLOT_BYTES = BLOCK_BYTES + SEAL_OVERHEAD

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

/** `length` bytes from a seed, the same on every run. */
function bytesOf(seed: number, length: number): Uint8Array<ArrayBuffer> {
  const next = generator(seed)
  const bytes = new Uint8Array(length)
  for (let at = 0; at < length; at += 1) bytes[at] = Math.floor(next() * 256)
  return bytes
}

/** The content of the file that the tests play: byte `n` of it is `CONTENT[n]`. */
const CONTENT = bytesOf(7, 8 * MIB)

/** A copy of bytes `[start, end)` of `CONTENT`: a write gives its buffer away, so each one gets its own. */
function piece(start: number, end: number): Uint8Array<ArrayBuffer> {
  return CONTENT.slice(start, end)
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

/** Every port a test opens, so that they are all closed and vitest can exit. */
const ports: MessagePort[] = []

afterEach(() => {
  for (const port of ports.splice(0)) port.close()
})

/** A channel between a client and a server, both ends closed after the test. */
function channel(): { client: MessagePort; server: MessagePort } {
  const { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  return { client: port1, server: port2 }
}

const OPTIONS = { playId: 'play-1', fileSize: 8 * MIB, capBytes: 8 * MIB }

/** A worker over an in-memory directory and a logging lock (or those a test gives), and the client's end of its channel. */
function rig(instead: { openDirectory?: OpenDirectory; lock?: PlayLock } = {}): {
  log: string[]
  directory: TestPlayDirectory
  client: MessagePort
  open: (options?: Partial<typeof OPTIONS>) => Promise<WorkerStore>
} {
  const log: string[] = []
  const directory = new TestPlayDirectory(log)
  const { client, server } = channel()
  serveStore(
    server,
    instead.openDirectory ?? (() => Promise.resolve(directory)),
    instead.lock ?? testLock(log),
  )
  return {
    log,
    directory,
    client,
    open: (options) => WorkerStore.open(client, { ...OPTIONS, ...options }),
  }
}

/** A server that only records what it is asked, and answers when the test says so. */
class Script {
  readonly client: MessagePort
  readonly #server: MessagePort
  /** The requests received, in order. */
  readonly seen: StoreRequest[] = []

  constructor() {
    const { client, server } = channel()
    this.client = client
    this.#server = server
    server.on('message', (value: unknown) => {
      const request = parseRequest(value)
      if (request === null) throw new Error('the client sent a message that is not a request')
      this.seen.push(request)
    })
  }

  /** Waits until the request at `index` has arrived, and gives it, which must be of the given type. */
  async request<T extends StoreRequest['type']>(
    index: number,
    type: T,
  ): Promise<Extract<StoreRequest, { type: T }>> {
    await vi.waitFor(() => {
      expect(this.seen.length).toBeGreaterThan(index)
    })
    const request = this.seen[index]
    if (request?.type !== type) {
      throw new Error(`request ${index} is a ${request?.type ?? 'nothing'}, not a ${type}`)
    }
    return request as Extract<StoreRequest, { type: T }>
  }

  send(reply: StoreReply): void {
    this.#server.postMessage(reply)
  }

  /** Sends the client anything at all, as a worker that is not ours could. */
  sendRaw(value: unknown): void {
    this.#server.postMessage(value)
  }

  /** Opens a store on this server, answering the open request with the given cap. */
  async open(capBytes = 4 * MIB): Promise<WorkerStore> {
    const opening = WorkerStore.open(this.client, { ...OPTIONS, capBytes })
    const request = await this.request(0, 'open')
    this.send({ id: request.id, ok: true, type: 'open', capBytes, stats: stats({ capBytes }) })
    return opening
  }
}

/** Stats with the given fields. */
function stats(fields: Partial<StoreStats> = {}): StoreStats {
  return { backend: 'disk', capBytes: 4 * MIB, storedBytes: 0, evictedBytes: 0, ...fields }
}

describe('a store in a worker', () => {
  it('writes and reads back 3.5 MiB, and holds what it was given', async () => {
    const { open } = rig()
    const store = await open({ fileSize: 4 * MIB, capBytes: 8 * MIB })
    expect(store.backend).toBe('disk')
    expect(store.fileSize).toBe(4 * MIB)
    expect(store.held().ranges()).toEqual([])

    const length = 3.5 * MIB
    const outcome = await store.write(0, piece(0, length))
    expect(outcome).toEqual({ full: false, evictedBytes: 0, evicted: [] })
    expect(store.held().ranges()).toEqual([{ start: 0, end: length }])
    expectSame(await store.read(0, length), CONTENT.subarray(0, length))
    // A read that starts and ends inside blocks, and one that crosses a slot into the frontier.
    expectSame(await store.read(MIB / 2, 2.5 * MIB), CONTENT.subarray(MIB / 2, 2.5 * MIB))
    expectSame(await store.read(2.75 * MIB, length), CONTENT.subarray(2.75 * MIB, length))
    expect(await store.read(length, 4 * MIB)).toBeNull()
    expect(store.stats()).toEqual(stats({ capBytes: 8 * MIB, storedBytes: 3 * MIB }))
  })

  it('takes its cap from the answer, in whole blocks', async () => {
    const { open } = rig()
    const store = await open({ capBytes: 2.5 * MIB })
    expect(store.capBytes).toBe(2 * MIB)
    expect(store.stats().capBytes).toBe(2 * MIB)
  })

  it('hands a copy of what it holds, which the caller cannot change it with', async () => {
    const { open } = rig()
    const store = await open()
    await store.write(0, piece(0, MIB))
    const held = store.held()
    held.remove({ start: 0, end: MIB })
    expect(store.held().ranges()).toEqual([{ start: 0, end: MIB }])
  })

  it('refuses a position that is not in the file, at once and without a message', async () => {
    const script = new Script()
    const store = await script.open()
    expect(() => {
      store.setPosition(-1)
    }).toThrow(RangeError)
    expect(() => {
      store.setPosition(OPTIONS.fileSize + 1)
    }).toThrow(RangeError)
    expect(() => {
      store.setPosition(1.5)
    }).toThrow(RangeError)
    store.setPosition(OPTIONS.fileSize)
    await vi.waitFor(() => {
      expect(script.seen.length).toBe(2)
    })
    expect(script.seen[1]).toEqual({ type: 'position', offset: OPTIONS.fileSize })
  })

  it('rethrows a refused write as a RangeError, and holds nothing more', async () => {
    const { open } = rig()
    const store = await open({ fileSize: 2 * MIB })
    const error = await failureOf(store.write(1.5 * MIB, piece(0, MIB)))
    expect(error).toBeInstanceOf(RangeError)
    expect(store.held().ranges()).toEqual([])
    await expect(store.read(0, 5)).resolves.toBeNull()
  })

  it('refuses a store that cannot hold a block, as a RangeError, and undoes the open', async () => {
    const { open, log, directory } = rig()
    const error = await failureOf(open({ capBytes: 1000 }))
    expect(error).toBeInstanceOf(RangeError)
    expect(log).toEqual([
      'lock taken play-1',
      'file opened',
      'file closed',
      'directory removed',
      'lock released play-1',
    ])
    expect(directory.removals).toBe(1)
  })
})

describe('what crosses to the worker', () => {
  it('gives the written buffer away', async () => {
    const { open } = rig()
    const store = await open()
    const bytes = piece(0, MIB)
    await store.write(0, bytes)
    expect(bytes.byteLength).toBe(0)
    expect(bytes.buffer.byteLength).toBe(0)
  })

  it('copies bytes that are a part of a larger buffer, so that the rest of it is not given away', async () => {
    const { open } = rig()
    const store = await open()
    const parent = piece(0, 3 * MIB)
    const view = parent.subarray(MIB, 2 * MIB)
    await store.write(MIB, view)
    expect(parent.byteLength).toBe(3 * MIB)
    expectSame(await store.read(MIB, 2 * MIB), CONTENT.subarray(MIB, 2 * MIB))
  })

  it('can write bytes of a SharedArrayBuffer, which cannot be transferred', async () => {
    const { open } = rig()
    const store = await open()
    const shared = new Uint8Array(new SharedArrayBuffer(MIB))
    shared.set(CONTENT.subarray(0, MIB))
    await store.write(0, shared)
    expect(shared.byteLength).toBe(MIB)
    expectSame(await store.read(0, MIB), CONTENT.subarray(0, MIB))
  })
})

describe('opening and closing', () => {
  it('takes the play lock before it opens the directory, and holds it while the store is open', async () => {
    const { open, log } = rig()
    await open()
    expect(log).toEqual(['lock taken play-1', 'file opened'])
  })

  it('probes the file in its first slot and leaves it empty, so that no gap is written', async () => {
    const { open, directory } = rig()
    // A play may take up to 2 GiB: a probe in the last slot would write a file that long.
    const store = await open({ fileSize: 100 * MIB, capBytes: 2 * 1024 ** 3 })
    expect(store.capBytes).toBe(2 * 1024 ** 3)
    expect(directory.file.writes).toEqual([{ at: 0, length: SLOT_BYTES }])
    expect(directory.file.getSize()).toBe(0)
    expect(directory.file.raw().length).toBe(0)
  })

  it('closes the file, then removes the directory, then releases the lock', async () => {
    const { open, log, directory } = rig()
    const store = await open()
    await store.write(0, piece(0, MIB))
    log.length = 0
    await store.close()
    expect(log).toEqual(['file closed', 'directory removed', 'lock released play-1'])
    expect(directory.removals).toBe(1)
    expect(directory.file.closed).toBe(true)
  })

  it('releases the lock and answers when the directory cannot be removed', async () => {
    const { open, log, directory } = rig()
    const store = await open()
    directory.removeFailure = new DOMException('a file is in use', 'NoModificationAllowedError')
    log.length = 0
    await store.close()
    expect(log).toEqual(['file closed', 'directory removed', 'lock released play-1'])
  })

  it('serves a play again after it closed', async () => {
    const { open, log } = rig()
    const first = await open()
    await first.close()
    log.length = 0
    const second = await open()
    await second.write(0, piece(0, MIB))
    expectSame(await second.read(0, MIB), CONTENT.subarray(0, MIB))
    expect(log).toEqual(['lock taken play-1', 'file opened'])
  })
})

describe('when the open fails', () => {
  /** What the worker did to undo an open that took the lock and opened the file. */
  const UNDONE = [
    'lock taken play-1',
    'file opened',
    'file closed',
    'directory removed',
    'lock released play-1',
  ]

  it('refuses when the probe cannot write the file', async () => {
    const { open, log, directory } = rig()
    directory.file.failNextWrite('InvalidStateError')
    await expectStoreError(open(), 'refused')
    expect(log).toEqual(UNDONE)
    expect(directory.removals).toBe(1)
  })

  it('refuses when the probe cannot read the file', async () => {
    const { open, log, directory } = rig()
    directory.file.failNextRead('InvalidStateError')
    await expectStoreError(open(), 'refused')
    expect(log).toEqual(UNDONE)
  })

  it('refuses when the probe reads back what it did not write', async () => {
    const { open, log, directory } = rig()
    directory.file.garbleNextRead()
    await expectStoreError(open(), 'refused')
    expect(log).toEqual(UNDONE)
  })

  it('says quota when the probe finds the disk full', async () => {
    const { open, log, directory } = rig()
    directory.file.failNextWrite('QuotaExceededError')
    await expectStoreError(open(), 'quota')
    expect(log).toEqual(UNDONE)
  })

  it('says quota when the browser refuses the file for lack of room', async () => {
    const { open, log, directory } = rig()
    directory.openFailure = new DOMException('no room', 'QuotaExceededError')
    await expectStoreError(open(), 'quota')
    expect(log).toEqual(['lock taken play-1', 'directory removed', 'lock released play-1'])
  })

  it('refuses when the file cannot be opened for any other reason', async () => {
    const { open, directory } = rig()
    directory.openFailure = new DOMException('denied', 'NotAllowedError')
    await expectStoreError(open(), 'refused')
  })

  it('says no-opfs when the directory reports that the browser has none, and removes nothing', async () => {
    const { open, log } = rig({
      openDirectory: () => Promise.reject(new StoreError('no-opfs', 'no private file system here')),
    })
    await expectStoreError(open(), 'no-opfs')
    expect(log).toEqual(['lock taken play-1', 'lock released play-1'])
  })

  it('refuses when the directory fails with something that is not a StoreError', async () => {
    const { open, log } = rig({
      openDirectory: () => Promise.reject(new Error('the directory fell over')),
    })
    await expectStoreError(open(), 'refused')
    expect(log).toEqual(['lock taken play-1', 'lock released play-1'])
  })

  it('refuses when the lock cannot be taken, before it opens anything', async () => {
    const { open, log } = rig({ lock: () => Promise.reject(new Error('the lock manager is gone')) })
    await expectStoreError(open(), 'refused')
    expect(log).toEqual([])
  })

  it('leaves no store behind: the next open can succeed', async () => {
    const { open, directory } = rig()
    directory.file.failNextWrite('InvalidStateError')
    await expectStoreError(open(), 'refused')
    const store = await open()
    await store.write(0, piece(0, MIB))
    expectSame(await store.read(0, MIB), CONTENT.subarray(0, MIB))
  })
})

describe('when a write or a read fails', () => {
  it('says quota when the disk is full', async () => {
    const { open, directory } = rig()
    const store = await open()
    directory.file.failNextWrite('QuotaExceededError')
    await expectStoreError(store.write(0, piece(0, MIB)), 'quota')
  })

  it('says disk when the file fails otherwise', async () => {
    const { open, directory } = rig()
    const store = await open()
    directory.file.failNextWrite('InvalidStateError')
    await expectStoreError(store.write(0, piece(0, MIB)), 'disk')
  })

  it('says disk when a read of the file fails', async () => {
    const { open, directory } = rig()
    const store = await open()
    await store.write(0, piece(0, MIB))
    directory.file.failNextRead('InvalidStateError')
    await expectStoreError(store.read(0, 100), 'disk')
  })

  it('keeps going after a failed write: the same block is written by the next', async () => {
    const { open, directory } = rig()
    const store = await open()
    directory.file.failNextWrite('QuotaExceededError')
    await expectStoreError(store.write(0, piece(0, MIB)), 'quota')
    await store.write(0, new Uint8Array(0))
    expectSame(await store.read(0, MIB), CONTENT.subarray(0, MIB))
    expect(store.stats().storedBytes).toBe(MIB)
  })
})

describe('what the client holds', () => {
  /** A store of two slots over a file of eight blocks, with blocks 0 and 1 stored. */
  async function full(): Promise<{ store: WorkerStore; directory: TestPlayDirectory }> {
    const { open, directory } = rig()
    const store = await open({ capBytes: 2 * MIB })
    await store.write(0, piece(0, 2 * MIB))
    return { store, directory }
  }

  it('follows eviction across the boundary, the moment the write resolves', async () => {
    const { store } = await full()
    expect(store.held().ranges()).toEqual([{ start: 0, end: 2 * MIB }])
    store.setPosition(4 * MIB)
    const outcome = await store.write(4 * MIB, piece(4 * MIB, 5 * MIB))
    expect(outcome.evicted).toEqual([{ start: 0, end: MIB }])
    expect(outcome.evictedBytes).toBe(MIB)
    expect(store.held().ranges()).toEqual([
      { start: MIB, end: 2 * MIB },
      { start: 4 * MIB, end: 5 * MIB },
    ])
    expect(await store.read(0, MIB)).toBeNull()
    expectSame(await store.read(4 * MIB, 5 * MIB), CONTENT.subarray(4 * MIB, 5 * MIB))
    expect(store.stats()).toEqual(
      stats({ capBytes: 2 * MIB, storedBytes: 2 * MIB, evictedBytes: MIB }),
    )
  })

  it('removes a range that the write itself evicted from the range it added', async () => {
    const script = new Script()
    const store = await script.open()
    const writing = store.write(0, new Uint8Array(100))
    const request = await script.request(1, 'write')
    // The answer evicts the middle of what was just written.
    script.send({
      id: request.id,
      ok: true,
      type: 'write',
      outcome: {
        full: false,
        evictedBytes: 20,
        evicted: [{ start: 40, end: 60 }],
      },
      stats: stats({ evictedBytes: 20 }),
    })
    await writing
    expect(store.held().ranges()).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ])
  })

  it('holds what a failed write put in the frontier, and learns of its evictions from the next write', async () => {
    const { store, directory } = await full()
    store.setPosition(4 * MIB)
    directory.file.failNextWrite('QuotaExceededError')
    await expectStoreError(store.write(4 * MIB, piece(4 * MIB, 5 * MIB)), 'quota')
    // The block is held and readable, though it has no slot; the eviction of block 0 is not reported yet.
    expect(store.held().ranges()).toEqual([
      { start: 0, end: 2 * MIB },
      { start: 4 * MIB, end: 5 * MIB },
    ])
    expectSame(await store.read(4 * MIB, 5 * MIB), CONTENT.subarray(4 * MIB, 5 * MIB))
    // The answer of the failed write carried the stats of the worker's store.
    expect(store.stats()).toEqual(stats({ capBytes: 2 * MIB, storedBytes: MIB, evictedBytes: MIB }))

    const next = await store.write(4 * MIB, new Uint8Array(0))
    expect(next.evicted).toEqual([{ start: 0, end: MIB }])
    expect(store.held().ranges()).toEqual([
      { start: MIB, end: 2 * MIB },
      { start: 4 * MIB, end: 5 * MIB },
    ])
    expect(store.stats().storedBytes).toBe(2 * MIB)
  })

  it.each([
    ['a whole block', 0, MIB],
    ['the head of the block', 0, 100],
    ['the middle of the block', 500_000, 100],
  ])(
    'agrees with the store when a write holds again %s that a failed write let go of',
    async (_name, offset, length) => {
      /** The same steps on any store: block 3 evicts block 0 and fails to reach its slot, then the bytes of block 0 are written again. */
      async function lostThenWrittenAgain(
        store: PlayStore,
        failNextWrite: () => void,
      ): Promise<WriteOutcome> {
        await store.write(0, piece(0, MIB))
        store.setPosition(3 * MIB)
        failNextWrite()
        await expectStoreError(store.write(3 * MIB, piece(3 * MIB, 4 * MIB)), 'disk')
        return store.write(offset, piece(offset, offset + length))
      }

      const { open, directory } = rig()
      const client = await open({ fileSize: 4 * MIB, capBytes: MIB })
      const clientOutcome = await lostThenWrittenAgain(client, () => {
        directory.file.failNextWrite('InvalidStateError')
      })

      const file = new TestSlotFile()
      const core = new CoreStore({
        backend: { kind: 'disk', file, key: await newPlayKey() },
        fileSize: 4 * MIB,
        capBytes: MIB,
      })
      const coreOutcome = await lostThenWrittenAgain(core, () => {
        file.failNextWrite('InvalidStateError')
      })

      // What was written again is not reported as gone, and the rest of the block is.
      expect(coreOutcome.evictedBytes).toBe(MIB - length)
      expect(clientOutcome).toEqual(coreOutcome)
      expect(client.held().ranges()).toEqual(core.held().ranges())
      expect(client.stats()).toEqual(core.stats())
    },
  )

  it('also holds the range of a write that failed on the disk, and not that of a refused one', async () => {
    const { open, directory } = rig()
    const store = await open()
    directory.file.failNextWrite('InvalidStateError')
    await expectStoreError(store.write(0, piece(0, MIB)), 'disk')
    expect(store.held().ranges()).toEqual([{ start: 0, end: MIB }])
    // A write past the end of the file is refused whole.
    expect(await failureOf(store.write(8 * MIB - 10, new Uint8Array(20)))).toBeInstanceOf(
      RangeError,
    )
    expect(store.held().ranges()).toEqual([{ start: 0, end: MIB }])
  })

  it('holds what a write that failed with a damaged block put in the frontier', async () => {
    const script = new Script()
    const store = await script.open()
    const writing = store.write(10, new Uint8Array(30))
    const request = await script.request(1, 'write')
    script.send({
      id: request.id,
      ok: false,
      error: { kind: 'sealed', message: 'a block did not open' },
      stats: stats({ storedBytes: 7 }),
    })
    await expectStoreError(writing, 'sealed')
    expect(store.held().ranges()).toEqual([{ start: 10, end: 40 }])
    expect(store.stats().storedBytes).toBe(7)
  })

  it('holds nothing of a write that the worker found closed, and of one it refused', async () => {
    const script = new Script()
    const store = await script.open()
    const closed = store.write(0, new Uint8Array(10))
    const first = await script.request(1, 'write')
    script.send({ id: first.id, ok: false, error: { kind: 'closed', message: 'gone' } })
    await expectStoreError(closed, 'closed')
    const refused = store.write(0, new Uint8Array(10))
    const second = await script.request(2, 'write')
    script.send({ id: second.id, ok: false, error: { kind: 'range', message: 'too far' } })
    expect(await failureOf(refused)).toBeInstanceOf(RangeError)
    expect(store.held().ranges()).toEqual([])
  })

  it('takes its stats from the latest answer', async () => {
    const script = new Script()
    const store = await script.open(4 * MIB)
    expect(store.stats()).toEqual(stats())
    const writing = store.write(0, new Uint8Array(10))
    const request = await script.request(1, 'write')
    script.send({
      id: request.id,
      ok: true,
      type: 'write',
      outcome: { full: true, evictedBytes: 0, evicted: [] },
      stats: stats({ storedBytes: 5, evictedBytes: 9 }),
    })
    expect(await writing).toEqual({ full: true, evictedBytes: 0, evicted: [] })
    expect(store.stats()).toEqual(stats({ storedBytes: 5, evictedBytes: 9 }))
  })
})

describe('requests in flight', () => {
  it('answers two writes and a read to each caller, in the worker and in order', async () => {
    const { open } = rig()
    const store = await open()
    const [first, second, read] = await Promise.all([
      store.write(0, piece(0, MIB)),
      store.write(MIB, piece(MIB, 2 * MIB)),
      store.read(MIB / 2, 1.5 * MIB),
    ])
    expect(first.evicted).toEqual([])
    expect(second.evicted).toEqual([])
    // The read comes after both writes, so it meets both blocks.
    expectSame(read, CONTENT.subarray(MIB / 2, 1.5 * MIB))
  })

  it('matches each answer to its call by id, whatever the order the answers come in', async () => {
    const script = new Script()
    const store = await script.open()
    const a = store.write(0, new Uint8Array(4))
    const b = store.write(100, new Uint8Array(8))
    const c = store.read(0, 3)
    const requests = [
      await script.request(1, 'write'),
      await script.request(2, 'write'),
      await script.request(3, 'read'),
    ]
    const [forA, forB, forC] = requests
    if (forA === undefined || forB === undefined || forC === undefined)
      throw new Error('no request')
    expect(new Set([forA.id, forB.id, forC.id]).size).toBe(3)

    script.send({ id: forC.id, ok: true, type: 'read', bytes: new Uint8Array([7, 8, 9]) })
    script.send({
      id: forB.id,
      ok: true,
      type: 'write',
      outcome: { full: false, evictedBytes: 2, evicted: [] },
      stats: stats(),
    })
    script.send({
      id: forA.id,
      ok: true,
      type: 'write',
      outcome: { full: false, evictedBytes: 1, evicted: [] },
      stats: stats(),
    })
    expect((await a).evictedBytes).toBe(1)
    expect((await b).evictedBytes).toBe(2)
    expect(await c).toEqual(new Uint8Array([7, 8, 9]))
  })

  it('ignores an answer that matches no call, and a message that is not an answer', async () => {
    const script = new Script()
    const store = await script.open()
    const reading = store.read(0, 3)
    const request = await script.request(1, 'read')
    script.sendRaw('not an answer')
    script.sendRaw({ ok: true, type: 'read', bytes: null })
    script.send({ id: request.id + 100, ok: true, type: 'read', bytes: null })
    script.send({ id: request.id, ok: true, type: 'read', bytes: new Uint8Array([1, 2, 3]) })
    expect(await reading).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('fails the call whose answer cannot be read, and not the others', async () => {
    const script = new Script()
    const store = await script.open()
    const reading = store.read(0, 3)
    const writing = store.write(0, new Uint8Array(4))
    const read = await script.request(1, 'read')
    const write = await script.request(2, 'write')
    script.sendRaw({ id: read.id, ok: true, type: 'read', bytes: 'text' })
    await expectStoreError(reading, 'disk')
    script.send({
      id: write.id,
      ok: true,
      type: 'write',
      outcome: { full: false, evictedBytes: 0, evicted: [] },
      stats: stats(),
    })
    await writing
    // A call that is answered with another kind of answer fails too.
    const second = store.read(0, 3)
    const request = await script.request(3, 'read')
    script.send({ id: request.id, ok: true, type: 'close' })
    await expectStoreError(second, 'disk')
  })

  it('finishes a request before it starts the next: a write that is sealing is not cut by a close', async () => {
    const { open, directory } = rig()
    const store = await open({ fileSize: 4 * MIB, capBytes: 4 * MIB })
    const writing = store.write(0, piece(0, MIB))
    const closing = store.close()
    // The write seals a block, which takes a while; the close waits for it.
    const outcome = await writing
    expect(outcome.full).toBe(false)
    await closing
    expect(directory.file.writes.length).toBe(2)
    expect(directory.removals).toBe(1)
  })

  it('applies a position before the write that comes after it', async () => {
    const { open } = rig()
    const store = await open({ capBytes: 2 * MIB })
    await store.write(0, piece(0, 2 * MIB))
    store.setPosition(4 * MIB)
    const outcome = await store.write(4 * MIB, piece(4 * MIB, 5 * MIB))
    expect(outcome.evicted).toEqual([{ start: 0, end: MIB }])
  })
})

describe('the worker', () => {
  /** Posts a raw message to a server and waits for its next answer. */
  function ask(client: MessagePort, message: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      client.once('message', (value: unknown) => {
        resolve(value)
      })
      client.postMessage(message)
    })
  }

  it('answers a request when no store is open with a closed error', async () => {
    const { client } = rig()
    const answer = parseReply(await ask(client, { id: 5, type: 'read', start: 0, end: 10 }))
    expect(answer).toMatchObject({ id: 5, ok: false, error: { kind: 'closed' } })
  })

  it('answers a close when no store is open, and a second close', async () => {
    const { client } = rig()
    expect(parseReply(await ask(client, { id: 1, type: 'close' }))).toEqual({
      id: 1,
      ok: true,
      type: 'close',
    })
    expect(parseReply(await ask(client, { id: 2, type: 'close' }))).toEqual({
      id: 2,
      ok: true,
      type: 'close',
    })
  })

  it('answers a second open with a refusal, without taking the lock again', async () => {
    const { client, log } = rig()
    const open = { type: 'open', playId: 'play-1', fileSize: 4 * MIB, capBytes: 4 * MIB }
    expect(parseReply(await ask(client, { id: 1, ...open }))).toMatchObject({ id: 1, ok: true })
    expect(parseReply(await ask(client, { id: 2, ...open }))).toMatchObject({
      id: 2,
      ok: false,
      error: { kind: 'refused' },
    })
    expect(log).toEqual(['lock taken play-1', 'file opened'])
  })

  it('answers a request it cannot read with an error, and survives a message that is not a request', async () => {
    const { client, open } = rig()
    client.postMessage('not a request')
    client.postMessage(null)
    client.postMessage({ type: 'write' })
    const answer = parseReply(await ask(client, { id: 9, type: 'write', offset: 'zero' }))
    expect(answer).toMatchObject({ id: 9, ok: false, error: { kind: 'range' } })
    const store = await open()
    await store.write(0, piece(0, MIB))
    expectSame(await store.read(0, MIB), CONTENT.subarray(0, MIB))
  })
})

describe('a store after it is closed', () => {
  it('rejects every call with closed, without a message to the worker', async () => {
    const script = new Script()
    const store = await script.open()
    store.setPosition(10)
    const closing = store.close()
    const request = await script.request(2, 'close')
    script.send({ id: request.id, ok: true, type: 'close' })
    await closing
    const sent = script.seen.length

    await expectStoreError(store.write(0, new Uint8Array(4)), 'closed')
    await expectStoreError(store.read(0, 4), 'closed')
    expect(() => {
      store.setPosition(0)
    }).toThrow(StoreError)
    expect(store.held().ranges()).toEqual([])
    await store.close()
    // Let any message that was wrongly sent arrive.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(script.seen.length).toBe(sent)
  })

  it('rejects the calls made after close was called, before it is answered', async () => {
    const script = new Script()
    const store = await script.open()
    const closing = store.close()
    await expectStoreError(store.write(0, new Uint8Array(4)), 'closed')
    const request = await script.request(1, 'close')
    script.send({ id: request.id, ok: true, type: 'close' })
    await closing
    expect(script.seen.map((request) => request.type)).toEqual(['open', 'close'])
  })

  it('forgets what it held', async () => {
    const { open } = rig()
    const store = await open()
    await store.write(0, piece(0, MIB))
    await store.close()
    expect(store.held().ranges()).toEqual([])
  })
})

describe('a worker that dies', () => {
  it('rejects the calls in flight, and every call after, with a disk error', async () => {
    const script = new Script()
    const store = await script.open()
    const writing = store.write(0, new Uint8Array(4))
    const reading = store.read(0, 4)
    await script.request(2, 'read')
    const sent = script.seen.length

    script.client.dispatchEvent(new Event('error'))

    await expectStoreError(writing, 'disk')
    await expectStoreError(reading, 'disk')
    await expectStoreError(store.write(0, new Uint8Array(4)), 'disk')
    await expectStoreError(store.read(0, 4), 'disk')
    expect(() => {
      store.setPosition(0)
    }).toThrow(StoreError)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(script.seen.length).toBe(sent)
  })

  it('does the same when a message cannot be understood', async () => {
    const script = new Script()
    const store = await script.open()
    const reading = store.read(0, 4)
    await script.request(1, 'read')
    script.client.dispatchEvent(new Event('messageerror'))
    await expectStoreError(reading, 'disk')
    await expectStoreError(store.write(0, new Uint8Array(4)), 'disk')
  })

  it('rejects the open that it dies in', async () => {
    const script = new Script()
    const opening = WorkerStore.open(script.client, OPTIONS)
    await script.request(0, 'open')
    script.client.dispatchEvent(new Event('error'))
    await expectStoreError(opening, 'disk')
  })

  it('closes without a word to a worker that is gone, and the store is closed after it', async () => {
    const script = new Script()
    const store = await script.open()
    script.client.dispatchEvent(new Event('error'))
    await store.close()
    await expectStoreError(store.read(0, 4), 'closed')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(script.seen.map((request) => request.type)).toEqual(['open'])
    // A second close is nothing, as it is for a store that closed in the ordinary way.
    await store.close()
  })

  it('closes when the worker dies while the close is waiting for its answer', async () => {
    const script = new Script()
    const store = await script.open()
    const closing = store.close()
    await script.request(1, 'close')
    script.client.dispatchEvent(new Event('error'))
    await closing
    await expectStoreError(store.write(0, new Uint8Array(4)), 'closed')
  })
})
