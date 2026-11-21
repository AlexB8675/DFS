// Opening a play's download (DESIGN.md §10.4; the iron-clad spec §4.7). The first read of a play
// is its head, `HEAD_BYTES` from 0, which says the size of the file in its headers; the store
// can only be opened once that is known. So the head is asked for at once, the store is opened
// while the head's bytes go on coming (they are kept in memory until it is open), and the
// downloader is handed what is left of that read as its first: nothing is asked for twice, and
// the play's first bytes are not held up by the opening of the store. A head that fails before
// its headers is tried again for as long as it takes, with the downloader's own pauses, and
// only an answer that no try later can mend (the file is not there, or is not for this viewer)
// rejects. Everything is a timeline event, with its reason. The opening of the store is not waited
// for past the end of the play: a store whose worker is slow to answer does not hold up the viewer
// who left.

import type { TimelineEventInput } from '@dfs/shared'
import { Downloader, RateMeter, messageOf, pageConnectivity, retryDelayMs } from './downloader.ts'
import type { Connectivity } from './downloader.ts'
import { HEAD_BYTES } from './limits.ts'
import { openPlayStore } from './open.ts'
import type { StorageEstimator, StoreWorker } from './open.ts'
import { cleanLeftovers } from './opfs.ts'
import { ReadError, openRead } from './read.ts'
import type { RangeRead } from './read.ts'
import type { PlayStore } from './store.ts'

export interface OpenDownloadOptions {
  /** The file's route, which the play's reads are made of. */
  url: string
  /** The play's id, which names its directory and its lock in the private file system. */
  playId: string
  /** Makes the worker that serves the disk store, or is null where there is none to make. */
  makeWorker: (() => StoreWorker) | null
  /** Where the timeline's events go: the recorder, which stamps their time. */
  onEvent: (event: TimelineEventInput) => void
  /** The page's connection; `pageConnectivity()` when it is missing. */
  connectivity?: Connectivity
  /** The `fetch` to read with; the global one when it is missing. */
  fetch?: typeof fetch
  /** How much room the browser has; the browser's own `navigator.storage.estimate` when it is missing. */
  estimate?: StorageEstimator
  /** A number from 0 up to 1, for the jitter of the pauses; `Math.random` when it is missing. */
  random?: () => number
  /** The clock, in milliseconds, which the rate is measured by; `performance.now` when it is missing. */
  now?: () => number
  /** Holds the onward reads back after the head, until the caller releases them with `releaseOnward` (the engine does once the index is open). */
  holdOnward?: boolean
  /** Ends the opening: the head is let go of, and the promise is rejected with the signal's reason. */
  signal?: AbortSignal
}

/**
 * The pieces of the head's body as they came, kept until the downloader asks for them: it
 * reads what came before the store was open, and then what comes after, as one body. The
 * head is a megabyte, so nothing is held back for want of a bound.
 */
class HeadBuffer implements AsyncIterable<Uint8Array> {
  /** How many bytes have come. */
  arrived = 0
  readonly #pieces: Uint8Array[] = []
  #ended = false
  #failure: { error: unknown } | null = null
  #wake: (() => void) | null = null

  push(piece: Uint8Array): void {
    this.arrived += piece.length
    this.#pieces.push(piece)
    this.#notify()
  }

  end(): void {
    this.#ended = true
    this.#notify()
  }

