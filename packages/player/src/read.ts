// One Range read of the file that a play downloads, checked (DESIGN.md §10.4; the iron-clad
// spec §4.7). The downloader retries for as long as the play lasts, so the one thing it needs
// from a read that fails is whether a try later can work. A network that dropped, a server
// that is busy and a body that ended early can; an answer that says the file is not there, is
// not for this viewer, is not the file the play began with, or does not honour `Range` cannot,
// and ends the play. `openRead` sends the request, checks the answer before any of its body is
// taken, and hands the body back as a stream of byte pieces that fails the same way. It uses
// what `fetch` gives in a page and in a worker, and nothing that only Node has.
//
// A server that goes quiet without closing its connection (a black-holed path, a tunnel, a NAT
// that dropped its mapping) gives the page no error to act on, so a read gives up on it: with no
// answer, or no new piece of its body, for `READ_IDLE_MS` of waiting on the network, it fails with
// a `ReadError` that is not fatal, and lets its connection go. The wait is the network's and only
// that: the body is a generator that is parked at its `yield` while its consumer writes the
// piece it was given, and no timer runs then.

import { READ_IDLE_MS } from './limits.ts'

/** Why a read failed, and what the downloader should do about it. */
export class ReadError extends Error {
  /** True when trying again cannot work: the play ends. False when a later try may. */
  readonly fatal: boolean
  /** The status of the answer that the failure belongs to; null when there was none (the request never got an answer). */
  readonly status: number | null
  /** How long the server asked to wait before another try (`Retry-After`), as it gave it; null when it said nothing readable. */
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    details: {
      fatal: boolean
      status?: number | null
      retryAfterMs?: number | null
      cause?: unknown
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'ReadError'
    this.fatal = details.fatal
    this.status = details.status ?? null
    this.retryAfterMs = details.retryAfterMs ?? null
  }
}

export interface OpenReadOptions {
  /** The file's route, which is sent as it is. No error names any part of it: a share link's token is in its path. */
  url: string
  /** The first byte to read. */
  from: number
  /** The last byte to read, included; null reads to the end of the file. */
  to: number | null
  /** The size the play knows the file to have, once a read has found it out; null before. Any answer that says otherwise is the wrong file. */
  fileSize: number | null
  /** Aborted when the play is over, or no longer wants this read. */
  signal: AbortSignal
  /** The `fetch` to use; the global one when it is missing. */
  fetch?: typeof fetch
}

export interface RangeRead {
  /** The size of the whole file, as the answer says. */
  total: number
  /**
   * The bytes of the range, in the pieces the network gave them, and no more than were asked
   * for. It fails with a `ReadError` that is not fatal if the connection breaks or the body
   * ends before its length, and with whatever the signal was aborted with if it is aborted.
   * It is to be iterated to its end or left with a `break` (which lets the connection go),
   * or the signal is to be aborted.
   */
  body: AsyncIterable<Uint8Array>
}

/** What of a reader the body needs: `ReadableStreamDefaultReader` has it, in a page, a worker and Node. */
interface BodyReader {
  read(): Promise<{ done: boolean; value?: unknown }>
  cancel(): Promise<void>
}

/**
 * What an error names of a read in place of its URL: the bytes it asked for. A share link or
 * an archive link has its token in the path, a query can carry one too, and the address can
 * carry a password; a message reaches the timeline, which the server keeps. So no message
 * names any part of the URL.
 */
function rangeOf(from: number, to: number | null): string {
  return `bytes ${from}-${to ?? ''}`
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  )
}

/** A whole number that a header spells with digits and nothing else; null for anything else. */
function parseDigits(text: string | null | undefined): number | null {
  if (text === null || text === undefined || !/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * The parts of a `Content-Range` of the form `bytes <start>-<end>/<total>`, or null when it
 * is missing, is of another form (a size that is not known, `*`, included) or has numbers
 * that are not whole.
 */
function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | null {
  if (header === null) return null
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(header.trim())
  const start = parseDigits(match?.[1])
  const end = parseDigits(match?.[2])
  const total = parseDigits(match?.[3])
  if (start === null || end === null || total === null) return null
  return { start, end, total }
}

/**
 * How long a `Retry-After` says to wait, in milliseconds: its seconds, or the time from now to
 * its HTTP date (none, if that has passed). Null for anything that is neither.
 */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null
  const text = header.trim()
  const seconds = parseDigits(text)
  if (seconds !== null) return seconds * 1000
  // `Date.parse` takes a good deal that is not a date (a lone "1.5" is one), so what it is given has the look of an HTTP date.
  if (!/[a-z]{3}/i.test(text) || !/\d{1,2}:\d{2}/.test(text)) return null
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

/**
 * Waits for `promise`, but not longer than `READ_IDLE_MS`. When the time is up the wait ends
 * with the error `expire` makes, which also lets go of whatever `promise` waits on; `discard`
 * is given what `promise` brings if it comes after that. The timer is cleared whenever the
 * promise settles first.
 */
function untilIdle<T>(
  promise: Promise<T>,
  expire: () => ReadError,
  discard?: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      reject(expire())
    }, READ_IDLE_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        if (expired) discard?.(value)
        else resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        // What fails after the read gave up is the abort that it made itself. Before that, the failure is the promise's own, whatever it is.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        if (!expired) reject(error)
      },
    )
  })
}

