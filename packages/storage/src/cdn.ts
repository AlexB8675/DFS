import { setTimeout } from 'node:timers/promises'
import { BlobStoreError, type CdnUrl, type StoredBlob } from './blob-store.ts'
import type { DiscordRest } from './discord.ts'

// Reading blobs back from Discord's CDN (DESIGN.md §6.2). Attachment URLs are
// signed and expire after about a day (§2), so the database keeps the
// message and attachment IDs and gets the URL signed again when needed.

/** A URL this close to expiring is signed again before use. */
const FRESH_FOR_MS = 60_000
/** Discord signs at most this many URLs per request. */
const REFRESH_BATCH = 50
const CDN_TIMEOUT_MS = 60_000
/** However long a 429 asks for, requests wait at most this, then try again. */
const MAX_PAUSE_MS = 60_000
/** A request the CDN refuses with 429 is sent again this many times. */
const CDN_RETRIES = 3

/**
 * One process's way of minding Discord's CDN, whose limits are unpublished
 * and count by address (§6.2). Once it answers 429, every request of the
 * process waits as long as it asked, at most a minute, or, when it didn't
 * say, a while that doubles with each 429 in a row; the refused request is
 * then sent again. A request that goes through starts the doubling over.
 */
export class CdnGate {
  #until = 0
  #strikes = 0
  readonly #onSlowDown: ((pauseMs: number) => void) | undefined
  readonly #onWait: ((waitMs: number) => void) | undefined

  constructor(
    options: { onSlowDown?: (pauseMs: number) => void; onWait?: (waitMs: number) => void } = {},
  ) {
    this.#onSlowDown = options.onSlowDown
    this.#onWait = options.onWait
  }

