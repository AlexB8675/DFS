import type { SyncState } from '@dfs/shared'
import { describe, expect, it, vi } from 'vitest'
import { createUploadStore, summarize, type UploadItem, type UploadStatus } from './upload-store'

function item(
  status: UploadStatus,
  size: number,
  uploadedBytes: number,
  syncState: SyncState | null = null,
): UploadItem {
  return {
    id: crypto.randomUUID(),
    file: new File([new Uint8Array(size)], 'file.bin'),
    parentId: 'folder',
    status,
    uploadedBytes,
    nodeId: null,
    syncState,
    retrying: false,
    pausedUntil: null,
    error: null,
  }
}

describe('summarize', () => {
  it('counts statuses and weighs progress by bytes', () => {
    const summary = summarize([
      item('uploading', 100, 50),
      item('queued', 100, 0),
      item('paused', 100, 20),
      item('done', 200, 200),
      item('failed', 100, 30),
    ])
    expect(summary).toMatchObject({ total: 5, active: 2, paused: 1, done: 1, failed: 1 })
    expect(summary.progress).toBeCloseTo(300 / 600)
    // Only unfinished uploads count toward the time left.
    expect(summary.remainingBytes).toBe(50 + 100 + 80)
  })

  it('counts uploads that still have to reach Discord', () => {
    const summary = summarize([
      item('done', 10, 10, 'syncing'),
      item('done', 10, 10, 'stored'),
      // A sync that failed is over too; the panel shows the problem instead.
      item('done', 10, 10, 'lost'),
    ])
    expect(summary).toMatchObject({ done: 3, syncing: 1 })
  })

  it('leaves canceled uploads out of the progress', () => {
    const summary = summarize([item('done', 100, 100), item('canceled', 900, 10)])
    expect(summary.progress).toBe(1)
  })

  it('treats a batch of empty files as complete once nothing is pending', () => {
    expect(summarize([item('done', 0, 0)]).progress).toBe(1)
    expect(summarize([item('queued', 0, 0)]).progress).toBe(0)
  })
})

describe('upload store', () => {
  it('keeps totals correct through progress, pause, retry, completion, sync and cancellation', () => {
    const store = createUploadStore()
    const uploads = [item('queued', 100, 0), item('done', 200, 200), item('queued', 0, 0)]
    store.getState().add(uploads)
    const first = uploads[0]
    const empty = uploads[2]
    if (!first || !empty) throw new Error('Missing test upload.')
    const check = () => {
      const state = store.getState()
      expect(state.summary).toEqual(summarize(state.items.map((entry) => entry.store.getState())))
    }
    check()
    for (const change of [
      { status: 'uploading' as const, uploadedBytes: 40 },
      { status: 'paused' as const },
      { status: 'failed' as const },
      { status: 'queued' as const, uploadedBytes: 0 },
      { status: 'done' as const, uploadedBytes: 100, syncState: 'syncing' as const },
      { syncState: 'stored' as const },
      { syncState: 'lost' as const },
      { status: 'canceled' as const },
    ]) {
      store.getState().apply(new Map([[first.id, change]]), 100)
      check()
    }
    store.getState().apply(new Map([[empty.id, { status: 'done' }]]), 0)
    check()
    store.getState().remove(new Set(uploads.map((upload) => upload.id)))
    check()
    expect(store.getState().summary).toMatchObject({ total: 0, remainingBytes: 0, progress: 1 })
  })

  it('publishes only the changed row and preserves the queue across progress updates', () => {
    const store = createUploadStore()
    store.getState().add([item('queued', 100, 0), item('queued', 100, 0)])
    const queue = store.getState().items
    const [first, second] = queue
    if (!first || !second) throw new Error('Missing test uploads.')
    const changed = vi.fn()
    const untouched = vi.fn()
    first.store.subscribe(changed)
    second.store.subscribe(untouched)
    const secondSnapshot = second.store.getState()
    store.getState().apply(new Map([[first.id, { uploadedBytes: 25 }]]), 25)
    expect(changed).toHaveBeenCalledOnce()
    expect(untouched).not.toHaveBeenCalled()
    expect(second.store.getState()).toBe(secondSnapshot)
    expect(store.getState().items).toBe(queue)
    const summary = store.getState().summary
    store.getState().apply(new Map([[first.id, { uploadedBytes: 25 }]]), 0)
    expect(changed).toHaveBeenCalledOnce()
    expect(store.getState().summary).toBe(summary)
    expect(store.getState().bytesPerSecond).toBe(0)
  })

  it('does not inspect untouched files when a large queue receives progress', () => {
    const store = createUploadStore()
    const uploads = Array.from({ length: 10_000 }, () => item('queued', 1, 0))
    store.getState().add(uploads)
    const first = uploads[0]
    const last = uploads.at(-1)
    if (!first || !last) throw new Error('Missing test uploads.')
    const size = vi.spyOn(last.file, 'size', 'get')
    store.getState().apply(new Map([[first.id, { uploadedBytes: 1 }]]), 1)
    expect(size).not.toHaveBeenCalled()
    expect(store.getState().summary.progress).toBe(1 / 10_000)
  })

  it('ignores late updates to removed rows and can reuse their IDs', () => {
    const store = createUploadStore()
    const upload = item('queued', 100, 0)
    store.getState().add([upload, upload])
    expect(store.getState().items).toHaveLength(1)
    store.getState().remove(new Set([upload.id]))
    store.getState().apply(new Map([[upload.id, { status: 'done', uploadedBytes: 100 }]]), 0)
    expect(store.getState().summary.total).toBe(0)
    store.getState().add([upload])
    expect(store.getState().summary).toMatchObject({ active: 1, progress: 0 })
  })
})
