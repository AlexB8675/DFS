// Opening a play's store (DESIGN.md §10.4; the iron-clad spec §4.7). The store is kept on
// the browser's private file system, in a worker, when the browser allows it and has the
// room, and in memory, with a smaller cap, when it does not; and a disk that fills or
// fails during the play does not stop the play. What `openPlayStore` gives back wraps the
// store it chose and watches it. A disk that is full keeps what it holds as its cap
// (`shrinkToUsed`) and the write that met the full disk is tried again; a disk that fails,
// or a worker that dies, is given up for a store in memory, which starts empty because
// the bytes of the disk can no longer be read, and the downloader fetches what it needs
// again. Each change of store is one `store` event on the timeline, with its reason. A
// failure of the store is never the caller's: only a call that is wrong (a `RangeError`)
// or that comes after the play closed (`closed`) is rejected.

import type { TimelineEventInput } from '@dfs/shared'
import { StoreError } from './errors.ts'
import {
  BLOCK_BYTES,
  DISK_CAP_BYTES,
  DISK_FLOOR_BYTES,
  MEMORY_CAP_BYTES,
  QUOTA_SHARE,
} from './limits.ts'
import type { Endpoint } from './protocol.ts'
import type { RangeSet } from './ranges.ts'
import { CoreStore } from './store.ts'
import type { PlayStore, StoreStats, WriteOutcome } from './store.ts'
import { WorkerStore } from './worker-store.ts'

/** A worker that serves a store: the endpoint to talk to it by, and the way to end it. A browser's `Worker` is one. */
export type StoreWorker = Endpoint & { terminate(): void }

/** What the browser says of the room it has for the origin: `navigator.storage.estimate()`. */
export type StorageEstimator = () => Promise<{ quota?: number; usage?: number }>

export interface OpenPlayStoreOptions {
  playId: string
  /** The size of the file that is played, which the first read of the play has found out. */
  fileSize: number
  /** Makes the worker that serves the disk store, or is null where there is none to make (no `Worker`, or none that the page may start). */
  makeWorker: (() => StoreWorker) | null
  /** How much room the browser has; when it is missing, the browser's own `navigator.storage.estimate`. */
  estimate?: StorageEstimator
  /** Where the `store` events go: the timeline's recorder, which stamps their time. */
  onEvent: (event: TimelineEventInput) => void
}

/** The store as the play uses it: on disk through its worker, or in memory. */
type Current =
  | { readonly kind: 'disk'; readonly store: WorkerStore; readonly worker: StoreWorker }
  | { readonly kind: 'memory'; readonly store: CoreStore }

