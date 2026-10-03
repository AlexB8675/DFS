import { create } from 'zustand'

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'canceled'

export interface UploadItem {
  id: string
  file: File
  /** Folder the file is uploaded into. */
  parentId: string
  status: UploadStatus
  uploadedBytes: number
  /** Server-side upload session, once created. */
  uploadId: string | null
  error: string | null
}

interface UploadState {
  items: UploadItem[]
  collapsed: boolean
  add: (items: UploadItem[]) => void
  update: (id: string, changes: Partial<UploadItem>) => void
  /** Drops finished, failed and canceled items; hides the panel once nothing is left. */
  clearFinished: () => void
  setCollapsed: (collapsed: boolean) => void
}

export const useUploadStore = create<UploadState>()((set) => ({
  items: [],
  collapsed: false,
  add: (items) => {
    set((state) => ({ items: [...state.items, ...items], collapsed: false }))
  },
  update: (id, changes) => {
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    }))
  },
  clearFinished: () => {
    set((state) => ({ items: state.items.filter((item) => isActive(item.status)) }))
  },
  setCollapsed: (collapsed) => {
    set({ collapsed })
  },
}))

export function isActive(status: UploadStatus): boolean {
  return status === 'queued' || status === 'uploading'
}

export interface UploadSummary {
  total: number
  active: number
  done: number
  failed: number
  /** 0–1 across all files that are not canceled. */
  progress: number
}

export function summarize(items: readonly UploadItem[]): UploadSummary {
  let totalBytes = 0
  let uploadedBytes = 0
  let active = 0
  let done = 0
  let failed = 0
  for (const item of items) {
    if (item.status === 'canceled') continue
    totalBytes += item.file.size
    uploadedBytes += item.uploadedBytes
    if (isActive(item.status)) active += 1
    if (item.status === 'done') done += 1
    if (item.status === 'failed') failed += 1
  }
  const progress = totalBytes === 0 ? (active === 0 ? 1 : 0) : uploadedBytes / totalBytes
  return { total: items.length, active, done, failed, progress }
}
