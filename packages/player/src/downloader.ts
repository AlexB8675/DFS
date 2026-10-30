// The downloader (DESIGN.md §10.4; the iron-clad spec §4.7). From the position to the end of
// the file, as far as the store allows: the onward reads take the first stretch that is not
// held, write what comes to the store a block at a time, and go on to the next stretch when
// they meet data that is held. A seek outside what is held starts a read there and keeps what
// is stored; the engine can ask for a range at once (`fetchNow`), which is read alongside the
// onward reads, and can wait for one (`whenHeld`, `read`). The downloader "retries for as long
// as the play lasts, with growing pauses, and resumes at once on `online` and on returning to
// the page"; it stops the onward reads, and says so, when the store is full of data nearer the
// position; and the onward reads end only when every byte from the position to the end is
// held, or when the server says that no try later can work. Everything that happens is a
// timeline event, with its reason.
//
// The page's connection is reached through `globalThis` with runtime checks, and the timers
// are the global ones, so the file needs no DOM types and runs in a page, a worker and Node
// alike.

import type { ByteRange } from '@dfs/mp4'
import type { TimelineEventInput } from '@dfs/shared'
import { blockOf } from './blocks.ts'
import { StoreError } from './errors.ts'
import {
  BLOCK_BYTES,
  LEVEL_EVERY_MS,
  RATE_WINDOW_MS,
  RETRY_BASE_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
} from './limits.ts'
import { ReadError, openRead } from './read.ts'
import type { PlayStore, WriteOutcome } from './store.ts'