  /** The body broke: what came is given first, and the break after it. */
  fail(error: unknown): void {
    this.#failure = { error }
    this.#notify()
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, undefined> {
    for (;;) {
      const piece = this.#pieces.shift()
      if (piece !== undefined) {
        yield piece
        continue
      }
      if (this.#failure !== null) throw this.#failure.error
      if (this.#ended) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }
}

/** A pause before the head is asked for again, which `online`, a return to the page (with the network up) and the signal cut short. */
function pauseFor(
  delayMs: number,
  connectivity: Connectivity,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const state: { timer: ReturnType<typeof setTimeout> | null; releases: (() => void)[] } = {
      timer: null,
      releases: [],
    }
    const onAbort = (): void => {
      end()
      // The reason is the caller's own, as its signal gave it, and whatever it is.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason)
    }
    const end = (): void => {
      if (state.timer !== null) clearTimeout(state.timer)
      for (const release of state.releases) release()
      signal?.removeEventListener('abort', onAbort)
    }
    const resume = (): void => {
      end()
      resolve()
    }
    state.timer = setTimeout(resume, delayMs)
    state.releases = [
      connectivity.onOnline(resume),
      connectivity.onVisible(() => {
        if (connectivity.online()) resume()
      }),
    ]
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Waits for `promise`, or rejects at once with the signal's reason if the signal aborts first.
 * What is waited for goes on, and is not the caller's any more: the caller sees to what it
 * brings (it is the caller's to close a store that opens late).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      // The reason is the caller's own, as its signal gave it, and whatever it is.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason)
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * Starts the play's download: asks for the head, opens the store for the size the head
 * says, and answers the started downloader as soon as the store is open, while the head
 * goes on flowing into it. It rejects only with the fatal `ReadError` of the head read (or the
 * signal's reason); a head that fails in a way a later try may mend is tried again, after a
 * pause, for as long as it takes. The `request`, `firstByte` and `requestEnd` of the head are
 * the first of the downloader's, with the first ids.
 */
export async function openDownload(options: OpenDownloadOptions): Promise<Downloader> {
  const { url, playId, makeWorker, onEvent, signal } = options
  const connectivity = options.connectivity ?? pageConnectivity()
  const random = options.random ?? Math.random
  const now = options.now ?? ((): number => performance.now())
  const emit = (event: TimelineEventInput): void => {
    try {
      onEvent(event)
    } catch {
      // A play that is opening must not be stopped by the record of it.
    }
  }

  signal?.throwIfAborted()
  const controller = new AbortController()
  const onAbort = (): void => {
    controller.abort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // The head, tried again until it answers or no try later can work.
    let id = 0
    let opened: RangeRead | null = null
    for (let attempt = 1; opened === null; attempt += 1) {
      signal?.throwIfAborted()
      id += 1
      emit({ type: 'request', id, from: 0, to: HEAD_BYTES - 1 })
      try {
        opened = await openRead({
          url,
          from: 0,
          to: HEAD_BYTES - 1,
          fileSize: null,
          signal: controller.signal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        })
        emit({ type: 'firstByte', id })
      } catch (error) {
        if (signal?.aborted === true) {
          emit({ type: 'requestEnd', id, bytes: 0, outcome: 'aborted', message: null })
          signal.throwIfAborted()
        }
        // Clipped as the downloader's messages are: one the timeline refuses is dropped whole, and the head's fatal `error` with it.
        const message = messageOf(error)
        emit({ type: 'requestEnd', id, bytes: 0, outcome: 'failed', message })
        if (error instanceof ReadError && error.fatal) {
          emit({ type: 'error', from: 'engine', code: error.status, message })
          throw error
        }
        const delayMs = retryDelayMs(error, attempt, random)
        emit({ type: 'retry', attempt, delayMs, offset: 0 })
        await pauseFor(delayMs, connectivity, signal)
      }
    }

    // The head's bytes are taken as they come, whether or not the store is open.
    const { total, body } = opened
    const meter = new RateMeter()
    const buffer = new HeadBuffer()
    void (async () => {
      try {
        for await (const piece of body) {
          meter.add(now(), piece.length)
          buffer.push(piece)
        }
        buffer.end()
      } catch (error) {
        buffer.fail(error)
      }
    })()

    // A worker that crashed in an earlier play left its directory: it is removed in the background, and the play does not wait for it.
    void cleanLeftovers()

    /** Lets the head go, for a play that will not go on. */
    const abandon = (): void => {
      controller.abort()
      emit({ type: 'requestEnd', id, bytes: buffer.arrived, outcome: 'aborted', message: null })
    }
    const opening = openPlayStore({
      playId,
      fileSize: total,
      makeWorker,
      onEvent,
      ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
    })
    let store: PlayStore
    try {
      store = await untilAborted(opening, signal)
    } catch (error) {
      abandon()
      // A store that opens after the play was given up is closed as soon as it has opened, and one that failed to open has nothing to close.
      opening.then((late) => late.close()).catch(() => undefined)
      throw error
    }
    if (signal?.aborted === true) {
      // The store came in the same turn as the end of the play: it is closed in the background, and the play is over at once.
      abandon()
      void store.close()
      signal.throwIfAborted()
    }

    const downloader = new Downloader({
      url,
      store,
      onEvent,
      connectivity,
      random,
      now,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      head: { id, controller, to: HEAD_BYTES - 1, body: buffer, meter },
      ...(options.holdOnward === undefined ? {} : { holdOnward: options.holdOnward }),
    })
    downloader.start()
    return downloader
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
