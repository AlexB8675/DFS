// pg-boss queues shared by the API and the bot (DESIGN.md §11). Both create
// them at start; creating one that exists changes nothing.

export const QUEUES = {
  /** Store a staged blob (solo frame or sealed pack) in the blob store. */
  blobUpload: 'blob.upload',
} as const

export interface BlobUploadJob {
  blobId: number
}

/** Retries with backoff: about 10 tries over a few hours, then the dead letter. */
export const BLOB_UPLOAD_QUEUE = {
  retryLimit: 10,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 30 * 60,
} as const