/** What the downloader asks of the page's connection: whether it is up, and to be told when it comes back. */
export interface Connectivity {
  /** Whether the browser says that it is online. */
  online(): boolean
  /** Calls `listener` whenever the browser goes online; the function it returns lets go of the listener. */
  onOnline(listener: () => void): () => void
  /** Calls `listener` whenever the page becomes visible again; the function it returns lets go of the listener. */
  onVisible(listener: () => void): () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Listens for `type` on `target` if it is an event target, and answers the function that lets
 * go of it. Where there is no target (Node, a worker with no page) there is nothing to hear,
 * and the function does nothing.
 */
function listen(target: unknown, type: string, listener: () => void): () => void {
  if (
    !isRecord(target) ||
    typeof target.addEventListener !== 'function' ||
    typeof target.removeEventListener !== 'function'
  ) {
    return () => undefined
  }
  const { addEventListener, removeEventListener } = target
  // Called as calls of the target: a browser refuses them as calls of anything else.
  Reflect.apply(addEventListener, target, [type, listener])
  return () => {
    Reflect.apply(removeEventListener, target, [type, listener])
  }
}

/**
 * The page's connection: `navigator.onLine`, the `online` event, and `visibilitychange` when
 * the page has become visible. All of it is reached by name through `globalThis`, so the
 * file has no need of the DOM's types, and a place without a page (Node, a worker) says that
 * it is online and hears nothing.
 */
export function pageConnectivity(): Connectivity {
  return {
    online() {
      const navigatorValue: unknown = Reflect.get(globalThis, 'navigator')
      const onLine = isRecord(navigatorValue) ? navigatorValue.onLine : undefined
      return typeof onLine === 'boolean' ? onLine : true
    },
    onOnline(listener) {
      return listen(globalThis, 'online', listener)
    },
    onVisible(listener) {
      const page: unknown = Reflect.get(globalThis, 'document')
      return listen(page, 'visibilitychange', () => {
        if (isRecord(page) && page.visibilityState === 'visible') listener()
      })
    },
  }
}

/**
 * What the onward reads are doing:
 * - `reading`: an onward read is open, or a read that is open covers where the next one would begin (and `waiting` and `full` have none);
 * - `full`: the store has no room for more data than is nearer the position, and the onward reads are stopped until the position moves;
 * - `waiting`: an onward read failed and the next try is after a pause (a download that has not started waits too);
 * - `done`: every byte from the position to the end of the file is held;
 * - `failed`: a read failed in a way that no try later can mend.
 *
 * The reads that `fetchNow` opens do not change it, except that one which fails in that way ends the play.
 */
export type DownloaderState = 'reading' | 'full' | 'waiting' | 'done' | 'failed'

export interface DownloaderOptions {
  /** The file's route, which the play's reads are made of. */
  url: string
  /** The play's store, which the downloader fills and closes. Its `fileSize` is the file's. */
  store: PlayStore
  /** Where the timeline's events go: the recorder, which stamps their time. */
  onEvent: (event: TimelineEventInput) => void
  connectivity: Connectivity
  /** The `fetch` to read with; the global one when it is missing. */
  fetch?: typeof fetch
  /** A number from 0 up to 1, for the jitter of the pauses; `Math.random` when it is missing. */
  random?: () => number
  /** The clock, in milliseconds, which the rate is measured by; `performance.now` when it is missing. */
  now?: () => number
}

/** How many onward reads are open at most: the one that follows the position, and one more that a seek opens while the first goes on ahead of it (the iron-clad spec §4.7). */
const ONWARD_READS = 2

/** How many times `read` asks for a range and finds it gone, before it gives up. */
const READ_ROUNDS = 3

/** The least time of receiving that has a rate. */
const RATE_AFTER_MS = 1000

/** What a read is for: an onward read follows the position; a priority read is for a range that someone waits for. */
type ReadKind = 'onward' | 'priority'

/** A read that is open. */
interface ActiveRead {
  readonly id: number
  readonly kind: ReadKind
  /** Aborted whenever the downloader lets the read go, so that its connection closes at once. */
  readonly controller: AbortController
  /** The first byte the read asks for. */
  readonly from: number
  /** The last byte the read asks for, included; null when it runs to the end of the file. */
  readonly to: number | null
  /** Who waits for it, when it is a priority read. */
  readonly waiter: Waiter | null
  /** The bytes that the read has received, written or not. */
  received: number
  /** The file offset of the next byte to be written. */
  at: number
}

/** A wait before a read is tried again. */
interface Pause {
  timer: ReturnType<typeof setTimeout> | null
  /** Where the read will reopen, as the `retry` event said. */
  readonly offset: number
  /** The wait that the pause belongs to; null for the onward reads', of which there is one at a time. */
  readonly owner: Waiter | null
  /** Whether it has ended: its timer and its listeners are gone. */
  ended: boolean
  /** What lets go of the connectivity listeners. */
  release: () => void
}

/** Someone who waits for a range to be held: `whenHeld` only waits; `fetchNow` also has it read. */
interface Waiter {
  readonly range: ByteRange
  /** Whether the range is to be read (`fetchNow`) or only waited for (`whenHeld`). */
  readonly priority: boolean
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
  /** Lets go of what the wait listens to (a signal). */
  unlisten: (() => void) | null
  /** How many reads for this wait have failed in a row, which its next pause is long for. */
  failures: number
  pause: Pause | null
}

/**
 * Text up to 300 characters with no U+0000 and no half of a surrogate pair: what a timeline's
 * text fields take (the recorder's `clipText` does the same, and the player package does not
 * reach the page's code).
 */
function clip(text: string): string {
  let clipped = ''
  // Iterating a string goes by code point, and a lone surrogate comes alone.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0 || (char.length === 1 && code >= 0xd800 && code <= 0xdfff)) continue
    if (clipped.length + char.length > 300) break
    clipped += char
  }
  return clipped
}

function messageOf(error: unknown): string {
  return clip(error instanceof Error ? error.message : String(error))
}

function isClosed(error: unknown): boolean {
  return error instanceof StoreError && error.kind === 'closed'
}

function closedError(): StoreError {
  return new StoreError('closed', 'the download is closed')
}

/**
 * How long to wait after the nth failure in a row (§10.4): RETRY_BASE_MS doubled n − 1
 * times, to RETRY_MAX_MS at most, moved by up to RETRY_JITTER either way. A server that
 * said how long to wait (`Retry-After`) is believed as a least, since a pause that is
 * shorter than the server's own would only be answered again; the pause still grows with
 * the failures, so a server that says 0 is not asked in a tight loop, and no pause that
 * follows a `Retry-After` is longer than RETRY_MAX_MS, since a play does not stall for
 * minutes on a server's say.
 */
export function retryDelayMs(error: unknown, attempt: number, random: () => number): number {
  const backoff = Math.round(
    Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) *
      (1 + RETRY_JITTER * (2 * random() - 1)),
  )
  if (error instanceof ReadError && error.retryAfterMs !== null) {
    return Math.min(RETRY_MAX_MS, Math.max(error.retryAfterMs, backoff))
  }
  return backoff
}

/** The bytes that the play's reads have received over the last RATE_WINDOW_MS, and when the first of them came. */
class RateMeter {
  readonly #samples: { at: number; bytes: number }[] = []
  #first: number | null = null

