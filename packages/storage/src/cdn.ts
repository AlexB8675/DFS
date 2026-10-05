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
): Promise<Uint8Array> {
  const known = isFresh(blob.url) ? blob.url : null
  const url = known ?? (await sign(blob))
  try {
    if (!url) throw new CdnRefusedError(404)
    return await readCdnRange(fetcher, url.url, offset, length)
  } catch (error) {
    if (!(error instanceof CdnRefusedError)) throw error
    // A URL from the database may have been revoked; a newly signed one wasn't.
    const again = known ? await sign(blob) : null
    if (again) {
      try {
        return await readCdnRange(fetcher, again.url, offset, length)
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
 * Reads `length` bytes at `offset` with an HTTP Range request, so a frame
 * out of a 10 MiB pack moves only its own bytes. If the CDN ignores the
 * range and sends the whole file, the frame is cut out of it.
 */
export async function readCdnRange(
  fetcher: typeof fetch,
  url: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  let response: Response
  let bytes: Uint8Array
  try {
    response = await fetcher(url, {
      headers: { Range: `bytes=${String(offset)}-${String(offset + length - 1)}` },
      signal: AbortSignal.timeout(CDN_TIMEOUT_MS),
    })
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

function retryAfterMs(header: string | null): number | null {
  const seconds = Number(header)
  return header && Number.isFinite(seconds) ? seconds * 1000 : null
}