/** Lets the body of a response go, which is not waited for: the connection is not worth a wait. */
function dismiss(source: { cancel(): Promise<void> } | null | undefined): void {
  try {
    source?.cancel().catch(() => undefined)
  } catch {
    // A body that cannot be cancelled is the browser's to clean up.
  }
}

/** The body of a read: `length` bytes from the reader, in pieces, or the failure that stopped them. */
async function* readBody(
  reader: BodyReader,
  length: number,
  signal: AbortSignal,
  asked: string,
  status: number,
  link: Link,
): AsyncGenerator<Uint8Array, void, undefined> {
  let received = 0
  try {
    while (received < length) {
      // An abort ends the body at once, even when bytes are in hand.
      signal.throwIfAborted()
      let result: { done: boolean; value?: unknown }
      try {
        // The timer runs while this waits for the network, and stops when it answers: the `yield` below parks the generator while the consumer writes, with no timer.
        result = await untilIdle(reader.read(), () => {
          link.own.abort()
          return new ReadError(
            `The server sent nothing for ${READ_IDLE_MS / 1000} s for ${asked}, after ${received} of ${length} bytes.`,
            { fatal: false, status },
          )
        })
      } catch (error) {
        // An abort is the play's own business, and is not a failure of the network.
        if (signal.aborted || isAbortError(error)) throw error
        if (error instanceof ReadError) throw error
        throw new ReadError(
          `The connection for ${asked} broke after ${received} of ${length} bytes.`,
          { fatal: false, status, cause: error },
        )
      }
      if (result.done) {
        throw new ReadError(`The body for ${asked} ended after ${received} of ${length} bytes.`, {
          fatal: false,
          status,
        })
      }
      const value = result.value
      if (!(value instanceof Uint8Array)) {
        throw new ReadError(`The body for ${asked} gave something other than bytes.`, {
          fatal: false,
          status,
        })
      }
      if (value.length === 0) continue
      // A server that sends more than the range it said (or a 200 where a range was asked) is not read past that range.
      const piece = value.length > length - received ? value.subarray(0, length - received) : value
      received += piece.length
      yield piece
    }
  } finally {
    // Whatever ended the body (its length, a failure, an abort, a consumer that stopped) lets the connection go.
    link.release()
    dismiss(reader)
  }
}

/**
 * The signal that a read's fetch is given: its own, which follows the caller's (with its
 * reason) and is also aborted when the server goes quiet, so that the request is let go of.
 * `AbortSignal.any` would do this in one line, but Firefox 120 and Safari 17.0 lack it.
 */
interface Link {
  /** Aborts the request. */
  readonly own: AbortController
  /** Stops following the caller's signal; the read is over. */
  release: () => void
}

function linkTo(signal: AbortSignal): Link {
  const own = new AbortController()
  const follow = (): void => {
    own.abort(signal.reason)
  }
  if (signal.aborted) follow()
  else signal.addEventListener('abort', follow, { once: true })
  return {
    own,
    release: () => {
      signal.removeEventListener('abort', follow)
    },
  }
}

/** A body of no bytes. */
async function* emptyBody(): AsyncGenerator<Uint8Array, void, undefined> {
  // Nothing to give.
}

/**
 * Reads `from` to `to` (included) of the file at `url`, with the answer checked. It rejects
 * with a `ReadError`, `fatal` or not as follows, or with what the signal was aborted with, or
 * with a `RangeError` for a call that is wrong.
 *
 * It accepts a `206` whose `Content-Range` is `bytes <from>-<end>/<total>`, with `total` the
 * `fileSize` when that is given (`end` may be short of `to`: a server may send less than it
 * is asked for), and a `200` only at `from` 0, with a `Content-Length`, which is the `total`.
 * Statuses `408`, `429` and `5xx` are not fatal, and say how long to wait if they have a
 * `Retry-After`; every other status that is not `200` or `206` is. So is an answer that is
 * not the range asked for, or is of another file than the play's.
 *
 * A server that does not answer, or whose body sends nothing, for `READ_IDLE_MS` is given up
 * on: the request is aborted and the read fails with a `ReadError` that is not fatal (the
 * time that the consumer of the body takes between two pieces is not counted).
 */
