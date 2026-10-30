// The downloader's onward read (DESIGN.md §10.4; the iron-clad spec §4.7). From the position
// to the end of the file, as far as the store allows: it reads the first stretch that is not
// held, writes what comes to the store a block at a time, and goes on to the next stretch when
// it meets data that is held. It "retries for as long as the play lasts, with growing pauses,
// and resumes at once on `online` and on returning to the page"; it stops, and says so, when
// the store is full of data nearer the position; and it ends only when every byte from the
// position to the end is held, or when the server says that no try later can work. Everything
// that happens is a timeline event, with its reason. A seek, a priority read and the engine's
// own interface are built on this and are not part of it.
//
// The page's connection is reached through `globalThis` with runtime checks, and the timers
// are the global ones, so the file needs no DOM types and runs in a page, a worker and Node
// alike.

import type { ByteRange } from '@dfs/mp4'
import type { TimelineEventInput } from '@dfs/shared'
import { blockOf } from './blocks.ts'
import { StoreError } from './errors.ts'
import { BLOCK_BYTES, LEVEL_EVERY_MS, RETRY_BASE_MS, RETRY_JITTER, RETRY_MAX_MS } from './limits.ts'
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
 * What the downloader is doing:
 * - `reading`: a read is open (and `waiting` and `full` have none);
 * - `full`: the store has no room for more data than is nearer the position, and the read is stopped until the position moves;
 * - `waiting`: a read failed and the next try is after a pause (a download that has not started waits too);
 * - `done`: every byte from the position to the end of the file is held;
 * - `failed`: a read failed in a way that no try later can mend.
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
  /** The clock, in milliseconds. The onward read measures no time of its own (its timers carry all of it), so it is not read yet. */
  now?: () => number
}

/** A read that is open. */
interface ActiveRead {
  readonly id: number
  /** Aborted whenever the downloader lets the read go, so that its connection closes at once. */
  readonly controller: AbortController
  /** The bytes that the read has received, written or not. */
  received: number
  /** The file offset of the next byte to be written. */
  at: number
}

/** A wait before a read is tried again. */
interface Pause {
  readonly timer: ReturnType<typeof setTimeout>
  /** Where the read will reopen, as the `retry` event said. */
  readonly offset: number
  /** What lets go of the connectivity listeners. */
  readonly release: () => void
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

export class Downloader {
  readonly #url: string
  readonly #store: PlayStore
  readonly #onEvent: (event: TimelineEventInput) => void
  readonly #connectivity: Connectivity
  readonly #fetch: typeof fetch | undefined
  readonly #random: () => number

  /** Before the start, nothing is read and nothing is wrong: the downloader waits. */
  #state: DownloaderState = 'waiting'
  #failure: ReadError | null = null
  #started = false
  #closed = false
  #closing: Promise<void> | null = null
  /** Where the play is: the read begins at the first gap at or after it. */
  #position = 0
  #nextId = 1
  #read: ActiveRead | null = null
  /** How many reads have failed in a row, which the next pause is long for. */
  #failures = 0
  #pause: Pause | null = null
  /** The one interval of the level, running while the downloader reads. */
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
  }

  state(): DownloaderState {
    return this.#state
  }

