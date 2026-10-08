// Where blobs live (DESIGN.md §14). The file system logic only sees this
// interface, so development and tests run on `LocalBlobStore` (and
// `ChaosBlobStore` for faults) while production stores in Discord.

/** What a store needs to find a blob again. A local store only needs its ID. */
export interface BlobLocation {
  /** `storage_channels.id` of the Discord channel. */
  channelId: string | null
  messageId: string | null
  attachmentId: string | null
}

/** A signed Discord CDN URL, which works until `expiresAt` (about a day, DESIGN.md §2). */
export interface CdnUrl {
  url: string
  expiresAt: Date
}

export interface StoredBlob extends BlobLocation {
  id: number
  /** A URL to read it with, if one is known; it may have expired. */
  url?: CdnUrl | null
}

/** What a store is told about a blob it stores: Discord's message names it (DESIGN.md §4). */
export interface BlobToStore {
  id: number
  kind: 'solo' | 'pack'
  frameCount: number
}

export interface PutResult {
  location: BlobLocation
  /** Where to read it until the URL expires; `null` for a local store. */
  url: CdnUrl | null
}

export interface BlobReader {
  /**
   * Reads `length` bytes from `offset`: one frame out of a pack, or a whole
   * solo blob. Once `signal` aborts, a read still under way gives up with its
   * reason, which is no failure of the store.
   */
  read: (
    blob: StoredBlob,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>
  /**
   * Fresh signed URLs, by blob ID, for a store read through a CDN, so a
   * reader can sign a whole batch at once. A blob that is gone gets none.
   */
  signUrls?: (blobs: readonly StoredBlob[]) => Promise<Map<number, CdnUrl>>
}

export interface BlobStore extends BlobReader {
  /**
   * Stores a sealed blob, durably, and says where it went. `read` gives its
   * bytes; a store calls it only once it can send them, so blobs waiting for
   * their turn don't sit in memory.
   */
  put: (blob: BlobToStore, read: () => Promise<Uint8Array>) => Promise<PutResult>
  /** Removes a blob. Removing one that is already gone is not an error. */
  delete: (blob: StoredBlob) => Promise<void>
}

export class BlobStoreError extends Error {
  /** Whether trying again later may succeed (rate limits, timeouts, server errors). */
  readonly retryable: boolean
  /** How long the store asked to wait, if it said. */
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    options: { retryable: boolean; retryAfterMs?: number | null; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'BlobStoreError'
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}
