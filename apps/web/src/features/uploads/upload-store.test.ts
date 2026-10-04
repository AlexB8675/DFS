import type { SyncState } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { summarize, type UploadItem, type UploadStatus } from './upload-store'

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
