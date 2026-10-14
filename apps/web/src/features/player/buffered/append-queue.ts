// A queue for one SourceBuffer's operations (DESIGN.md §10.4). A SourceBuffer
// takes one operation at a time and throws when it is full, so the player
// queues its segments instead of appending them as they come, and when the
// browser says it is out of room it makes some (by dropping what was already
// played) and tries the same segment again.

/** What the queue needs of a SourceBuffer: the real one, or a test's fake. */
export interface BufferTarget extends EventTarget {
  readonly updating: boolean
  appendBuffer(data: ArrayBuffer): void
  remove(start: number, end: number): void
}

type Operation = { kind: 'append'; data: ArrayBuffer } | { kind: 'remove'; before: number }

/** Whether the browser threw because the buffer is full. */
function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError'
}

/**
 * Appends segments to a target in order, one at a time, starting the next when
 * the target says its last operation ended. A segment the target has no room
 * for is held, and the queue stops until `retry()`.
 */
export class AppendQueue {
  readonly #target: BufferTarget
  readonly #onQuotaExceeded: () => void
  /** What is left to do; while stopped, the held segment is the first append here. */
  readonly #operations: Operation[] = []
  readonly #waiting: (() => void)[] = []
  #stopped = false
  /** While stopped: how many removals were queued ahead of the held segment. */
  #madeRoom = 0

  constructor(target: BufferTarget, onQuotaExceeded: () => void) {
    this.#target = target
    this.#onQuotaExceeded = onQuotaExceeded
    target.addEventListener('updateend', () => {
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
    const operation: Operation = { kind: 'remove', before: time }
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

  /** After a quota error: tries the held segment again. */
  retry(): void {
    this.#stopped = false
    this.#madeRoom = 0
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
        if (next.kind === 'remove') {
          this.#operations.shift()
          if (next.before > 0) this.#target.remove(0, next.before)
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
        this.#operations.shift()
      }
    } finally {
      if (this.idle) {
        for (const resolve of this.#waiting.splice(0)) resolve()
      }
    }
  }
}
