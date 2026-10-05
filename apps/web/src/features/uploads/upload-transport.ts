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
import { apiFetch, apiGet, apiSend } from '@/lib/api/client'

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
  /** The visible ones of these nodes, up to 500; any that are gone are left out. */
  nodes: (nodeIds: string[]) => Promise<DriveNode[]>
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
  nodes: async (nodeIds) =>
    (await apiSend('POST', '/nodes/lookup', { ids: nodeIds }, nodeListSchema)).items,
}