type DiskCurrent = Extract<Current, { kind: 'disk' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A number that can be computed with: not `NaN`, and not infinite. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Sends an event to the timeline. The recorder is the player's own and does not fail; if it did, the play would still go on. */
function emit(onEvent: (event: TimelineEventInput) => void, event: TimelineEventInput): void {
  try {
    onEvent(event)
  } catch {
    // A play whose store changed must not be stopped by the record of it.
  }
}

/** Ends a worker. A worker that cannot be ended is gone, or is the browser's to clean up. */
function endWorker(worker: StoreWorker): void {
  try {
    worker.terminate()
  } catch {
    // Nothing is left to do with a worker that cannot be ended.
  }
}

/**
 * The browser's estimate, called as a call of its storage (a browser refuses it as a call of
 * anything else). A browser that has no estimate says nothing.
 */
async function browserEstimate(): Promise<unknown> {
  const navigatorValue: unknown = Reflect.get(globalThis, 'navigator')
  const storage = isRecord(navigatorValue) ? navigatorValue.storage : undefined
  if (!isRecord(storage) || typeof storage.estimate !== 'function') return undefined
  const answer: unknown = Reflect.apply(storage.estimate, storage, [])
  return await answer
}

/**
 * The room the origin has left, in bytes, or null when the browser does not say: the
 * estimate is missing, rejects or throws, or has no quota or no usage or a number that is
 * not one. A quota that is all used, or more than all, is no room.
 */
async function freeBytes(estimate: StorageEstimator | undefined): Promise<number | null> {
  try {
    const given: unknown = await (estimate === undefined ? browserEstimate() : estimate())
    if (!isRecord(given) || !isNumber(given.quota) || !isNumber(given.usage)) return null
    return Math.max(0, given.quota - given.usage)
  } catch {
    return null
  }
}

/**
 * The most that the disk store may hold: the least of the spec's 2 GiB and 80% of the free
 * quota, in whole blocks; or the 2 GiB when the browser does not say how much room it has.
 */
async function diskCapBytes(estimate: StorageEstimator | undefined): Promise<number> {
  const free = await freeBytes(estimate)
  if (free === null) return DISK_CAP_BYTES
  const share = Math.min(DISK_CAP_BYTES, Math.floor(QUOTA_SHARE * free))
  return Math.floor(share / BLOCK_BYTES) * BLOCK_BYTES
}

/** Why a worker could not open the disk store, as the timeline calls it. */
function refusalReason(error: unknown): string {
  if (error instanceof StoreError && (error.kind === 'no-opfs' || error.kind === 'quota')) {
    return error.kind
  }
  return 'refused'
}

/** What `openPlayStore` chose, and why the disk store was not chosen when it was not. */
interface Choice {
  current: Current
  reason: string | null
}

function memoryChoice(fileSize: number, reason: string): Choice {
  const store = new CoreStore({
    backend: { kind: 'memory' },
    fileSize,
    capBytes: MEMORY_CAP_BYTES,
  })
  return { current: { kind: 'memory', store }, reason }
}

/**
 * Chooses the store, in this order: memory when there is no worker to make; memory when
 * the quota leaves a cap under the floor (and no worker is made); memory when the worker
 * cannot be made; memory when the worker cannot open the file, whatever it says; and
 * otherwise the disk. A worker that did not open is ended.
 */
async function choose(options: OpenPlayStoreOptions): Promise<Choice> {
  const { playId, fileSize, makeWorker, estimate } = options
  if (makeWorker === null) return memoryChoice(fileSize, 'no-worker')
  const capBytes = await diskCapBytes(estimate)
  if (capBytes < DISK_FLOOR_BYTES) return memoryChoice(fileSize, 'quota')
  let worker: StoreWorker
  try {
    worker = makeWorker()
  } catch {
    // A content security policy, or a script that cannot be loaded, can refuse the worker.
    return memoryChoice(fileSize, 'no-worker')
  }
  try {
    const store = await WorkerStore.open(worker, { playId, fileSize, capBytes })
    return { current: { kind: 'disk', store, worker }, reason: null }
  } catch (error) {
    endWorker(worker)
    // A size that is not the size of a file was refused before this, so a `RangeError` here is a worker that does not understand the page, and the play goes on in memory.
    return memoryChoice(fileSize, refusalReason(error))
  }
}

/** Closes a disk store that the play has left, and ends its worker when the close has settled. What the close fails with is of no use to the play any more. */
async function retire(disk: DiskCurrent): Promise<void> {
  try {
    await disk.store.close()
  } catch {
    // The play is on another store; the directory that is left is removed at the next start of the app.
  } finally {
    endWorker(disk.worker)
  }
}

/**
 * A play's store as the play uses it, with the memory fallback behind it. Its calls go
 * to the store that is current, and only one change of store happens in a play: from the
 * disk to memory. A call that meets a failure of the disk store changes the store (or, for
 * a full disk, shrinks it) and is made again on what is current then; so is a call that
 * settles, in either way, on a store that is no longer current, because its answer is
 * about a store that the play has left. Only a `RangeError`, which is the caller's mistake,
 * and a `closed` error, after the play closed, reach the caller.
 */
class FallbackStore implements PlayStore {
  readonly fileSize: number

  #current: Current
  readonly #onEvent: (event: TimelineEventInput) => void
  /** Where the engine last said that it reads, which a store in memory is given when it takes over. */
  #position = 0
  /** What the stores that the play has left had evicted. */
  #evictedBefore = 0
  #closed = false
  #closing: Promise<void> | null = null
  /** The shrink of the disk store that is in flight, which every write that meets the full disk waits for. */
  #shrinking: Promise<void> | null = null

  constructor(current: Current, fileSize: number, onEvent: (event: TimelineEventInput) => void) {
    this.#current = current
    this.fileSize = fileSize
    this.#onEvent = onEvent
  }

  /** Throws `closed` once the play has closed. */
  #assertOpen(): void {
    if (this.#closed) throw new StoreError('closed', 'the store is closed')
  }

  get backend(): 'disk' | 'memory' {
    return this.#current.kind
  }

  get capBytes(): number {
    return this.#current.store.capBytes
  }

  held(): RangeSet {
    return this.#current.store.held()
  }

  stats(): StoreStats {
    const stats = this.#current.store.stats()
    return { ...stats, evictedBytes: stats.evictedBytes + this.#evictedBefore }
  }

  /**
   * Gives up the disk store for a store in memory that holds nothing: it takes the
   * position, and the timeline is told why. The disk store is closed in the background.
   * It does nothing for a disk store that the play has left already, or after the close,
   * so that however many calls fail together there is one change.
   */
  #toMemory(from: DiskCurrent, reason: 'disk-error' | 'quota'): void {
    if (this.#closed || this.#current !== from) return
    const store = new CoreStore({
      backend: { kind: 'memory' },
      fileSize: this.fileSize,
      capBytes: MEMORY_CAP_BYTES,
    })
    store.setPosition(this.#position)
    this.#evictedBefore += from.store.stats().evictedBytes
    this.#current = { kind: 'memory', store }
    emit(this.#onEvent, {
      type: 'store',
      backend: 'memory',
      capBytes: store.capBytes,
      reason,
    })
    void retire(from)
  }

  /**
   * Makes the slots that the disk store holds blocks in its cap, once for all the writes that
   * meet the full disk together. A cap under the floor is not worth a disk, and the play
   * moves to memory; so does a disk that cannot even say. Otherwise the timeline is told of
   * the new cap. It does not fail.
   */
  #shrink(disk: DiskCurrent): Promise<void> {
    this.#shrinking ??= this.#shrinkNow(disk).finally(() => {
      this.#shrinking = null
    })
    return this.#shrinking
  }

  async #shrinkNow(disk: DiskCurrent): Promise<void> {
    let capBytes: number
    try {
      capBytes = await disk.store.shrinkToUsed()
    } catch {
      this.#toMemory(disk, 'disk-error')
      return
    }
    if (this.#closed || this.#current !== disk) return
    if (capBytes < DISK_FLOOR_BYTES) {
      this.#toMemory(disk, 'quota')
      return
    }
    emit(this.#onEvent, { type: 'store', backend: 'disk', capBytes, reason: 'quota' })
  }

  /**
   * Makes a call on the store that is current, and again on the one that is current
   * after it, for as long as the store changes under it. A call that settles on a store
   * that the play has left is made again, whether it resolved or failed. A failure of the
   * disk store moves the play to memory, except for a full disk on a write, which shrinks
   * the disk store once and tries the write again against its new cap (a second full disk
   * is a failing disk). A `RangeError` and a call after the close are thrown.
   */
  async #run<T>(call: (current: Current) => Promise<T>, shrinkOnQuota: boolean): Promise<T> {
    this.#assertOpen()
    let shrunk = false
    for (;;) {
      const current = this.#current
      try {
        const result = await call(current)
        if (current === this.#current) return result
      } catch (error) {
        // The play closed meanwhile: whatever the call met is of no use to it.
        this.#assertOpen()
        if (current !== this.#current) continue
        if (current.kind === 'memory' || error instanceof RangeError) throw error
        if (shrinkOnQuota && !shrunk && error instanceof StoreError && error.kind === 'quota') {
          shrunk = true
          await this.#shrink(current)
        } else {
          this.#toMemory(current, 'disk-error')
        }
      }
    }
  }

  write(offset: number, bytes: Uint8Array): Promise<WriteOutcome> {
    // The disk store's client gives the buffer it is handed away; a copy is given, so that the bytes are still the caller's to write again.
    return this.#run(
      (current) => current.store.write(offset, current.kind === 'disk' ? bytes.slice() : bytes),
      true,
    )
  }

  read(start: number, end: number): Promise<Uint8Array | null> {
    return this.#run((current) => current.store.read(start, end), false)
  }

  setPosition(offset: number): void {
    this.#assertOpen()
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.fileSize) {
      throw new RangeError(`${offset} is not a position in a file of ${this.fileSize} bytes`)
    }
    this.#position = offset
    const current = this.#current
    try {
      current.store.setPosition(offset)
    } catch (error) {
      // A worker that is gone cannot be told: the play finds that out here, and the memory takes the position.
      if (current.kind === 'disk' && !(error instanceof RangeError)) {
        this.#toMemory(current, 'disk-error')
        return
      }
      throw error
    }
  }

  /** Closes the store that is current, and ends its worker if it is a disk store. Resolves whatever the store says. */
  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    this.#closed = true
    const current = this.#current
    try {
      await current.store.close()
    } catch {
      // The play is over: what is left on the disk is removed at the next start of the app.
    } finally {
      if (current.kind === 'disk') endWorker(current.worker)
    }
  }
}

/**
 * Opens a play's store: on disk, in a worker made by `makeWorker`, when the browser allows
 * it and its room is at least the floor, and in memory otherwise. Why it is in memory, if it
 * is, goes to the timeline as the reason of one `store` event, which is sent in either case.
 * It rejects only for a `RangeError`, when `fileSize` is not the size of a file.
 */
export async function openPlayStore(options: OpenPlayStoreOptions): Promise<PlayStore> {
  const { fileSize, onEvent } = options
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`${fileSize} is not the size of a file`)
  }
  const { current, reason } = await choose(options)
  emit(onEvent, {
    type: 'store',
    backend: current.kind,
    capBytes: current.store.capBytes,
    reason,
  })
  return new FallbackStore(current, fileSize, onEvent)
}
