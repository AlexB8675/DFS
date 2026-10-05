import { test } from 'vitest'
import { DEFAULT_LIMITS, UploadEngine } from './upload-engine'
import { useUploadStore } from './upload-store'
import type { UploadTransport } from './upload-transport'

// Synthetic 30 ms part requests isolate preparation and scheduling from the
// API, disk and network. Check the live stack before raising production limits.
const chunk = new Uint8Array(1024 * 1024).fill(7)
const file = new File(
  Array.from({ length: 32 }, () => chunk),
  'benchmark.bin',
)

for (const parts of [4, 6, 8]) {
  test(`${String(parts)} parallel parts, 32 MiB upload`, async ({ bench }) => {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const upload = async (preparedParts: number) => {
      const finished = Promise.withResolvers<undefined>()
      const received = new Set<number>()
      let requests = 0
      const transport: UploadTransport = {
        ensureFolders: () => Promise.resolve({}),
        createSessions: () =>
          Promise.resolve([
            {
              ok: true,
              session: {
                uploadId: 'upload',
                nodeId: 'node',
                versionId: 'version',
                isNewVersion: false,
                chunkSize: chunk.length,
                chunkCount: 32,
              },
            },
          ]),
        putPart: async (_uploadId, index, bytes, sha256, signal) => {
          if (
            signal.aborted ||
            bytes.byteLength !== chunk.length ||
            sha256 !== hash ||
            received.has(index)
          ) {
            const error = new Error('Invalid or duplicate benchmark part.')
            finished.reject(error)
            throw error
          }
          requests += 1
          if (requests > parts) {
            const error = new Error('Benchmark exceeded its request limit.')
            finished.reject(error)
            throw error
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 30)
          })
          received.add(index)
          requests -= 1
        },
        complete: () => {
          if (received.size !== 32) finished.reject(new Error('Benchmark lost a part.'))
          else finished.resolve(undefined)
          return Promise.resolve()
        },
        status: () => Promise.reject(new Error('Unexpected retry.')),
        cancel: () => Promise.resolve(),
        node: () => Promise.resolve(null),
      }
      const engine = new UploadEngine(transport, {
        ...DEFAULT_LIMITS,
        requests: parts * 2,
        partsPerFile: parts,
        preparedParts,
      })
      try {
        await engine.enqueue('folder', [{ file, relativeDir: '' }])
        await finished.promise
        // Let the engine consume its completion before clearing the panel.
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
      `[INFO] ${String(parts)} parts: ${results.get(current.name).latency.mean.toFixed(1)} ms → ${results.get(pipeline.name).latency.mean.toFixed(1)} ms. Synthetic latency; no server or storage.`,
    )
  })
}
