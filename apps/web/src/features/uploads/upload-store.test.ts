import { describe, expect, it } from 'vitest'
import { summarize, type UploadItem, type UploadStatus } from './upload-store'

function item(status: UploadStatus, size: number, uploadedBytes: number): UploadItem {
  return {
    id: crypto.randomUUID(),
    file: new File([new Uint8Array(size)], 'file.bin'),
    parentId: 'folder',
    status,
    uploadedBytes,
    uploadId: null,
    error: null,
  }
}

describe('summarize', () => {
  it('counts statuses and weighs progress by bytes', () => {
    const summary = summarize([
      item('uploading', 100, 50),
      item('queued', 100, 0),
      item('done', 200, 200),
      item('failed', 100, 30),
    ])
    expect(summary).toMatchObject({ total: 4, active: 2, done: 1, failed: 1 })
    expect(summary.progress).toBeCloseTo(280 / 500)
  })

  it('leaves canceled uploads out of the progress', () => {
    const summary = summarize([item('done', 100, 100), item('canceled', 900, 10)])
    expect(summary.progress).toBe(1)
  })

  it('treats a batch of empty files as complete once nothing is active', () => {
    expect(summarize([item('done', 0, 0)]).progress).toBe(1)
    expect(summarize([item('queued', 0, 0)]).progress).toBe(0)
  })
})
