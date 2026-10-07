// pg-boss queues shared by the API and the bot (DESIGN.md §11). Both create
// them at start; creating one that exists changes nothing.

export const QUEUES = {
  /** Store a staged blob (solo frame or sealed pack) in the blob store. */
  blobUpload: 'blob.upload',
  /** Something an admin asked the leading bot to do now (`POST /admin/tasks`). */
  adminTask: 'admin.task',
} as const

export interface BlobUploadJob {
  blobId: number
}

/** An admin task: what it is, and who asked. */
export interface AdminTaskJob {
  kind: string
  requestedBy: string
}

/**
 * Admin tasks run once, one at a time, as soon as the leader takes them. One
 * that waits 10 minutes (no leader) is dropped, so a channel never appears
 * hours after someone asked for it.
 */
export const ADMIN_TASK_QUEUE = {
  retryLimit: 0,
  retentionSeconds: 600,
  expireInSeconds: 15 * 60,
  notify: true,
} as const

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
