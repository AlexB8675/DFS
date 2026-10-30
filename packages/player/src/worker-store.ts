// The page's side of the store (DESIGN.md §10.4; the iron-clad spec §4.7). A play's
// disk store runs in a worker, and this class answers for it with the same
// interface as the store itself: each call is a numbered request, and the answer
// that carries its number is the result. What the store holds is kept here as well,
// from what the answers say, so that `held()` and `stats()` stay synchronous.

import { StoreError } from './errors.ts'
import { LATE_TIMER_MS, STORE_CALL_MS, STORE_OPEN_MS, WAKE_GRACE_MS } from './limits.ts'
import { dataOf, idOf, parseReply } from './protocol.ts'
import type { Endpoint, StoreReply, StoreRequest, WireError } from './protocol.ts'
import { RangeSet } from './ranges.ts'
import type { PlayStore, StoreStats, WriteOutcome } from './store.ts'

/** A call that waits for its answer, and the deadline it has for it. */
interface Waiting {
  resolve: (reply: StoreReply) => void
  reject: (error: StoreError) => void
  timer: ReturnType<typeof setTimeout>
}

/** The error that an error answer stands for: a caller's mistake stays a `RangeError`, and the store's own failures keep their kinds. */
function errorOf(error: WireError): Error {
  return error.kind === 'range'
    ? new RangeError(error.message)
    : new StoreError(error.kind, error.message)
}

/** The error of an answer that is not the kind that the request was answered with. */
function unexpected(asked: string, answered: string): StoreError {
  return new StoreError('disk', `the worker answered a ${asked} with a ${answered}`)
}

/**
 * Bytes that can be transferred to the worker as they are: those that fill a buffer
 * (which the call then detaches, as `postMessage` does). Bytes that are a part of a
 * larger buffer, or are in a shared one, are copied, so that the rest of the caller's
 * buffer is not taken from it.
 */
function transferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return new Uint8Array(buffer)
  }
  return bytes.slice()
}

/** The text a failure of the endpoint adds to what is said of it, when the event says why. */
function reasonOf(event: unknown): string {
  if (
    typeof event === 'object' &&
    event !== null &&
    'message' in event &&
    typeof event.message === 'string' &&
    event.message !== ''
  ) {
    return `: ${event.message}`
  }
  return ''
}

/**
 * The conversation with the worker: it numbers the requests, matches the answers, and fails
 * every call once the worker is gone. A worker that is alive but does not answer is gone
 * too: each request has a deadline, counted from when it is sent, and the first to expire
 * fails the channel as the death of the worker does. A deadline whose timer fires more than
 * `LATE_TIMER_MS` after it was due, by the clock, fired in a page that was asleep, frozen or
 * throttled, where the worker's answer may be waiting to be handled: that request is given
 * `WAKE_GRACE_MS` more, once, and the expiry of the grace is the worker's death.
 */
class Channel {
  readonly #endpoint: Endpoint
  readonly #now: () => number
  readonly #waiting = new Map<number, Waiting>()
  #nextId = 1
  #dead: StoreError | null = null

