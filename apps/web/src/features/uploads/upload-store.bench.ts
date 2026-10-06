import { test } from 'vitest'
import { createUploadStore, summarize, type UploadItem } from './upload-store'

// Compare sparse progress updates with the former full-queue publication.
// Shared File data keeps this focused on bookkeeping rather than allocations.
for (const count of [10_000, 100_000]) {
  test(`${String(count)} queued uploads, four progress updates`, async ({ bench }) => {
    const file = new File([new Uint8Array(1024)], 'file.bin')
    let items: UploadItem[] = Array.from({ length: count }, (_, index) => ({
      id: String(index),
      file,
      parentId: 'folder',
      location: null,
      status: 'uploading',
      uploadedBytes: 0,
      nodeId: null,
      syncState: null,
      retrying: false,
      error: null,
    }))
    const store = createUploadStore()
    store.getState().add(items)
    let bytes = 0
    const changes = () =>
      new Map(
        Array.from({ length: 4 }, (_, index) => [String(index), { uploadedBytes: ++bytes % 1024 }]),
      )
    const fullQueue = bench('full queue map and summary', () => {
      const batch = changes()
      items = items.map((item) => {
        const change = batch.get(item.id)
        return change ? { ...item, ...change } : item
      })
      summarize(items)
    })
    const incremental = bench('indexed rows and incremental summary', () => {
      store.getState().apply(changes(), 1000)
    })
    const results = await bench.compare(fullQueue, incremental, { time: 1000 })
    const before = results.get(fullQueue.name).latency.mean
    const after = results.get(incremental.name).latency.mean
    console.info(
      `[INFO] ${String(count)} uploads: ${before.toFixed(3)} ms → ${after.toFixed(3)} ms per batch (${(before / after).toFixed(1)}×).`,
    )
  })
}
