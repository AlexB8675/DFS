// pg-boss queues shared by the API and the bot (DESIGN.md §11). Both create
// them at start; creating one that exists changes nothing.

export const QUEUES = {
  /** Store a staged blob (solo frame or sealed pack) in the blob store. */
  blobUpload: 'blob.upload',
} as const

export interface BlobUploadJob {
  blobId: number
}

/**
 * Retries with backoff: about 10 tries over a few hours. New jobs NOTIFY,
 * so the bot starts on them at once instead of at its next poll.
 */
export const BLOB_UPLOAD_QUEUE = {
  retryLimit: 10,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 30 * 60,
  notify: true,
} as const
