import { ensureFoldersResultSchema, uploadSessionSchema } from '@dfs/shared'
import { invalidateDriveData } from '@/features/drive/api'
import { apiFetch, apiSend, errorMessage } from '@/lib/api/client'
import type { PickedFile } from './picked-files'
import { useUploadStore, type UploadItem } from './upload-store'

// Runs uploads as described in DESIGN.md §6.1: create a session, PUT each
// part with its SHA-256, then complete (single-part uploads complete on their
// own). A few files upload at once; the rest wait in the queue.

const CONCURRENCY = 3
const ENSURE_BATCH = 500
const REFRESH_INTERVAL_MS = 1000

const controllers = new Map<string, AbortController>()

/** Queues files for upload into `parentId`, creating any folders they came from first. */
export async function enqueueUploads(parentId: string, files: PickedFile[]): Promise<void> {
  if (files.length === 0) return
  const folderIds = await ensureFolders(parentId, files)
  useUploadStore.getState().add(
    files.map(({ file, relativeDir }) => ({
      id: crypto.randomUUID(),
      file,
      parentId: folderIds.get(relativeDir) ?? parentId,
      status: 'queued',
      uploadedBytes: 0,
      uploadId: null,
      error: null,
    })),
  )
  scheduleRefresh()
  pump()
}

export function cancelUpload(id: string): void {
  const item = findItem(id)
  if (item?.status === 'queued') useUploadStore.getState().update(id, { status: 'canceled' })
  controllers.get(id)?.abort()
}

export function retryUpload(id: string): void {
  useUploadStore.getState().update(id, { status: 'queued', uploadedBytes: 0, error: null })
  pump()
}

/** `mkdir -p` for every folder in a dropped tree, in one request per 500 paths. */
async function ensureFolders(parentId: string, files: PickedFile[]): Promise<Map<string, string>> {
  const paths = [...new Set(files.map((file) => file.relativeDir).filter(Boolean))]
  const folderIds = new Map<string, string>()
  for (let start = 0; start < paths.length; start += ENSURE_BATCH) {
    const batch = paths.slice(start, start + ENSURE_BATCH)
    const result = await apiSend(
      'POST',
      '/folders/ensure',
      { parentId, paths: batch },
      ensureFoldersResultSchema,
    )
    for (const [path, id] of Object.entries(result)) folderIds.set(path, id)
  }
  return folderIds
}

function pump(): void {
  const { items } = useUploadStore.getState()
  const running = items.filter((item) => item.status === 'uploading').length
  const next = items.filter((item) => item.status === 'queued').slice(0, CONCURRENCY - running)
  for (const item of next) void upload(item)
}

async function upload(item: UploadItem): Promise<void> {
  const { update } = useUploadStore.getState()
  const controller = new AbortController()
  controllers.set(item.id, controller)
  update(item.id, { status: 'uploading', uploadedBytes: 0, error: null })

  let uploadId: string | null = null
  try {
    const session = await apiSend(
      'POST',
      '/uploads',
      {
        parentId: item.parentId,
        name: item.file.name,
        sizeBytes: item.file.size,
        mimeType: item.file.type || 'application/octet-stream',
      },
      uploadSessionSchema,
    )
    uploadId = session.uploadId
    update(item.id, { uploadId })

    for (let index = 0; index < session.chunkCount; index += 1) {
      const start = index * session.chunkSize
      const bytes = await item.file.slice(start, start + session.chunkSize).arrayBuffer()
      await apiFetch(`/uploads/${uploadId}/parts/${index}`, {
        method: 'PUT',
        body: bytes,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Part-SHA256': await sha256Hex(bytes),
        },
        signal: controller.signal,
      })
      update(item.id, { uploadedBytes: Math.min(item.file.size, start + bytes.byteLength) })
    }
    // A single-part upload completes on its own when its part arrives.
    if (session.chunkCount !== 1) await apiSend('POST', `/uploads/${uploadId}/complete`)
    update(item.id, { status: 'done', uploadedBytes: item.file.size })
  } catch (error) {
    // Drop the half-finished upload, so no stuck "uploading" file is left behind
    // and a retry starts clean under the same name.
    if (uploadId) await apiSend('DELETE', `/uploads/${uploadId}`).catch(() => undefined)
    if (controller.signal.aborted) {
      update(item.id, { status: 'canceled' })
    } else {
      update(item.id, { status: 'failed', error: errorMessage(error) })
    }
  } finally {
    controllers.delete(item.id)
    scheduleRefresh()
    pump()
  }
}

let refreshTimer: number | undefined

/** Refreshes the file lists at most once a second while uploads finish. */
function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined
    void invalidateDriveData()
  }, REFRESH_INTERVAL_MS)
}

function findItem(id: string): UploadItem | undefined {
  return useUploadStore.getState().items.find((item) => item.id === id)
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