  /** The `ReadError` that ended the play; null while it has not ended. */
  failure(): ReadError | null {
    return this.#failure
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
   * is checked for room, since the position is what makes room; a pause that is under way
   * goes on unless the read would now begin elsewhere, so that a position that is told
   * often does not make a failing server be asked often; a download that was done reads
   * again if a gap is now ahead of the position.
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
      case 'done':
        this.#openNext()
        break
      case 'waiting': {
        const pause = this.#pause
        if (pause === null) break
        const gap = this.#nextGap()
        if (gap?.start === pause.offset) break
        this.#endPause(pause)
        this.#openNext()
        break
      }
      case 'reading':
      case 'failed':
        break
    }
  }

  /** Aborts the reads, clears every timer, lets go of the connectivity and closes the store. It never rejects, and a second call is the first. */
  close(): Promise<void> {
    this.#closing ??= this.#shutDown()
    return this.#closing
  }

  async #shutDown(): Promise<void> {
    this.#closed = true
    const read = this.#read
    if (read !== null) this.#end(read, 'aborted', null)
    const pause = this.#pause
    if (pause !== null) this.#endPause(pause)
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

  /** Changes the state. The level goes on while the downloader reads and stops in every other state. */
  #setState(state: DownloaderState): void {
    this.#state = state
    if (state !== 'reading') this.#stopLevels()
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

  /** Whether `read` is the read that is open: a read that was let go of is not, and what it meets after that is not the play's concern. */
  #isCurrent(read: ActiveRead): boolean {
    return this.#read === read
  }

  /**
   * Ends the read that is open, once: the connection is let go of whatever the body was
   * doing, and the timeline hears the end of the request. Answers whether it was the
   * current read (a read that was ended already is not ended again).
   */
  #end(read: ActiveRead, outcome: 'done' | 'aborted' | 'failed', message: string | null): boolean {
    if (!this.#isCurrent(read)) return false
    this.#read = null
    read.controller.abort()
    this.#emit({ type: 'requestEnd', id: read.id, bytes: read.received, outcome, message })
    return true
  }

  /** Reads the first stretch from the position that is not held, or finishes when there is none. */
  #openNext(): void {
    if (this.#closed || this.#read !== null || this.#state === 'failed') return
    const gap = this.#nextGap()
    if (gap === null) {
      this.#finish()
      return
    }
    const fileSize = this.#store.fileSize
    // Something is held after the gap unless it runs to the end of the file: the read stops where that begins.
    const to = gap.end < fileSize ? gap.end - 1 : null
    const read: ActiveRead = {
      id: this.#nextId,
      controller: new AbortController(),
      received: 0,
      at: gap.start,
    }
    this.#nextId += 1
    this.#read = read
    this.#setState('reading')
    this.#startLevels()
    this.#emit({ type: 'request', id: read.id, from: gap.start, to })
    void this.#pump(read, gap.start, to)
  }

  /** Every byte from the position to the end is held. */
  #finish(): void {
    this.#setState('done')
    this.#sendLevel()
  }

  /**
   * One read, from the request to the end of its body. The body is taken a piece at a time and
   * each piece is written before the next is asked for, so that the network is held back by the
   * store. It never rejects: whatever goes wrong is the downloader's to report.
   */
  async #pump(read: ActiveRead, from: number, to: number | null): Promise<void> {
    try {
      const opened = await openRead({
        url: this.#url,
        from,
        to,
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
        // A read that has brought a whole block is a network that works: the pauses start again.
        if (read.received >= BLOCK_BYTES) this.#failures = 0
        if (!(await this.#take(read, piece))) return
      }
    } catch (error) {
      this.#readFailed(read, error)
      return
    }
    // The body gave all it was asked for (or all that the server would send of it).
    if (this.#end(read, 'done', null)) this.#openNext()
  }

  /**
   * Writes a piece of a body to the store, a block at a time. Answers whether the read goes on;
   * when it does not, the read has been ended or let go of, and what follows is arranged.
   */
  async #take(read: ActiveRead, piece: Uint8Array): Promise<boolean> {
    let taken = 0
    while (taken < piece.length) {
      const length = Math.min(piece.length - taken, (blockOf(read.at) + 1) * BLOCK_BYTES - read.at)
      const part = piece.subarray(taken, taken + length)
      taken += length
      // Held already, by a read that was faster: it is not written again, and this read has met what is held.
      if (this.#store.held().has({ start: read.at, end: read.at + length })) {
        this.#metHeld(read)
        return false
      }
      let outcome: WriteOutcome
      try {
        outcome = await this.#store.write(read.at, part)
      } catch (error) {
        this.#writeFailed(read, error)
        return false
      }
      if (!this.#isCurrent(read)) return false
      read.at += length
      if (outcome.full) {
        this.#storeFull(read)
        return false
      }
      if (this.#store.held().heldFrom(read.at) > 0) {
        this.#metHeld(read)
        return false
      }
    }
    return true
  }

  /** The read's next byte is held: it has done what it was for, and the next stretch that is not held is read. */
  #metHeld(read: ActiveRead): void {
    if (this.#end(read, 'done', null)) this.#openNext()
  }

  /**
   * A write answered that a block found no room, with its bytes kept in the frontier. The read
   * stops until the position makes room. If it has nothing more to read (the block finished the
   * file) there is no reason to wait, and the download is done.
   */
  #storeFull(read: ActiveRead): void {
    if (this.#nextGap() === null) {
      this.#metHeld(read)
      return
    }
    if (!this.#end(read, 'aborted', null)) return
    this.#setState('full')
    this.#emit({ type: 'storeFull', on: true, storedBytes: this.#store.stats().storedBytes })
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
        if (!outcome.full) {
          this.#emit({ type: 'storeFull', on: false, storedBytes: this.#store.stats().storedBytes })
          this.#openNext()
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
    this.#pauseThenRetry(error)
  }

  /** A read failed in its request or its body. */
  #readFailed(read: ActiveRead, error: unknown): void {
    // A read that was let go of was aborted by the downloader, and what it met after that is not a failure.
    if (!this.#isCurrent(read)) return
    const message = messageOf(error)
    if (error instanceof ReadError && error.fatal) {
      this.#end(read, 'failed', message)
      this.#failure = error
      this.#setState('failed')
      this.#emit({ type: 'error', from: 'engine', code: error.status, message })
      return
    }
    this.#end(read, 'failed', message)
    this.#pauseThenRetry(error)
  }

  /**
   * Waits to try again. The nth failure in a row waits RETRY_BASE_MS doubled n − 1 times,
   * to RETRY_MAX_MS at most, moved by up to RETRY_JITTER either way; a server that said how
   * long to wait is believed, to RETRY_MAX_MS at most, since a play does not stall for minutes
   * on a server's say. `online` and a return to the page end the wait and reopen at once. If
   * there is nothing left to read by now, there is nothing to wait for.
   */
  #pauseThenRetry(error: unknown): void {
    const gap = this.#nextGap()
    if (gap === null) {
      this.#finish()
      return
    }
    this.#failures += 1
    const attempt = this.#failures
    const delayMs =
      error instanceof ReadError && error.retryAfterMs !== null
        ? Math.min(error.retryAfterMs, RETRY_MAX_MS)
        : Math.round(
            Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) *
              (1 + RETRY_JITTER * (2 * this.#random() - 1)),
          )
    this.#emit({ type: 'retry', attempt, delayMs, offset: gap.start })
    this.#setState('waiting')
    const resume = (): void => {
      const pause = this.#pause
      if (pause === null) return
      this.#endPause(pause)
      this.#openNext()
    }
    const timer = setTimeout(resume, delayMs)
    const releases = [this.#connectivity.onOnline(resume), this.#connectivity.onVisible(resume)]
    this.#pause = {
      timer,
      offset: gap.start,
      release: () => {
        for (const release of releases) release()
      },
    }
  }

  /** Ends a pause: its timer and its listeners go. */
  #endPause(pause: Pause): void {
    if (this.#pause !== pause) return
    this.#pause = null
    clearTimeout(pause.timer)
    pause.release()
  }
}
