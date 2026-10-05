import type { SyncState } from '@dfs/shared'
import { create } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

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

export interface UploadEntry {
  id: string
  store: StoreApi<UploadItem>
}

interface UploadState {
  /** Stable across progress updates; each row subscribes to its own store. */
  items: UploadEntry[]
  summary: UploadSummary
  /** Recent upload speed, for the time-left estimate. */
  bytesPerSecond: number
  collapsed: boolean
  add: (items: UploadItem[]) => void
  /** Applies a batch of changes from the engine in one render. */
  apply: (changes: ReadonlyMap<string, Partial<UploadItem>>, bytesPerSecond: number) => void
  remove: (ids: ReadonlySet<string>) => void
  setCollapsed: (collapsed: boolean) => void
}

/** Progress costs O(changed uploads), independent of the size of the queue. */
export function createUploadStore() {
  const entries = new Map<string, UploadEntry>()
  const totals: UploadTotals = {
    totalBytes: 0,
    uploadedBytes: 0,
    active: 0,
    paused: 0,
    done: 0,
    syncing: 0,
    failed: 0,
    remainingBytes: 0,
  }
  const summary = (): UploadSummary => ({
    total: entries.size,
    active: totals.active,
    paused: totals.paused,
    done: totals.done,
    syncing: totals.syncing,
    failed: totals.failed,
    progress:
      totals.totalBytes === 0
        ? totals.active + totals.paused === 0
          ? 1
          : 0
        : totals.uploadedBytes / totals.totalBytes,
    remainingBytes: totals.remainingBytes,
  })
  return create<UploadState>()((set) => ({
    items: [],
    summary: summary(),
    bytesPerSecond: 0,
    collapsed: false,
    add: (items) => {
      const added: UploadEntry[] = []
      for (const item of items) {
        if (entries.has(item.id)) continue
        const entry = { id: item.id, store: createStore<UploadItem>(() => item) }
        entries.set(item.id, entry)
        adjust(totals, item, 1)
        added.push(entry)
      }
      if (added.length > 0) {
        set((state) => ({
          items: [...state.items, ...added],
          summary: summary(),
          collapsed: false,
        }))
      }
    },
    apply: (changes, bytesPerSecond) => {
      let changed = false
      for (const [id, change] of changes) {
        const entry = entries.get(id)
        if (!entry) continue
        const previous = entry.store.getState()
        if (
          Object.entries(change).every(
            ([key, value]) => previous[key as keyof UploadItem] === value,
          )
        )
          continue
        adjust(totals, previous, -1)
        entry.store.setState(change)
        adjust(totals, entry.store.getState(), 1)
        changed = true
      }
      set((state) => ({ bytesPerSecond, summary: changed ? summary() : state.summary }))
    },
    remove: (ids) => {
      let removed = false
      for (const id of ids) {
        const entry = entries.get(id)
        if (!entry) continue
        adjust(totals, entry.store.getState(), -1)
        entries.delete(id)
        removed = true
      }
      if (removed)
        set((state) => ({
          items: state.items.filter((item) => !ids.has(item.id)),
          summary: summary(),
        }))
    },
    setCollapsed: (collapsed) => {
      set({ collapsed })
    },
  }))
}

export const useUploadStore = createUploadStore()

interface UploadTotals {
  totalBytes: number
  uploadedBytes: number
  active: number
  paused: number
  done: number
  syncing: number
  failed: number
  remainingBytes: number
}

function adjust(totals: UploadTotals, item: UploadItem, direction: 1 | -1): void {
  if (item.status === 'canceled') return
  totals.totalBytes += direction * item.file.size
  totals.uploadedBytes += direction * item.uploadedBytes
  if (isActive(item.status)) totals.active += direction
  if (item.status === 'paused') totals.paused += direction
  if (item.status === 'done') {
    totals.done += direction
    if (!isSettled(item.syncState)) totals.syncing += direction
  }
  if (item.status === 'failed') totals.failed += direction
  if (isPending(item.status))
    totals.remainingBytes += direction * (item.file.size - item.uploadedBytes)
}

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