  add(at: number, bytes: number): void {
    this.#first ??= at
    this.#samples.push({ at, bytes })
    this.#forget(at)
  }

  /**
   * The bytes per second received over the last RATE_WINDOW_MS, or over the time since the
   * first byte when that is less than a window; null until a second of receiving has
   * passed. A play that has received nothing for a whole window has a rate of 0.
   */
  rate(now: number): number | null {
    if (this.#first === null) return null
    const since = now - this.#first
    if (since < RATE_AFTER_MS) return null
    this.#forget(now)
    let bytes = 0
    for (const sample of this.#samples) bytes += sample.bytes
    return bytes / (Math.min(RATE_WINDOW_MS, since) / 1000)
  }

  /** Lets go of the samples that are not in the window that ends at `now`. */
  #forget(now: number): void {
    let old = 0
    while (old < this.#samples.length && (this.#samples[old]?.at ?? now) <= now - RATE_WINDOW_MS) {
      old += 1
    }
    if (old > 0) this.#samples.splice(0, old)
  }
}

export class Downloader {
  readonly #url: string
  readonly #store: PlayStore
  readonly #onEvent: (event: TimelineEventInput) => void
  readonly #connectivity: Connectivity
  readonly #fetch: typeof fetch | undefined
  readonly #random: () => number
  readonly #now: () => number
  readonly #meter = new RateMeter()

  /** Before the start, nothing is read and nothing is wrong: the downloader waits. */
  #state: DownloaderState = 'waiting'
  #failure: ReadError | null = null
  #started = false
  #closed = false
  #closing: Promise<void> | null = null
  /** Where the play is: the onward read begins at the first gap at or after it. */
  #position = 0
  #nextId = 1
  /** The reads that are open. */
  readonly #reads = new Set<ActiveRead>()
  /** How many onward reads have failed in a row, which the next pause is long for. */
  #failures = 0
  /** The wait after a failure of an onward read: one at a time, since the choice of what to read is made again when it ends. */
  #pause: Pause | null = null
  /** Those who wait for a range to be held. */
  readonly #waiters = new Set<Waiter>()
  /** The one interval of the level, running while any read is open. */
  #levels: ReturnType<typeof setInterval> | null = null
  /** The check of a full store: one at a time, and `again` when the position moved during it. */
  #check: { running: boolean; again: boolean } = { running: false, again: false }

  constructor(options: DownloaderOptions) {
    this.#url = options.url
    this.#store = options.store
    this.#onEvent = options.onEvent
    this.#connectivity = options.connectivity
    this.#fetch = options.fetch
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? (() => performance.now())
  }

  state(): DownloaderState {
    return this.#state
  }

  /** The `ReadError` that ended the play; null while it has not ended. */
  failure(): ReadError | null {
    return this.#failure
  }

  /**
   * The bytes per second received by all the reads over the last RATE_WINDOW_MS (or over
   * the time since the first byte, while that is less); null before a second of receiving.
   */
  rate(): number | null {
    return this.#meter.rate(this.#now())
  }

