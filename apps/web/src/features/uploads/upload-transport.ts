import {
  ensureFoldersResultSchema,
  nodeSchema,
  uploadBatchResultSchema,
  uploadStatusSchema,
  type CreateUploadInput,
  type DriveNode,
  type UploadBatchResult,
  type UploadSessionStatus,
} from '@dfs/shared'
import { ApiError, apiFetch, apiGet, apiSend } from '@/lib/api/client'

/**
 * The upload API calls (§6.1), behind an interface so the upload engine can
 * be tested without a network.
 */
export interface UploadTransport {
  ensureFolders: (parentId: string, paths: string[]) => Promise<Record<string, string>>
  /** Up to 500 sessions per call, answered per upload. */
  createSessions: (uploads: CreateUploadInput[]) => Promise<UploadBatchResult['results']>
  putPart: (
    uploadId: string,
    index: number,
    body: ArrayBuffer,
    sha256: string,
    signal: AbortSignal,
  ) => Promise<void>
  complete: (uploadId: string) => Promise<void>
  /** The parts the server already has, to resume. */
  status: (uploadId: string) => Promise<UploadSessionStatus>
  cancel: (uploadId: string) => Promise<void>
  /** The node, or `null` if it doesn't exist (any more). */
  node: (nodeId: string) => Promise<DriveNode | null>
}

export const httpTransport: UploadTransport = {
  ensureFolders: (parentId, paths) =>
    apiSend('POST', '/folders/ensure', { parentId, paths }, ensureFoldersResultSchema),
  createSessions: async (uploads) =>
    (await apiSend('POST', '/uploads/batch', { uploads }, uploadBatchResultSchema)).results,
  putPart: async (uploadId, index, body, sha256, signal) => {
    await apiFetch(`/uploads/${uploadId}/parts/${index}`, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': sha256 },
      signal,
    })
  },
  complete: (uploadId) => apiSend('POST', `/uploads/${uploadId}/complete`),
  status: (uploadId) => apiGet(`/uploads/${uploadId}`, uploadStatusSchema),
  cancel: (uploadId) => apiSend('DELETE', `/uploads/${uploadId}`),
  node: async (nodeId) => {
    try {
      return await apiGet(`/nodes/${nodeId}`, nodeSchema)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  },
}