  /** How long requests have still to wait. */
  get closedForMs(): number {
    return Math.max(0, this.#until - Date.now())
  }

  /** Waits while the gate is closed; one given up on (`signal`) leaves at once. */
  async open(signal?: AbortSignal): Promise<void> {
    const wait = this.closedForMs
    if (wait <= 0) return
    this.#onWait?.(wait)
    await setTimeout(wait, undefined, { signal })
  }

  /** The CDN answered 429: close the gate for everyone, as long as it asked. */
  slowDown(retryAfter: string | null): void {
    const pause = Math.min(MAX_PAUSE_MS, retryAfterMs(retryAfter) ?? 1000 * 2 ** this.#strikes)
    this.#strikes += 1
    this.#until = Math.max(this.#until, Date.now() + pause)
    this.#onSlowDown?.(pause)
  }

  passed(): void {
    this.#strikes = 0
  }
}

/** The CDN refused the URL: it expired, or the attachment is gone. */
export class CdnRefusedError extends BlobStoreError {
  constructor(status: number) {
    super(`The Discord CDN answered ${String(status)}.`, { retryable: false })
    this.name = 'CdnRefusedError'
  }
}

/** A signed URL with its expiry, from its `ex` parameter (hex Unix seconds); `null` if unsigned. */
export function cdnUrl(url: string): CdnUrl | null {
  const expires = new URL(url).searchParams.get('ex')
  if (!expires || !/^[0-9a-f]{1,12}$/i.test(expires)) return null
  return { url, expiresAt: new Date(Number.parseInt(expires, 16) * 1000) }
}

export function isFresh(url: CdnUrl | null | undefined, now = Date.now()): url is CdnUrl {
  return !!url && url.expiresAt.getTime() - now > FRESH_FOR_MS
}

/** An attachment's URL without a signature, which Discord can sign again. */
export function attachmentUrl(
  discordChannelId: string,
  attachmentId: string,
  filename: string,
): string {
  return `https://cdn.discordapp.com/attachments/${discordChannelId}/${attachmentId}/${filename}`
}

/** The file name a blob's attachment has (DESIGN.md §4). */
export function blobFilename(blobId: number): string {
  return `${String(blobId)}.bin`
}

/**
 * Signs attachment URLs again, 50 per request. The answer is keyed by the
 * unsigned URL; one Discord didn't sign (its message is gone) is left out.
 */
export async function refreshCdnUrls(
  rest: DiscordRest,
  urls: readonly string[],
): Promise<Map<string, CdnUrl>> {
  const signed = new Map<string, CdnUrl>()
  for (let from = 0; from < urls.length; from += REFRESH_BATCH) {
    const answer = (await rest.post('/attachments/refresh-urls', {
      body: { attachment_urls: urls.slice(from, from + REFRESH_BATCH) },
    })) as { refreshed_urls?: { original: string; refreshed: string }[] }
    for (const { original, refreshed } of answer.refreshed_urls ?? []) {
      const url = cdnUrl(refreshed)
      if (url) signed.set(unsigned(original), url)
    }
  }
  return signed
}

/**
 * Reads part of a blob from the CDN with the URL it comes with, or with a
 * newly signed one when it has none, it is about to expire, or the CDN
 * refuses it. `sign` returns `null` when the attachment is gone.
 */
export async function readBlobFromCdn(
  fetcher: typeof fetch,
  blob: StoredBlob,
  offset: number,
  length: number,
  sign: (blob: StoredBlob) => Promise<CdnUrl | null>,
  signal?: AbortSignal,
  gate?: CdnGate,
): Promise<Uint8Array> {
  const known = isFresh(blob.url) ? blob.url : null
  const url = known ?? (await sign(blob))
  try {
    if (!url) throw new CdnRefusedError(404)
    return await readCdnRange(fetcher, url.url, offset, length, signal, gate)
  } catch (error) {
    if (!(error instanceof CdnRefusedError)) throw error
    // A URL from the database may have been revoked; a newly signed one wasn't.
    const again = known ? await sign(blob) : null
    if (again) {
      try {
        return await readCdnRange(fetcher, again.url, offset, length, signal, gate)
      } catch (retry) {
        if (!(retry instanceof CdnRefusedError)) throw retry
      }
    }
    throw new BlobStoreError(`Blob ${String(blob.id)} is gone from Discord.`, {
      retryable: false,
      cause: error,
    })
  }
}

/**
 * `readBlobFromCdn`'s bytes as they arrive (§6.2). The URL is signed again
 * if the CDN refuses it before any byte, as there. Fewer bytes than asked
 * for fail the stream, so a range cut short is never taken for a whole one.
 */
export async function* streamBlobFromCdn(
  fetcher: typeof fetch,
  blob: StoredBlob,
  offset: number,
  length: number,
  sign: (blob: StoredBlob) => Promise<CdnUrl | null>,
  signal?: AbortSignal,
  gate?: CdnGate,
): AsyncGenerator<Uint8Array, void, undefined> {
  const known = isFresh(blob.url) ? blob.url : null
  const open = async (url: CdnUrl | null): Promise<Response | null> => {
    if (!url) return null
    try {
      return await openCdnRange(fetcher, url.url, offset, length, signal, gate)
    } catch (error) {
      if (error instanceof CdnRefusedError) return null
      throw error
    }
  }
  // A URL from the database may have been revoked; a newly signed one wasn't.
  const response =
    (await open(known ?? (await sign(blob)))) ?? (known ? await open(await sign(blob)) : null)
  if (!response) {
    throw new BlobStoreError(`Blob ${String(blob.id)} is gone from Discord.`, { retryable: false })
  }
  const body = response.body?.getReader()
  if (!body) throw new BlobStoreError('The Discord CDN sent no body.', { retryable: true })
  // A CDN that sent the whole file has the bytes before `offset` skipped.
  let skip = response.status === 200 ? offset : 0
  let left = length
  try {
    while (left > 0) {
      let next: Awaited<ReturnType<typeof body.read>>
      try {
        next = await body.read()
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw new BlobStoreError('Reading from the Discord CDN failed.', {
          retryable: true,
          cause: error,
        })
      }
      if (next.done) {
        throw new BlobStoreError('The Discord CDN sent fewer bytes than asked for.', {
          retryable: true,
        })
      }
      let piece = next.value as Uint8Array
      if (skip > 0) {
        const skipped = Math.min(skip, piece.length)
        skip -= skipped
        piece = piece.subarray(skipped)
      }
      if (piece.length === 0) continue
      if (piece.length > left) piece = piece.subarray(0, left)
      left -= piece.length
      yield piece
    }
  } finally {
    // Stopped early, or done: let the rest of the response go.
    void body.cancel().catch(() => undefined)
  }
}

/**
 * Sends a Range request through the gate: it waits while the gate is
 * closed, and a 429 closes it for everyone and is sent again, a few times.
 * The request's minute runs from when it is sent, not from when it began
 * waiting.
 */
async function rangeRequest(
  fetcher: typeof fetch,
  url: string,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
  gate: CdnGate | undefined,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response
    try {
      if (gate && gate.closedForMs > 0) await gate.open(signal)
      // Given up on while it waited: it isn't sent at all.
      signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(CDN_TIMEOUT_MS)
      response = await fetcher(url, {
        headers: { Range: `bytes=${String(offset)}-${String(offset + length - 1)}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (error) {
      // Given up on by its reader: not the CDN's failure, and nothing to retry.
      if (signal?.aborted) throw signal.reason
      throw new BlobStoreError('Reading from the Discord CDN failed.', {
        retryable: true,
        cause: error,
      })
    }
    if (response.status !== 429 || !gate) {
      gate?.passed()
      return response
    }
    await response.body?.cancel()
    gate.slowDown(response.headers.get('retry-after'))
    if (attempt >= CDN_RETRIES) {
      throw new BlobStoreError('The Discord CDN asked to slow down, and kept asking.', {
        retryable: true,
        retryAfterMs: gate.closedForMs,
      })
    }
  }
}

/** Starts a Range request and checks its answer before any of its body is used. */
async function openCdnRange(
  fetcher: typeof fetch,
  url: string,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
  gate: CdnGate | undefined,
): Promise<Response> {
  const response = await rangeRequest(fetcher, url, offset, length, signal, gate)
  if (response.status === 206) {
    const range = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')
    if (range && Number(range[1]) === offset) return response
    await response.body?.cancel()
    throw new BlobStoreError('The Discord CDN sent a different range than asked for.', {
      retryable: true,
    })
  }
  if (response.status === 200) return response
  await response.body?.cancel()
  if (response.status === 403 || response.status === 404) throw new CdnRefusedError(response.status)
  throw new BlobStoreError(`The Discord CDN answered ${String(response.status)}.`, {
    retryable: response.status === 429 || response.status >= 500,
    retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
  })
}

/**
 * Reads `length` bytes at `offset` with an HTTP Range request, so a frame
 * out of a 20 MiB pack moves only its own bytes. If the CDN ignores the
 * range and sends the whole file, the frame is cut out of it. Once `signal`
 * aborts, the request stops and rejects with its reason.
 */
export async function readCdnRange(
  fetcher: typeof fetch,
  url: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
  gate?: CdnGate,
): Promise<Uint8Array> {
  let response: Response
  let bytes: Uint8Array
  try {
    response = await rangeRequest(fetcher, url, offset, length, signal, gate)
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel()
      if (response.status === 403 || response.status === 404) {
        throw new CdnRefusedError(response.status)
      }
      throw new BlobStoreError(`The Discord CDN answered ${String(response.status)}.`, {
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      })
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    // Given up on by its reader: not the CDN's failure, and nothing to retry.
    if (signal?.aborted) throw signal.reason
    if (error instanceof BlobStoreError) throw error
    throw new BlobStoreError('Reading from the Discord CDN failed.', {
      retryable: true,
      cause: error,
    })
  }
  if (response.status === 206) {
    const range = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')
    if (range && Number(range[1]) === offset && bytes.length === length) return bytes
    throw new BlobStoreError('The Discord CDN sent a different range than asked for.', {
      retryable: true,
    })
  }
  if (bytes.length < offset + length) {
    throw new BlobStoreError('The blob on the Discord CDN is shorter than recorded.', {
      retryable: false,
    })
  }
  return bytes.subarray(offset, offset + length)
}

function unsigned(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

/** `Retry-After` in milliseconds: seconds (`1.5`) or a date; `null` without one. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}