  /** Begins reading at the position. It does nothing a second time, nor after `close`. */
  start(): void {
    if (this.#closed || this.#started) return
    this.#started = true
    this.#openNext()
  }

  /**
   * Says where the play is. The store is given the position first, in every state, and a
   * position that is not in the file is a `RangeError` that changes nothing. A full store
   * is checked for room, since the position is what makes room. Otherwise the choice of
   * what to read is made again: an onward read that is behind the position yields; if the
   * first gap at or after the position is not where a read is reading, a read opens there
   * (a seek: the third onward read gives up the one farthest from the position); nothing
   * that is stored is let go of. A pause that is under way goes on unless the read would
   * now begin elsewhere, so that a position that is told often does not make a failing
   * server be asked often.
   */
  setPosition(offset: number): void {
    if (this.#closed) return
    this.#store.setPosition(offset)
    this.#position = offset
    if (!this.#started) return
    switch (this.#state) {
      case 'full':
        this.#checkRoom()
        break
      case 'failed':
        break
      case 'reading':
      case 'waiting':
      case 'done':
        this.#seek()
        break
    }
  }

  /**
   * Opens a read at once for each part of `range` that is not held, alongside the onward
   * reads (priority reads have no limit; they are short), unless a read covers where the
   * part begins. Resolves when the whole range is held, by whichever read brings it; rejects
   * with the `ReadError` if the play fails, and with a `StoreError` of kind `closed` if the
   * downloader closes first. A priority read that fails is tried again after a pause of its
   * own, as the onward reads are.
   */
  fetchNow(range: ByteRange): Promise<void> {
    return this.#wait(range, true)
  }

  /** Resolves when `range` is held, and opens no read; rejects as `fetchNow` does, and with the reason of `signal` if that aborts. */
  whenHeld(range: ByteRange, signal?: AbortSignal): Promise<void> {
    return this.#wait(range, false, signal)
  }

  /**
   * The bytes of `range`, as soon as they are held: the range is asked for with `fetchNow`
   * (which opens no read for a range that a running read is about to bring) and then read
   * from the store. When the store says it is not held (it was let go of in between) the
   * range is asked for again; after READ_ROUNDS rounds of that the read is given up with a
   * failure that a later try may mend (the engine reads near the position, where nothing is
   * let go of, so this only guards against a loop).
   */
  async read(range: ByteRange): Promise<Uint8Array> {
    for (let round = 1; round <= READ_ROUNDS; round += 1) {
      await this.fetchNow(range)
      const bytes = await this.#store.read(range.start, range.end)
      if (bytes !== null) return bytes
    }
    throw new ReadError(
      `The bytes ${range.start} to ${range.end} were let go of ${READ_ROUNDS} times before they could be read.`,
      { fatal: false },
    )
  }

  /** Aborts the reads, clears every timer, lets go of the connectivity and closes the store. It never rejects, and a second call is the first. */
  close(): Promise<void> {
    this.#closing ??= this.#shutDown()
    return this.#closing
  }

  async #shutDown(): Promise<void> {
    this.#closed = true
    for (const read of [...this.#reads]) this.#end(read, 'aborted', null)
    if (this.#pause !== null) this.#endPause(this.#pause)
    for (const waiter of [...this.#waiters]) this.#refuse(waiter, closedError())
    this.#stopLevels()
    try {
      await this.#store.close()
    } catch {
      // A store that cannot close is the browser's to clean up; the play is over.
    }
  }

  /** Sends an event to the timeline. The recorder is the player's own and does not fail; if it did, the play would still go on. */
  #emit(event: TimelineEventInput): void {
    try {
      this.#onEvent(event)
    } catch {
      // A play that is downloading must not be stopped by the record of it.
    }
  }

  /** Changes the state. The level goes on while a read is open and stops when none is. */
  #setState(state: DownloaderState): void {
    this.#state = state
    if (state !== 'reading') this.#stopLevelsIfIdle()
  }

  #startLevels(): void {
    this.#levels ??= setInterval(() => {
      this.#sendLevel()
    }, LEVEL_EVERY_MS)
  }

  #stopLevels(): void {
    if (this.#levels === null) return
    clearInterval(this.#levels)
    this.#levels = null
  }

  /** Stops the level when no read is open. A read that ends and is followed by another at once leaves the level as it is, so that its phase is not restarted by each. */
  #stopLevelsIfIdle(): void {
    if (this.#reads.size === 0) this.#stopLevels()
  }

  #sendLevel(): void {
    try {
      const { storedBytes, evictedBytes } = this.#store.stats()
      const aheadBytes = this.#store.held().heldFrom(this.#position)
      this.#emit({ type: 'storeLevel', storedBytes, aheadBytes, evictedBytes })
    } catch {
      // A store that cannot say how full it is has been closed under the play, which ends it.
    }
  }

  /** The first stretch from the position that is not held, or null when every byte to the end of the file is. */
  #nextGap(): ByteRange | null {
    return this.#store.held().firstGap(this.#position, this.#store.fileSize)
  }

  /** Whether `read` is open: a read that was let go of is not, and what it meets after that is not the play's concern. */
  #isCurrent(read: ActiveRead): boolean {
    return this.#reads.has(read)
  }

  #hasOnward(): boolean {
    for (const read of this.#reads) {
      if (read.kind === 'onward') return true
    }
    return false
  }