  readonly #onMessage = (event: unknown): void => {
    const data = dataOf(event)
    const reply = parseReply(data)
    // An answer that cannot be read fails the call it is for, so that the call does not wait for ever; one that is for no call is not ours.
    const id = reply?.id ?? idOf(data)
    if (id === null) return
    const waiting = this.#take(id)
    if (waiting === undefined) return
    if (reply === null) {
      waiting.reject(new StoreError('disk', 'the worker gave an answer that cannot be read'))
    } else {
      waiting.resolve(reply)
    }
  }

  readonly #onError = (event: unknown): void => {
    this.#fail(new StoreError('disk', `the worker of the store failed${reasonOf(event)}`))
  }

  readonly #onMessageError = (): void => {
    this.#fail(new StoreError('disk', 'the worker of the store sent a message that cannot be read'))
  }

  constructor(endpoint: Endpoint, now: () => number) {
    this.#endpoint = endpoint
    this.#now = now
    endpoint.addEventListener('message', this.#onMessage)
    endpoint.addEventListener('error', this.#onError)
    endpoint.addEventListener('messageerror', this.#onMessageError)
    endpoint.start?.()
  }

  /** What the worker failed with, once it has: it never answers again. */
  get dead(): StoreError | null {
    return this.#dead
  }

  /** Takes the call for `id` out of those that wait, and stops its deadline. Every way that a call ends goes through here. */
  #take(id: number): Waiting | undefined {
    const waiting = this.#waiting.get(id)
    if (waiting === undefined) return undefined
    this.#waiting.delete(id)
    clearTimeout(waiting.timer)
    return waiting
  }

  /** Fails every call in flight, and every call after. */
  #fail(error: StoreError): void {
    if (this.#dead !== null) return
    this.#dead = error
    const waiting = [...this.#waiting.values()]
    this.#waiting.clear()
    for (const call of waiting) {
      clearTimeout(call.timer)
      call.reject(error)
    }
  }

  /**
   * Starts the deadline of the call `id`: it fails the channel when `ms` have passed, unless
   * the timer fired late (the page stood still, so the worker was not given its time), in which
   * case the call is given a grace, once, and the grace is watched in the same way. `deadlineMs`
   * is the deadline the call was given, which the error says.
   */
  #watch(
    id: number,
    ms: number,
    deadlineMs: number,
    graced: boolean,
  ): ReturnType<typeof setTimeout> {
    const armedAt = this.#now()
    return setTimeout(() => {
      const waiting = this.#waiting.get(id)
      if (waiting === undefined) return
      if (!graced && this.#now() - armedAt > ms + LATE_TIMER_MS) {
        waiting.timer = this.#watch(id, WAKE_GRACE_MS, deadlineMs, true)
        return
      }
      const more = graced ? `, nor in the ${WAKE_GRACE_MS / 1000} s more that it was given` : ''
      this.#fail(
        new StoreError(
          'disk',
          `the worker of the store did not answer within ${deadlineMs / 1000} s${more}`,
        ),
      )
    }, ms)
  }

  /**
   * Sends a request and waits for its answer, which is a value whether it succeeded or not.
   * It rejects only if the worker is gone, or does not answer in time: `STORE_OPEN_MS` for
   * the open, `STORE_CALL_MS` for the rest, counted from now, so that a request that waits
   * behind the earlier ones has the time they take to spend.
   */
  ask(build: (id: number) => StoreRequest, transfer: ArrayBuffer[] = []): Promise<StoreReply> {
    if (this.#dead !== null) return Promise.reject(this.#dead)
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      try {
        const request = build(id)
        const deadlineMs = request.type === 'open' ? STORE_OPEN_MS : STORE_CALL_MS
        const timer = this.#watch(id, deadlineMs, deadlineMs, false)
        this.#waiting.set(id, { resolve, reject, timer })
        this.#endpoint.postMessage(request, transfer)
      } catch (error) {
        this.#take(id)
        const reason = error instanceof Error ? error.message : 'it did not say why'
        reject(new StoreError('disk', `the request could not be sent to the worker: ${reason}`))
      }
    })
  }

  /** Sends a message that is not answered. */
  post(message: StoreRequest): void {
    this.#endpoint.postMessage(message, [])
  }

  /** Stops listening to the worker. */
  detach(): void {
    this.#endpoint.removeEventListener('message', this.#onMessage)
    this.#endpoint.removeEventListener('error', this.#onError)
    this.#endpoint.removeEventListener('messageerror', this.#onMessageError)
  }
}

/**
 * A play's store as the page sees it: the calls go to the worker that holds the store,
 * and the results come back. What it holds is learned from the answers to the writes:
 * a write adds its range, and takes away what the answer says was let go of. A write that
 * fails on the disk has still put its bytes in the store's frontier, where they are held
 * and can be read, so its range is added too; what it evicted is reported by the next write
 * that succeeds. A write that was refused, or that found the store closed, changed nothing.
 * If the worker dies (its endpoint reports an error), or does not answer a request within
 * its deadline (`STORE_CALL_MS`, and `STORE_OPEN_MS` for the open), every call in flight and
 * every call after rejects with a `StoreError` of kind `disk`, and so does `setPosition`,
 * because nothing will answer: the downloader sees it at once and does not wait for ever.
 * `close` resolves.
 */
export class WorkerStore implements PlayStore {
  readonly backend: 'disk' | 'memory'
  readonly fileSize: number

  readonly #channel: Channel
  #capBytes: number
  #held = new RangeSet()
  #stats: StoreStats
  #closed = false
  /** The first call of `close`, which every later call is given. */
  #closing: Promise<void> | null = null

  private constructor(channel: Channel, fileSize: number, capBytes: number, stats: StoreStats) {
    this.#channel = channel
    this.fileSize = fileSize
    this.#capBytes = capBytes
    this.backend = stats.backend
    this.#stats = stats
  }

