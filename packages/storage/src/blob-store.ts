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

export interface StoredBlob extends BlobLocation {
  id: number
}

export interface BlobStore {
  /** Stores a sealed blob, durably, and says where it went. */
  put: (id: number, data: Uint8Array) => Promise<BlobLocation>
  /** Reads `length` bytes from `offset`: one frame out of a pack, or a whole solo blob. */
  read: (blob: StoredBlob, offset: number, length: number) => Promise<Uint8Array>
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