export async function openRead(options: OpenReadOptions): Promise<RangeRead> {
  const { url, from, to, fileSize, signal } = options
  if (!Number.isSafeInteger(from) || from < 0) {
    throw new RangeError(`${from} is not a position in a file`)
  }
  if (to !== null && (!Number.isSafeInteger(to) || to < from)) {
    throw new RangeError(`${to} is not an end at or after ${from}`)
  }
  if (fileSize !== null && (!Number.isSafeInteger(fileSize) || fileSize < 0)) {
    throw new RangeError(`${fileSize} is not the size of a file`)
  }

  const asked = rangeOf(from, to)
  // Called as a plain function: a browser's `fetch` refuses to be called as a method of anything but the window.
  const doFetch = options.fetch ?? fetch
  const link = linkTo(signal)
  let response: Response
  try {
    response = await untilIdle(
      doFetch(url, {
        headers: { Range: `bytes=${from}-${to ?? ''}` },
        // The store is the one place a play's bytes are kept, sealed. Without this the browser may keep each answer, as plain bytes, in its HTTP cache on the disk, after the play and outside the store's cap.
        cache: 'no-store',
        signal: link.own.signal,
      }),
      () => {
        link.own.abort()
        return new ReadError(
          `The server sent nothing for ${READ_IDLE_MS / 1000} s after the request for ${asked}.`,
          { fatal: false },
        )
      },
      (late) => {
        dismiss(late.body)
      },
    )
  } catch (error) {
    link.release()
    if (signal.aborted || isAbortError(error)) throw error
    if (error instanceof ReadError) throw error
    throw new ReadError(`The request for ${asked} failed before the server answered.`, {
      fatal: false,
      cause: error,
    })
  }

  // The link is the body's to let go of once there is a body; every other way out of here lets go of it.
  let owned = false
  try {
    const { status } = response
    if (status !== 200 && status !== 206) {
      dismiss(response.body)
      // A busy server or a network in between may be better in a while; the rest will answer the same.
      const worthAnotherTry = status === 408 || status === 429 || status >= 500
      throw new ReadError(`The server answered ${status} for ${asked}.`, {
        fatal: !worthAnotherTry,
        status,
        retryAfterMs: worthAnotherTry ? parseRetryAfter(response.headers.get('Retry-After')) : null,
      })
    }

    const refuse = (why: string): never => {
      dismiss(response.body)
      throw new ReadError(`${why} (the answer was ${status} for ${asked}).`, {
        fatal: true,
        status,
      })
    }

    /** The size of the file, and the last byte the answer has. */
    let total: number
    let end: number
    if (status === 206) {
      const range = parseContentRange(response.headers.get('Content-Range'))
      if (range === null) {
        return refuse(
          'The server’s Content-Range is missing, unreadable or without the file’s size',
        )
      }
      if (range.start !== from) {
        return refuse(`The server answered from ${range.start} and not from ${from}`)
      }
      if (range.end < range.start || range.end >= range.total) {
        return refuse('The server’s Content-Range is not a range of the file')
      }
      total = range.total
      end = range.end
    } else {
      if (from !== 0) return refuse(`The server ignored the byte range and sent the file from 0`)
      const length = parseDigits(response.headers.get('Content-Length'))
      if (length === null) return refuse('The server did not say how long the file is')
      total = length
      end = length - 1
    }
    if (fileSize !== null && total !== fileSize) {
      return refuse(`The server’s file is ${total} bytes and the play’s is ${fileSize}`)
    }

    // What is read is what was asked for: a server may send less, but not more.
    const length = Math.min(end, to ?? end) - from + 1
    if (length <= 0) {
      dismiss(response.body)
      return { total, body: emptyBody() }
    }
    if (response.body === null) {
      throw new ReadError(`The server answered ${status} for ${asked} with no body.`, {
        fatal: false,
        status,
      })
    }
    const reader = response.body.getReader()
    owned = true
    return { total, body: readBody(reader, length, signal, asked, status, link) }
  } finally {
    if (!owned) link.release()
  }
}
