import type { SyncState } from '@dfs/shared'
import { create } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'done'
  | 'failed'
  | 'canceled'
  /** Its name is a file's in its folder: it waits for its user to choose (D20). */
  | 'conflict'

/** The file an upload's name matched, and what the dialog offers as the copy's name. */
export interface UploadConflict {
  /** How many versions the file has had. */
  versions: number
  /** Working share links to its current version, which keep serving it if it is replaced. */
  links: number
  suggestedName: string
}

/** One file in the upload panel. The upload engine owns the real state and publishes it here. */
export interface UploadItem {
  id: string
  file: File
  /** Folder the file is uploaded into. */
  parentId: string
  /** The name it is uploaded under: the file's own, or the one chosen for a copy. */
  name: string
  status: UploadStatus
  /** While `conflict`: the file its name matched. */
  conflict: UploadConflict | null
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
  /** While paused: when the upload is cancelled if still paused (epoch ms). */
  pausedUntil: number | null
  /** Why it failed, or why it was canceled when the user didn't cancel it. */
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
  /** Uploads waiting for their user to choose, in the order they came. */
  conflicts: string[]
  /** Recent upload speed, for the time-left estimate. */
  bytesPerSecond: number
  /** Whether the panel shows; closed, the header's button brings it back. */
  open: boolean
  collapsed: boolean
  add: (items: UploadItem[]) => void
  /** Applies a batch of changes from the engine in one render. */
  apply: (changes: ReadonlyMap<string, Partial<UploadItem>>, bytesPerSecond: number) => void
  remove: (ids: ReadonlySet<string>) => void
  setOpen: (open: boolean) => void
  setCollapsed: (collapsed: boolean) => void
}

/** Progress costs O(changed uploads), independent of the size of the queue. */
export function createUploadStore() {
  const entries = new Map<string, UploadEntry>()
  const conflicts = new Set<string>()
  const totals: UploadTotals = {
    totalBytes: 0,
    uploadedBytes: 0,
    active: 0,
    paused: 0,
    conflicts: 0,
    done: 0,
    syncing: 0,
    failed: 0,
    remainingBytes: 0,
  }
  const summary = (): UploadSummary => ({
    total: entries.size,
    active: totals.active,
    paused: totals.paused,
    conflicts: totals.conflicts,
    done: totals.done,
    syncing: totals.syncing,
    failed: totals.failed,
    progress:
      totals.totalBytes === 0
        ? totals.active + totals.paused + totals.conflicts === 0
          ? 1
          : 0
        : totals.uploadedBytes / totals.totalBytes,
    remainingBytes: totals.remainingBytes,
  })
  return create<UploadState>()((set) => ({
    items: [],
    summary: summary(),
    conflicts: [],
    bytesPerSecond: 0,
    open: false,
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
          open: true,
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
        const next = entry.store.getState()
        adjust(totals, next, 1)
        if (next.status === 'conflict') conflicts.add(id)
        else conflicts.delete(id)
        changed = true
      }
      set((state) => ({
        bytesPerSecond,
        summary: changed ? summary() : state.summary,
        conflicts: changed ? [...conflicts] : state.conflicts,
      }))
    },
    remove: (ids) => {
      let removed = false
      for (const id of ids) {
        const entry = entries.get(id)
        if (!entry) continue
        adjust(totals, entry.store.getState(), -1)
        entries.delete(id)
        conflicts.delete(id)
        removed = true
      }
      if (removed)
        set((state) => ({
          items: state.items.filter((item) => !ids.has(item.id)),
          summary: summary(),
          conflicts: [...conflicts],
        }))
    },
    setOpen: (open) => {
      set({ open })
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
  conflicts: number
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
  if (item.status === 'conflict') totals.conflicts += direction
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

/** Not finished yet, including paused uploads and those waiting for a choice. */
export function isPending(status: UploadStatus): boolean {
  return isActive(status) || status === 'paused' || status === 'conflict'
}

/** Whether the second phase is over, one way or the other. */
export function isSettled(syncState: SyncState | null): boolean {
  return syncState === 'stored' || syncState === 'failed'
}

export interface UploadSummary {
  total: number
  active: number
  paused: number
  /** Waiting for their user to choose: their names are files' in their folders. */
  conflicts: number
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
  let conflicts = 0
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
    if (item.status === 'conflict') conflicts += 1
    if (item.status === 'done') {
      done += 1
      if (!isSettled(item.syncState)) syncing += 1
    }
    if (item.status === 'failed') failed += 1
    if (isPending(item.status)) remainingBytes += item.file.size - item.uploadedBytes
  }
  const pending = active + paused + conflicts
  const progress = totalBytes === 0 ? (pending === 0 ? 1 : 0) : uploadedBytes / totalBytes
  return {
    total: items.length,
    active,
    paused,
    conflicts,
    done,
    syncing,
    failed,
    progress,
    remainingBytes,
  }
}
