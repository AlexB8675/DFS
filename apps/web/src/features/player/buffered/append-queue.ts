// A queue for one SourceBuffer's operations (DESIGN.md §10.4). A SourceBuffer
// takes one operation at a time and throws when it is full, so the player
// queues its segments instead of appending them as they come, and when the
// browser says it is out of room it makes some (by dropping what was already
// played) and tries the same segment again. The player can also hold the
// segments back until enough are queued to play without stopping, and drop
// them all when the viewer seeks.

/** What the queue needs of a SourceBuffer: the real one, or a test's fake. */
export interface BufferTarget extends EventTarget {
  readonly updating: boolean
  appendBuffer(data: ArrayBuffer): void
  remove(start: number, end: number): void
  /** Cancels an append under way; the browser fires `updateend` for it. */
  abort(): void
}

/** A removal that `seek` marks is the one a reset queues, and runs even while held. */
type Operation =
  { kind: 'append'; data: ArrayBuffer } | { kind: 'remove'; before: number; seek: boolean }

/** Whether the browser threw because the buffer is full. */
function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError'
}

/**
 * Appends segments to a target in order, one at a time, starting the next when
 * the target says its last operation ended. A segment the target has no room
 * for is held, and the queue stops until `retry()`. Apart from that, `hold()`
 * keeps every operation waiting until `release()`, and `reset()` drops them.
 */
export class AppendQueue {
  readonly #target: BufferTarget
  readonly #onQuotaExceeded: () => void
  /** What is left to do; while stopped, the held segment is the first append here. */
  readonly #operations: Operation[] = []
  readonly #waiting: (() => void)[] = []
  #stopped = false
  /** Whether `hold()` keeps operations from starting; a stop for lack of room is separate. */
  #held = false
  /** While stopped: how many removals were queued ahead of the held segment. */
  #madeRoom = 0
  /** What the target was last handed and has not ended; `reset()` cancels only an append. */
  #inFlight: 'append' | 'remove' | null = null
  /** Whether `#inFlight` is a seek's removal. */
  #seekInFlight = false

  constructor(target: BufferTarget, onQuotaExceeded: () => void) {
    this.#target = target
    this.#onQuotaExceeded = onQuotaExceeded
    target.addEventListener('updateend', () => {
      // An operation cancelled or ended earlier may report its end after the next has
      // begun; that one is still under way.
      if (!target.updating) {
        this.#inFlight = null
        this.#seekInFlight = false
      }
      this.#run()
    })
  }

  /** Queues a segment; appended in order, one at a time. */
  append(data: ArrayBuffer): void {
    this.#operations.push({ kind: 'append', data })
    this.#run()
  }

  /** Queues dropping what's buffered before `time`, in seconds (after what's queued before it). */
  removeBefore(time: number): void {
    const operation: Operation = { kind: 'remove', before: time, seek: false }
    if (this.#stopped) {
      // Room has to be made before the held segment is tried again.
      this.#operations.splice(this.#madeRoom, 0, operation)
      this.#madeRoom += 1
    } else {
      this.#operations.push(operation)
    }
    this.#run()
  }

  /** Bytes queued and not yet appended. */
  get pendingBytes(): number {
    let bytes = 0
    for (const operation of this.#operations) {
      if (operation.kind === 'append') bytes += operation.data.byteLength
    }
    return bytes
  }

  /** Whether nothing is queued and the target isn't updating. */
  get idle(): boolean {
    return this.#operations.length === 0 && !this.#target.updating
  }

  /** Whether `hold()` is keeping operations from starting. */
  get held(): boolean {
    return this.#held
  }

  /**
   * Whether a seek's removal is queued or under way, so that what the target
   * reports as buffered is still the old position's.
   */
  get resetting(): boolean {
    return (
      this.#seekInFlight ||
      this.#operations.some((operation) => operation.kind === 'remove' && operation.seek)
    )
  }

  /** After a quota error: tries the held segment again (a `hold()` still stands). */
  retry(): void {
    this.#stopped = false
    this.#madeRoom = 0
    this.#run()
  }

  /**
   * From now on no operation starts: appends and removals queue up. One already
   * handed to the target finishes.
   */
  hold(): void {
    this.#held = true
  }

  /** Runs what `hold()` kept waiting, in order (a stop for lack of room still stands). */
  release(): void {
    this.#held = false
    this.#run()
  }

  /**
   * For a seek: drops every operation queued (a segment held for lack of room
   * too, and the stop with it), cancels the append under way, and clears what's
   * buffered before `clearTo`, in seconds. That removal runs even while held, and
   * `resetting` is true until it ends; nothing after it runs until `release()`.
   * A removal already under way is left to finish: it can't be cancelled.
   */
  reset(clearTo: number): void {
    this.#operations.length = 0
    this.#stopped = false
    this.#madeRoom = 0
    if (clearTo > 0) this.#operations.push({ kind: 'remove', before: clearTo, seek: true })
    // Only an append under way is cancelled. With nothing under way there is nothing to
    // cancel, and abort() throws once the MediaSource has ended (a seek back after the
    // whole video loaded); the removal below reopens it. It throws while a removal runs
    // too, and that one ends on its own, before the removal queued here starts.
    if (this.#target.updating && this.#inFlight === 'append') {
      this.#target.abort()
      this.#inFlight = null
    }
    this.#run()
  }

  /** A promise that settles once the queue is idle. */
  drained(): Promise<void> {
    if (this.idle) return Promise.resolve()
    return new Promise((resolve) => {
      this.#waiting.push(resolve)
    })
  }

  /** Starts operations while the target can take one. */
  #run(): void {
    try {
      while (!this.#stopped && !this.#target.updating) {
        const next = this.#operations.at(0)
        if (!next) break
        // Held: only a seek's removal starts.
        if (this.#held && !(next.kind === 'remove' && next.seek)) break
        if (next.kind === 'remove') {
          this.#operations.shift()
          if (next.before > 0) {
            this.#target.remove(0, next.before)
            this.#inFlight = 'remove'
            this.#seekInFlight = next.seek
          }
          continue
        }
        try {
          this.#target.appendBuffer(next.data)
        } catch (error) {
          if (!isQuotaError(error)) {
            // The segment is lost, but the queue is not stuck behind it.
            this.#operations.shift()
            throw error
          }
          this.#stopped = true
          this.#madeRoom = 0
          this.#onQuotaExceeded()
          return
        }
        this.#inFlight = 'append'
        this.#seekInFlight = false
        this.#operations.shift()
      }
    } finally {
      if (this.idle) {
        for (const resolve of this.#waiting.splice(0)) resolve()
      }
    }
  }
}
