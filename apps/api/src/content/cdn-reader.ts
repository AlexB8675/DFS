import type { Metrics } from '@dfs/db'
import { refreshedUrlsSchema } from '@dfs/shared'
import {
  BlobStoreError,
  CdnGate,
  readBlobFromCdn,
  streamBlobFromCdn,
  type BlobReader,
  type CdnUrl,
  type StoredBlob,
} from '@dfs/storage'

// Reading stored blobs from Discord's CDN (DESIGN.md §6.2). Only the bot holds
// the token, so it signs the URLs (`POST /internal/urls/refresh`) and saves
// them; the chunk lookup brings them along until they expire.

/** The bot takes at most this many blobs per request. */
const SIGN_BATCH = 200
const BOT_TIMEOUT_MS = 30_000

export class CdnBlobReader implements BlobReader {
  readonly #botUrl: string
  readonly #secret: string
  readonly #fetch: typeof fetch
  readonly #metrics: Metrics | undefined
  /** The whole API waits together when the CDN asks it to slow down. */
  readonly #gate: CdnGate
  /** Signing in flight, by blob, so readers of the same pack share one request. */
  readonly #signing = new Map<number, Promise<CdnUrl | null>>()

  constructor(options: {
    botUrl: string
    secret: string
    fetch?: typeof fetch
    metrics?: Metrics
  }) {
    this.#botUrl = options.botUrl
    this.#secret = options.secret
    this.#fetch = options.fetch ?? fetch
    this.#metrics = options.metrics
    this.#gate = new CdnGate({ onSlowDown: () => this.#metrics?.record('cdn.429') })
  }

  async read(
    blob: StoredBlob,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      const data = await readBlobFromCdn(
        this.#fetch,
        blob,
        offset,
        length,
        async (unsigned) => {
          const urls = await this.signUrls([unsigned])
          return urls.get(unsigned.id) ?? null
        },
        signal,
        this.#gate,
      )
      this.#metrics?.record('cdn.reads', data.length)
      return data
    } catch (error) {
      // A read its reader gave up on didn't fail.
      if (!signal?.aborted) this.#metrics?.record('cdn.failures')
      throw error
    }
  }

  /** `read`'s bytes as they arrive, counted the same way once done. */
  async *stream(
    blob: StoredBlob,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    let bytes = 0
    try {
      for await (const piece of streamBlobFromCdn(
        this.#fetch,
        blob,
        offset,
        length,
        async (unsigned) => {
          const urls = await this.signUrls([unsigned])
          return urls.get(unsigned.id) ?? null
        },
        signal,
        this.#gate,
      )) {
        bytes += piece.length
        yield piece
      }
      this.#metrics?.record('cdn.reads', bytes)
    } catch (error) {
      // A read its reader gave up on didn't fail.
      if (!signal?.aborted) this.#metrics?.record('cdn.failures')
      throw error
    }
  }

  async signUrls(blobs: readonly StoredBlob[]): Promise<Map<number, CdnUrl>> {
    const pending = new Map<number, Promise<CdnUrl | null>>()
    const missing: number[] = []
    for (const { id } of blobs) {
      const known = this.#signing.get(id)
      if (known) pending.set(id, known)
      else if (!missing.includes(id)) missing.push(id)
    }
    for (let from = 0; from < missing.length; from += SIGN_BATCH) {
      const batch = missing.slice(from, from + SIGN_BATCH)
      const request = this.#ask(batch)
      for (const id of batch) {
        const one = request.then((urls) => urls.get(id) ?? null)
        const forget = () => {
          if (this.#signing.get(id) === one) this.#signing.delete(id)
        }
        one.then(forget, forget)
        this.#signing.set(id, one)
        pending.set(id, one)
      }
    }
    const signed = new Map<number, CdnUrl>()
    for (const [id, url] of pending) {
      const fresh = await url
      if (fresh) signed.set(id, fresh)
    }
    return signed
  }

  async #ask(blobIds: number[]): Promise<Map<number, CdnUrl>> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#botUrl}/internal/urls/refresh`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ blobIds }),
        signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
      })
    } catch (error) {
      throw new BlobStoreError('The bot could not be reached to sign CDN URLs.', {
        retryable: true,
        cause: error,
      })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new BlobStoreError(`The bot answered ${String(response.status)} to signing CDN URLs.`, {
        retryable: true,
      })
    }
    const { urls } = refreshedUrlsSchema.parse(await response.json())
    return new Map(
      urls.map((url) => [url.blobId, { url: url.url, expiresAt: new Date(url.expiresAt) }]),
    )
  }
}