  /**
   * Whether a read that is open will bring byte `x` soon, so that no other is needed for
   * it: the read's next byte is at `x`, or less than a block before it, and the read does
   * not stop before `x`.
   */
  #covers(x: number): boolean {
    for (const read of this.#reads) {
      if (read.at <= x && x <= read.at + BLOCK_BYTES && (read.to === null || x <= read.to)) {
        return true
      }
    }
    return false
  }

  /**
   * Ends a read that is open, once: the connection is let go of whatever the body was
   * doing, and the timeline hears the end of the request. Answers whether it was open (a
   * read that was ended already is not ended again). What follows is the caller's.
   */
  #end(read: ActiveRead, outcome: 'done' | 'aborted' | 'failed', message: string | null): boolean {
    if (!this.#reads.delete(read)) return false
    read.controller.abort()
    this.#emit({ type: 'requestEnd', id: read.id, bytes: read.received, outcome, message })
    return true
  }

  /**
   * Makes the choice of what to read again, after a read ended or the position moved: the
   * onward reads, and then the reads that those who wait are owed.
   */
  #reconsider(seek = false): void {
    this.#openNext(seek)
    for (const waiter of [...this.#waiters]) this.#serve(waiter)
    this.#stopLevelsIfIdle()
  }

  /**
   * The onward read: it reads the first stretch from the position that is not held, unless
   * a read covers where that begins, and finishes when there is none. A seek (the position
   * moved to where no read is reading) says so on the timeline. The third onward read
   * gives up the one that is farthest from the position, before it opens.
   */
  #openNext(seek = false): void {
    // Before the start nothing is read onward, whatever a priority read ends with.
    if (!this.#started || this.#closed) return
    if (this.#state === 'failed' || this.#state === 'full') return
    if (this.#pause !== null) {
      if (!this.#hasOnward()) this.#setState('waiting')
      return
    }
    const gap = this.#nextGap()
    if (gap === null) {
      this.#finish()
      return
    }
    if (this.#covers(gap.start)) {
      this.#setState('reading')
      return
    }
    const onward = [...this.#reads].filter((read) => read.kind === 'onward')
    if (onward.length >= ONWARD_READS) {
      const away = (read: ActiveRead): number => Math.abs(read.at - this.#position)
      const farthest = onward.reduce((far, read) => (away(read) > away(far) ? read : far))
      this.#end(farthest, 'aborted', null)
    }
    if (seek) this.#emit({ type: 'restart', offset: gap.start, reason: 'seek' })
    // Something is held after the gap unless it runs to the end of the file: the read stops where that begins.
    const to = gap.end < this.#store.fileSize ? gap.end - 1 : null
    this.#open('onward', gap.start, to, null)
    this.#setState('reading')
  }

  /** Opens a read from `from` to `to` (included; null: to the end of the file) and tells the timeline. */
  #open(kind: ReadKind, from: number, to: number | null, waiter: Waiter | null): void {
    const read: ActiveRead = {
      id: this.#nextId,
      kind,
      controller: new AbortController(),
      from,
      to,
      waiter,
      received: 0,
      at: from,
    }
    this.#nextId += 1
    this.#reads.add(read)
    this.#startLevels()
    this.#emit({ type: 'request', id: read.id, from, to })
    void this.#pump(read)
  }

  /** Every byte from the position to the end is held: the onward reads have nothing more to read, and any that is open is let go of. */
  #finish(): void {
    if (this.#state === 'done') return
    for (const read of [...this.#reads]) {
      if (read.kind === 'onward') this.#end(read, 'done', null)
    }
    this.#setState('done')
    this.#sendLevel()
  }

  /**
   * A seek, or a position that moves on with the play: the onward reads that are behind it
   * yield, a pause goes on only if the read would begin where it said, and the choice of
   * what to read is made again.
   */
  #seek(): void {
    for (const read of [...this.#reads]) {
      if (read.kind === 'onward' && read.at < this.#position) this.#end(read, 'aborted', null)
    }
    const pause = this.#pause
    if (pause !== null && this.#nextGap()?.start !== pause.offset) this.#endPause(pause)
    this.#reconsider(true)
  }

  /**
   * One read, from the request to the end of its body. The body is taken a piece at a time and
   * each piece is written before the next is asked for, so that the network is held back by the
   * store. It never rejects: whatever goes wrong is the downloader's to report.
   */
  async #pump(read: ActiveRead): Promise<void> {
    try {
      const opened = await openRead({
        url: this.#url,
        from: read.from,
        to: read.to,
        fileSize: this.#store.fileSize,
        signal: read.controller.signal,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      })
      if (!this.#isCurrent(read)) return
      // The answer's headers: its body is still to come.
      this.#emit({ type: 'firstByte', id: read.id })
      for await (const piece of opened.body) {
        if (!this.#isCurrent(read)) return
        read.received += piece.length
        this.#meter.add(this.#now(), piece.length)
        // A read that has brought a whole block is a network that works: the pauses start again.
        if (read.received >= BLOCK_BYTES) this.#working(read)
        if (!(await this.#take(read, piece))) return
      }
    } catch (error) {
      this.#readFailed(read, error)
      return
    }
    // The body gave all it was asked for (or all that the server would send of it).
    this.#bodyEnded(read)
  }

  /** The pauses that this read's failures made start again from the base. */
  #working(read: ActiveRead): void {
    if (read.kind === 'onward') this.#failures = 0
    else if (read.waiter !== null) read.waiter.failures = 0
  }

  /**
   * A body is over. The bytes of a priority read that the store let go of as soon as it had
   * them are not held, and reading them again at once would only do the same: that is a
   * failure, with its pause. Otherwise the read ended clean.
   */
  #bodyEnded(read: ActiveRead): void {
    if (
      read.kind === 'priority' &&
      this.#isCurrent(read) &&
      this.#store.held().firstGap(read.from, read.at) !== null
    ) {
      const message = clip('The store let go of the bytes of a read as soon as it had them')
      this.#end(read, 'failed', message)
      this.#emit({ type: 'error', from: 'engine', code: null, message })
      this.#retry(read, new Error(message), read.from)
      return
    }
    this.#finished(read)
  }

  /** A read ended clean: its body is complete, or it met data that is held. A clean end is a network that works, whatever the read received, so the pauses start again. */
  #finished(read: ActiveRead): void {
    const received = read.received
    if (!this.#end(read, 'done', null)) return
    if (received > 0) this.#working(read)
    this.#reconsider()
  }

  /**
   * Writes a piece of a body to the store, a block at a time, and only what is not held: a
   * part that runs into held data is written up to it. Answers whether the read goes on;
   * when it does not, the read has been ended or let go of, and what follows is arranged.
   */
  async #take(read: ActiveRead, piece: Uint8Array): Promise<boolean> {
    let taken = 0
    while (taken < piece.length) {
      const wanted = Math.min(piece.length - taken, (blockOf(read.at) + 1) * BLOCK_BYTES - read.at)
      // The first byte of the part that is held, if any: the read writes up to it, and has met it if it is the read's own next byte.
      const gap = this.#store.held().firstGap(read.at, read.at + wanted)
      if (gap?.start !== read.at) {
        this.#finished(read)
        return false
      }
      const length = gap.end - gap.start
      const part = piece.subarray(taken, taken + length)
      taken += length
      let outcome: WriteOutcome
      try {
        outcome = await this.#store.write(read.at, part)
      } catch (error) {
        this.#writeFailed(read, error)
        return false
      }
      if (!this.#isCurrent(read)) return false
      read.at += length
      this.#checkWaiters()
      if (outcome.full && !this.#onFull(read)) return false
      if (this.#store.held().heldFrom(read.at) > 0) {
        this.#finished(read)
        return false
      }
    }
    return true
  }

  /**
   * A write answered that a block found no room, with its bytes kept in the frontier. The
   * onward reads stop until the position makes room, and the timeline hears of it once. A
   * priority read goes on: it is short, and what it brings is wanted now. If there is nothing
   * more for the onward reads to read (the block finished the file) there is no reason to
   * wait, and the download is done. Answers whether the read goes on.
   */
  #onFull(read: ActiveRead): boolean {
    if (this.#nextGap() === null) {
      if (read.kind === 'priority') return true
      this.#finished(read)
      return false
    }
    if (this.#state !== 'full') {
      for (const open of [...this.#reads]) {
        if (open.kind === 'onward') this.#end(open, 'aborted', null)
      }
      this.#setState('full')
      this.#emit({ type: 'storeFull', on: true, storedBytes: this.#store.stats().storedBytes })
      // What those who wait were owed from the reads that were just let go of is read for them.
      this.#reconsider()
    }
    if (read.kind === 'priority') return true
    this.#end(read, 'aborted', null)
    return false
  }

  /**
   * Asks whether the store has room again, now that the position moved: a write of no bytes
   * places the blocks that wait under the new position, and answers whether any still does.
   * One check is made at a time; a move during it makes one more, at the position then.
   */
  #checkRoom(): void {
    if (this.#check.running) {
      this.#check.again = true
      return
    }
    this.#check.running = true
    void this.#runCheck()
  }

  async #runCheck(): Promise<void> {
    try {
      for (;;) {
        this.#check.again = false
        let outcome: WriteOutcome
        try {
          outcome = await this.#store.write(this.#position, new Uint8Array(0))
        } catch (error) {
          this.#checkFailed(error)
          return
        }
        // The play closed, or went on another way, while the store answered.
        if (this.#closed || this.#state !== 'full') return
        // Room, or nothing left to read: blocks may wait still, but a download with nothing to read is not full, it is done.
        if (!outcome.full || this.#nextGap() === null) {
          this.#emit({ type: 'storeFull', on: false, storedBytes: this.#store.stats().storedBytes })
          this.#setState('waiting')
          this.#reconsider()
          return
        }
        if (!this.#moved()) return
      }
    } finally {
      this.#check.running = false
    }
  }

  /** Whether the position moved while the check was made. A method, so that the flag is read as it stands and not as the check set it. */
  #moved(): boolean {
    return this.#check.again
  }

  /** The check could not be made: a closed store ends the downloader quietly, and any other failure is told and tried again at the next move. */
  #checkFailed(error: unknown): void {
    if (this.#closed) return
    if (isClosed(error)) {
      void this.close()
      return
    }
    this.#emit({
      type: 'error',
      from: 'engine',
      code: null,
      message: clip(`The store could not say whether it has room: ${messageOf(error)}`),
    })
  }

  /** A write was refused. A closed store ends the downloader quietly; anything else is a failure of this read that a pause and another try may mend. */
  #writeFailed(read: ActiveRead, error: unknown): void {
    if (!this.#isCurrent(read)) return
    if (isClosed(error)) {
      this.#end(read, 'aborted', null)
      void this.close()
      return
    }
    const message = clip(`The store refused a write: ${messageOf(error)}`)
    this.#end(read, 'failed', message)
    this.#emit({ type: 'error', from: 'engine', code: null, message })
    this.#retry(read, error)
  }

  /** A read failed in its request or its body. */
  #readFailed(read: ActiveRead, error: unknown): void {
    // A read that was let go of was aborted by the downloader, and what it met after that is not a failure.
    if (!this.#isCurrent(read)) return
    this.#end(read, 'failed', messageOf(error))
    if (error instanceof ReadError && error.fatal) {
      this.#fail(error)
      return
    }
    this.#retry(read, error)
  }

  /** The play has failed in a way that no try later can mend: every read is let go of, every timer is cleared, and everyone who waits is told. */
  #fail(error: ReadError): void {
    this.#failure = error
    this.#setState('failed')
    this.#emit({ type: 'error', from: 'engine', code: error.status, message: messageOf(error) })
    for (const read of [...this.#reads]) this.#end(read, 'aborted', null)
    if (this.#pause !== null) this.#endPause(this.#pause)
    for (const waiter of [...this.#waiters]) this.#refuse(waiter, error)
    this.#stopLevels()
  }

  /** A read failed in a way that a later try may mend: its own line waits, and the others go on. */
  #retry(read: ActiveRead, error: unknown, from = read.at): void {
    if (read.kind === 'onward') this.#pauseThenRetry(error)
    else if (read.waiter !== null) this.#pauseWaiter(read.waiter, error, from)
    this.#reconsider()
  }

  /**
   * Waits to try an onward read again, for as long as `retryDelayMs` says. `online` ends the
   * wait and reopens at once, and so does a return to the page when the network is up (a
   * page that is back with the network down would only fail again, and lengthen the
   * pauses). If there is nothing left to read by now, there is nothing to wait for; and if a
   * pause is under way already (the other onward read failed first) it is the same outage.
   */
  #pauseThenRetry(error: unknown): void {
    const gap = this.#nextGap()
    if (gap === null) {
      this.#finish()
      return
    }
    if (this.#pause !== null) return
    this.#failures += 1
    const attempt = this.#failures
    const delayMs = retryDelayMs(error, attempt, this.#random)
    this.#emit({ type: 'retry', attempt, delayMs, offset: gap.start })
    if (!this.#hasOnward()) this.#setState('waiting')
    this.#pause = this.#startPause(delayMs, gap.start, null)
  }

  /** The same for a priority read, with the count and the pause of the wait it is for. */
  #pauseWaiter(waiter: Waiter, error: unknown, from: number): void {
    if (!this.#waiters.has(waiter) || waiter.pause !== null) return
    // The read reopens where the failed one left off; if nothing is left there, at the first part of the range that is not held.
    const held = this.#store.held()
    const { start, end } = waiter.range
    const gap =
      held.firstGap(Math.min(Math.max(from, start), end), end) ?? held.firstGap(start, end)
    if (gap === null) {
      this.#answer(waiter)
      return
    }
    waiter.failures += 1
    const attempt = waiter.failures
    const delayMs = retryDelayMs(error, attempt, this.#random)
    this.#emit({ type: 'retry', attempt, delayMs, offset: gap.start })
    waiter.pause = this.#startPause(delayMs, gap.start, waiter)
  }

  /** Starts a pause: a timer, and the listeners that cut it short. */
  #startPause(delayMs: number, offset: number, owner: Waiter | null): Pause {
    const pause: Pause = { timer: null, offset, owner, ended: false, release: () => undefined }
    const resume = (): void => {
      if (pause.ended) return
      this.#endPause(pause)
      if (owner === null) this.#reconsider()
      else this.#serve(owner)
    }
    pause.timer = setTimeout(resume, delayMs)
    const releases = [
      this.#connectivity.onOnline(resume),
      this.#connectivity.onVisible(() => {
        if (this.#connectivity.online()) resume()
      }),
    ]
    pause.release = () => {
      for (const release of releases) release()
    }
    return pause
  }

  /** Ends a pause: its timer and its listeners go. */
  #endPause(pause: Pause): void {
    if (pause.ended) return
    pause.ended = true
    if (pause.timer !== null) clearTimeout(pause.timer)
    pause.release()
    if (pause.owner === null) {
      if (this.#pause === pause) this.#pause = null
    } else if (pause.owner.pause === pause) {
      pause.owner.pause = null
    }
  }

  /** The range as the engine gave it, checked: null for a range within the file, or the `RangeError` to refuse it with. */
  #wrong(range: ByteRange): RangeError | null {
    const { start, end } = range
    if (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      start <= end &&
      end <= this.#store.fileSize
    ) {
      return null
    }
    return new RangeError(
      `${start} to ${end} is not a range of a file of ${this.#store.fileSize} bytes`,
    )
  }

  #wait(range: ByteRange, priority: boolean, signal?: AbortSignal): Promise<void> {
    const wrong = this.#wrong(range)
    if (wrong !== null) return Promise.reject(wrong)
    if (this.#failure !== null) return Promise.reject(this.#failure)
    if (this.#closed) return Promise.reject(closedError())
    // The reason is the caller's own, as its signal gave it, and whatever it is.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    if (this.#store.held().has(range)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        range: { start: range.start, end: range.end },
        priority,
        resolve,
        reject,
        unlisten: null,
        failures: 0,
        pause: null,
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#refuse(waiter, signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.unlisten = () => {
          signal.removeEventListener('abort', onAbort)
        }
      }
      this.#waiters.add(waiter)
      this.#serve(waiter)
    })
  }

  /** Reads what a wait is owed: a priority read for each part of its range that is not held and that no read covers. */
  #serve(waiter: Waiter): void {
    if (this.#closed || this.#failure !== null || !this.#waiters.has(waiter)) return
    if (!waiter.priority || waiter.pause !== null) return
    const held = this.#store.held()
    const { start, end } = waiter.range
    for (let gap = held.firstGap(start, end); gap !== null; gap = held.firstGap(gap.end, end)) {
      if (!this.#covers(gap.start)) this.#open('priority', gap.start, gap.end - 1, waiter)
    }
  }

  /** Answers the waits whose range is held, after a write. */
  #checkWaiters(): void {
    if (this.#waiters.size === 0) return
    const held = this.#store.held()
    for (const waiter of [...this.#waiters]) {
      if (held.has(waiter.range)) this.#answer(waiter)
    }
  }

  /** Lets go of a wait: it is no longer listened for, and its pause is over. */
  #release(waiter: Waiter): void {
    this.#waiters.delete(waiter)
    waiter.unlisten?.()
    waiter.unlisten = null
    if (waiter.pause !== null) this.#endPause(waiter.pause)
  }

  #answer(waiter: Waiter): void {
    this.#release(waiter)
    waiter.resolve()
  }

  #refuse(waiter: Waiter, reason: unknown): void {
    this.#release(waiter)
    waiter.reject(reason)
  }
}
