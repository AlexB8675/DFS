import { test } from 'vitest'
import { DEFAULT_LIMITS, UploadEngine } from './upload-engine'
import { useUploadStore } from './upload-store'
import type { UploadTransport } from './upload-transport'

// Synthetic 30 ms requests for 32 small files of 1 MiB isolate their reading,
// hashing and scheduling from the API, disk and network. Check the live stack
// before raising production limits. Larger files stream in one request each,
// with nothing to schedule between parts.
const chunk = new Uint8Array(1024 * 1024).fill(7)
const files = Array.from({ length: 32 }, (_, index) => ({
  file: new File([chunk], `benchmark-${String(index)}.bin`),
  relativeDir: '',
}))

for (const requests of [4, 6, 8]) {
  test(`${String(requests)} requests, 32 small files of 1 MiB`, async ({ bench }) => {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const upload = async (preparedParts: number) => {
      const finished = Promise.withResolvers<undefined>()
      const received = new Set<string>()
      let inFlight = 0
      const transport: UploadTransport = {
        ensureFolders: () => Promise.resolve({}),
        unfinished: () => Promise.resolve([]),
        createSessions: (uploads) =>
          Promise.resolve(
            uploads.map((_, index) => ({
              ok: true as const,
              session: {
                uploadId: `upload-${String(index)}`,
                nodeId: `node-${String(index)}`,
                versionId: `version-${String(index)}`,
                isNewVersion: false,
                chunkSize: chunk.length,
                chunkCount: 1,
              },
            })),
          ),
        putPart: async (uploadId, _index, bytes, sha256, signal) => {
          if (
            signal.aborted ||
            bytes.byteLength !== chunk.length ||
            sha256 !== hash ||
            received.has(uploadId)
          ) {
            const error = new Error('Invalid or duplicate benchmark file.')
            finished.reject(error)
            throw error
          }
          inFlight += 1
          if (inFlight > requests) {
            const error = new Error('Benchmark exceeded its request limit.')
            finished.reject(error)
            throw error
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 30)
          })
          received.add(uploadId)
          inFlight -= 1
          if (received.size === files.length) finished.resolve(undefined)
        },
        streamFile: () => Promise.reject(new Error('Unexpected stream.')),
        complete: () => Promise.reject(new Error('Unexpected completion.')),
        status: () => Promise.reject(new Error('Unexpected retry.')),
        cancel: () => Promise.resolve(),
        nodes: () => Promise.resolve([]),
      }
      const engine = new UploadEngine(transport, { ...DEFAULT_LIMITS, requests, preparedParts })
      try {
        await engine.enqueue('folder', files)
        await finished.promise
        // Let the engine consume its last answer before clearing the panel.
        await new Promise((resolve) => {
          setTimeout(resolve, 0)
        })
      } finally {
        engine.cancelAll()
        engine.clearFinished()
        useUploadStore.getState().apply(new Map(), 0)
      }
    }
    const current = bench('prepare in request slots', () => upload(0))
    const pipeline = bench('bounded preparation ahead', () => upload(2))
    const results = await bench.compare(current, pipeline, {
      time: 1000,
      iterations: 3,
      warmupTime: 100,
      warmupIterations: 1,
    })
    console.info(
      `[INFO] ${String(requests)} requests: ${results.get(current.name).latency.mean.toFixed(1)} ms → ${results.get(pipeline.name).latency.mean.toFixed(1)} ms. Synthetic latency; no server or storage.`,
    )
  })
}
