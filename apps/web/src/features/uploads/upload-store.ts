import type { SyncState } from '@dfs/shared'
import { create } from 'zustand'

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'failed' | 'canceled'

/** One file in the upload panel. The upload engine owns the real state and publishes it here. */
export interface UploadItem {
  id: string
  file: File
  /** Folder the file is uploaded into. */
  parentId: string
  status: UploadStatus
  uploadedBytes: number
  /** The file's node, once the server created its upload session. */
  nodeId: string | null
  /**
   * For uploaded files: the second phase, from live events. `syncing` until
   * the file is on Discord (`stored`), or `failed`/`lost` if it can't get there.
   */
  syncState: SyncState | null
  /** Set while a failed request waits out its backoff. */
  retrying: boolean
  error: string | null
}

interface UploadState {
  items: UploadItem[]
  /** Recent upload speed, for the time-left estimate. */
  bytesPerSecond: number
  collapsed: boolean
  add: (items: UploadItem[]) => void
  /** Applies a batch of changes from the engine in one render. */
  apply: (changes: ReadonlyMap<string, Partial<UploadItem>>, bytesPerSecond: number) => void
  remove: (ids: ReadonlySet<string>) => void
  setCollapsed: (collapsed: boolean) => void
}

export const useUploadStore = create<UploadState>()((set) => ({
  items: [],
  bytesPerSecond: 0,
  collapsed: false,
  add: (items) => {
    set((state) => ({ items: [...state.items, ...items], collapsed: false }))
  },
  apply: (changes, bytesPerSecond) => {
    set((state) => ({
      bytesPerSecond,
      items:
        changes.size === 0
          ? state.items
          : state.items.map((item) => {
              const change = changes.get(item.id)
              return change ? { ...item, ...change } : item
            }),
    }))
  },
  remove: (ids) => {
    set((state) => ({ items: state.items.filter((item) => !ids.has(item.id)) }))
  },
  setCollapsed: (collapsed) => {
    set({ collapsed })
  },
}))

/** Waiting or sending. */
export function isActive(status: UploadStatus): boolean {
  return status === 'queued' || status === 'uploading'
}

/** Not finished yet, including paused uploads. */
export function isPending(status: UploadStatus): boolean {
  return isActive(status) || status === 'paused'
}

/** Whether the second phase is over, one way or the other. */
export function isSettled(syncState: SyncState | null): boolean {
  return syncState === 'stored' || syncState === 'failed' || syncState === 'lost'
}

export interface UploadSummary {
  total: number
  active: number
  paused: number
  done: number
  /** Uploaded, still on their way to Discord. */
  syncing: number
  failed: number
  /** 0–1 across all files that are not canceled. */
  progress: number
  /** Bytes still to send by unfinished uploads, for the time-left estimate. */
  remainingBytes: number
}

export function summarize(items: readonly UploadItem[]): UploadSummary {
  let totalBytes = 0
  let uploadedBytes = 0
  let active = 0
  let paused = 0
  let done = 0
  let syncing = 0
  let failed = 0
  let remainingBytes = 0
  for (const item of items) {
    if (item.status === 'canceled') continue
    totalBytes += item.file.size
    uploadedBytes += item.uploadedBytes
    if (isActive(item.status)) active += 1
    if (item.status === 'paused') paused += 1
    if (item.status === 'done') {
      done += 1
      if (!isSettled(item.syncState)) syncing += 1
    }
    if (item.status === 'failed') failed += 1
    if (isPending(item.status)) remainingBytes += item.file.size - item.uploadedBytes
  }
  const pending = active + paused
  const progress = totalBytes === 0 ? (pending === 0 ? 1 : 0) : uploadedBytes / totalBytes
  return {
    total: items.length,
    active,
    paused,
    done,
    syncing,
    failed,
    progress,
    remainingBytes,
  }
}
