import {
  ensureFoldersResultSchema,
  nodeListSchema,
  uploadBatchResultSchema,
  uploadStatusSchema,
  type CreateUploadInput,
  type DriveNode,
  type UploadBatchResult,
  type UploadSessionStatus,
} from '@dfs/shared'
import { apiFetch, apiGet, apiSend, apiUpload } from '@/lib/api/client'

/** Told how many bytes of a request's body have gone out so far. */
export type OnProgress = (sentBytes: number) => void

/**
 * The upload API calls (§6.1), behind an interface so the upload engine can
 * be tested without a network.
 */
export interface UploadTransport {
  ensureFolders: (parentId: string, paths: string[]) => Promise<Record<string, string>>
  /** Up to 500 sessions per call, answered per upload. */
  createSessions: (uploads: CreateUploadInput[]) => Promise<UploadBatchResult['results']>
  /** One part with its SHA-256: a small file's only request, which completes it. */
  putPart: (
    uploadId: string,
    index: number,
    body: ArrayBuffer,
    sha256: string,
    signal: AbortSignal,
    onProgress?: OnProgress,
  ) => Promise<void>
  /** A larger file in one request: every part from `from` to its end (`body`). */
  streamFile: (
    uploadId: string,
    from: number,
    body: Blob,
    signal: AbortSignal,
    onProgress?: OnProgress,
  ) => Promise<void>
  /** With every part's SHA-256 for a streamed file, which the server checks. */
  complete: (uploadId: string, partSha256?: string[]) => Promise<void>
  /** The parts the server already has, to resume. */
  status: (uploadId: string) => Promise<UploadSessionStatus>
  /** With `keepalive`, the request outlives the page that sends it. */
  cancel: (uploadId: string, options?: { keepalive?: boolean }) => Promise<void>
  /** The visible ones of these nodes, up to 500; any that are gone are left out. */
  nodes: (nodeIds: string[]) => Promise<DriveNode[]>
}

export const httpTransport: UploadTransport = {
  ensureFolders: (parentId, paths) =>
    apiSend('POST', '/folders/ensure', { parentId, paths }, ensureFoldersResultSchema),
  createSessions: async (uploads) =>
    (await apiSend('POST', '/uploads/batch', { uploads }, uploadBatchResultSchema)).results,
  putPart: (uploadId, index, body, sha256, signal, onProgress) =>
    apiUpload(`/uploads/${uploadId}/parts/${String(index)}`, body, {
      headers: { 'X-Part-SHA256': sha256 },
      signal,
      onProgress,
    }),
  streamFile: (uploadId, from, body, signal, onProgress) =>
    apiUpload(`/uploads/${uploadId}/content`, body, { query: { from }, signal, onProgress }),
  complete: (uploadId, partSha256) =>
    apiSend('POST', `/uploads/${uploadId}/complete`, partSha256 && { partSha256 }),
  status: (uploadId) => apiGet(`/uploads/${uploadId}`, uploadStatusSchema),
  cancel: async (uploadId, options) => {
    await apiFetch(`/uploads/${uploadId}`, { method: 'DELETE', keepalive: options?.keepalive })
  },
  nodes: async (nodeIds) =>
    (await apiSend('POST', '/nodes/lookup', { ids: nodeIds }, nodeListSchema)).items,
}