  /**
   * Opens a play's store in the worker at the other end of `endpoint`. The worker takes
   * the play's lock, opens its file, and tries it, and it says why when it cannot: a
   * `StoreError` of kind `no-opfs`, `quota` or `refused`, or a `RangeError` for a size
   * that is not one. A worker that has not answered in `STORE_OPEN_MS` is a `StoreError` of
   * kind `disk`. The deadlines are judged late or on time by `now`, the wall clock when it is
   * missing (a clock that counts the time a machine slept, which a monotonic one may not).
   * Once it has opened, the store is the page's to close.
   */
  static async open(
    endpoint: Endpoint,
    options: { playId: string; fileSize: number; capBytes: number; now?: () => number },
  ): Promise<WorkerStore> {
    const channel = new Channel(endpoint, options.now ?? ((): number => Date.now()))
    try {
      const reply = await channel.ask((id) => ({
        id,
        type: 'open',
        playId: options.playId,
        fileSize: options.fileSize,
        capBytes: options.capBytes,
      }))
      if (!reply.ok) throw errorOf(reply.error)
      if (reply.type !== 'open') throw unexpected('open', reply.type)
      return new WorkerStore(channel, options.fileSize, reply.capBytes, reply.stats)
    } catch (error) {
      channel.detach()
      throw error
    }
  }

  /** Throws `closed` once the store is closed, and what the worker failed with once it has. */
  #assertUsable(): void {
    if (this.#closed) throw new StoreError('closed', 'the store is closed')
    if (this.#channel.dead !== null) throw this.#channel.dead
  }

  /** The most that the worker's slots hold, in whole blocks: what it said when it opened, and what it said when it last shrank. */
  get capBytes(): number {
    return this.#capBytes
  }

  held(): RangeSet {
    const copy = new RangeSet()
    for (const range of this.#held.ranges()) copy.add(range)
    return copy
  }

  async write(offset: number, bytes: Uint8Array): Promise<WriteOutcome> {
    this.#assertUsable()
    const whole = transferable(bytes)
    // The buffer is given away by the call, and its length with it.
    const length = whole.length
    const reply = await this.#channel.ask(
      (id) => ({ id, type: 'write', offset, bytes: whole }),
      [whole.buffer],
    )
    if (reply.ok) {
      if (reply.type !== 'write') throw unexpected('write', reply.type)
      this.#stats = reply.stats
      // Not after a close: the store has forgotten what it held.
      if (!this.#closed) {
        this.#held.add({ start: offset, end: offset + length })
        for (const range of reply.outcome.evicted) this.#held.remove(range)
      }
      return reply.outcome
    }
    if (reply.stats !== undefined) this.#stats = reply.stats
    const { kind } = reply.error
    if (!this.#closed && (kind === 'quota' || kind === 'disk' || kind === 'sealed')) {
      this.#held.add({ start: offset, end: offset + length })
    }
    throw errorOf(reply.error)
  }

  async read(start: number, end: number): Promise<Uint8Array | null> {
    this.#assertUsable()
    const reply = await this.#channel.ask((id) => ({ id, type: 'read', start, end }))
    if (!reply.ok) throw errorOf(reply.error)
    if (reply.type !== 'read') throw unexpected('read', reply.type)
    return reply.bytes
  }

  /**
   * Has the worker make the slots in use the store's cap (`CoreStore.shrinkToUsed`), for a
   * disk that has no room for more, and answers the new cap. It runs after the requests that
   * came before it, so it counts the slots that their writes have settled.
   */
  async shrinkToUsed(): Promise<number> {
    this.#assertUsable()
    const reply = await this.#channel.ask((id) => ({ id, type: 'shrink' }))
    if (!reply.ok) throw errorOf(reply.error)
    if (reply.type !== 'shrink') throw unexpected('shrink', reply.type)
    this.#stats = reply.stats
    this.#capBytes = reply.capBytes
    return reply.capBytes
  }

  setPosition(offset: number): void {
    this.#assertUsable()
    // The worker does not answer a position, so a position that is no position is refused here.
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.fileSize) {
      throw new RangeError(`${offset} is not a position in a file of ${this.fileSize} bytes`)
    }
    this.#channel.post({ type: 'position', offset })
  }

  stats(): StoreStats {
    return { ...this.#stats }
  }

  /**
   * Deletes everything: the worker closes the file, removes the directory and releases the
   * lock, after the requests that came before. Calls made from now on reject with `closed`.
   * A second call while the first is in flight is answered when the first is, with what the
   * first answers, and sends nothing. If the worker is gone, or goes while this waits, there
   * is nothing to delete from the page: this resolves, and the directory is left for the next
   * start of the app to clean up (the worker's lock died with it). A worker that does not
   * answer the close within `STORE_CALL_MS` is gone in the same way, so this resolves in
   * that time at most.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    this.#closed = true
    this.#held = new RangeSet()
    try {
      if (this.#channel.dead !== null) return
      const reply = await this.#channel.ask((id) => ({ id, type: 'close' }))
      if (!reply.ok) throw errorOf(reply.error)
      if (reply.type !== 'close') throw unexpected('close', reply.type)
    } catch (error) {
      // The worker died while the close waited: there is nobody to answer, and the call fails with that and nothing else.
      if (this.#channel.dead === null) throw error
    } finally {
      this.#channel.detach()
    }
  }
}
