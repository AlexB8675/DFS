import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { chunkContext, generateDek, importAesKey, sealChunkFrame, sha256 } from '@dfs/crypto'
import { Staging } from '@dfs/storage'
import { stageFrame } from '../uploads/stage-frame.ts'

// A repeatable CPU/disk check, without a server, database or user data.
// Run in fresh processes with UV_THREADPOOL_SIZE=4, 8 and 16 before tuning it.
const directory = await mkdtemp(path.join(tmpdir(), 'dfs-performance-'))
const staging = new Staging(directory)
const key = await importAesKey(generateDek())
const versionId = crypto.randomUUID()
const context = chunkContext(versionId, 0)
const iterations = 96

try {
  for (const size of [1024, 1024 * 1024, 20 * 1024 * 1024]) {
    const bytes = new Uint8Array(size).fill(7)
    for (const concurrency of [1, 4, 8]) {
      for (const mode of ['encrypt', 'serial', 'overlap', 'bounded'] as const) {
        await sealChunkFrame(key, bytes, context)
        global.gc?.()
        const delay = monitorEventLoopDelay({ resolution: 10 })
        delay.enable()
        const cpu = process.cpuUsage()
        let peakRss = process.memoryUsage().rss
        const sample = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
        }, 10)
        const started = performance.now()
        let next = 0
        try {
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              for (let index = next++; index < iterations; index = next++) {
                if (mode === 'bounded') {
                  const file = staging.framePath(versionId, index)
                  await stageFrame(staging, file, key, bytes, context)
                  await staging.remove(file)
                  continue
                }
                const frame = await sealChunkFrame(key, bytes, context)
                if (mode === 'encrypt') continue
                const file = staging.framePath(versionId, index)
                if (mode === 'serial') {
                  await staging.write(file, frame)
                  await sha256(frame)
                } else {
                  const results = await Promise.allSettled([
                    staging.write(file, frame),
                    sha256(frame),
                  ])
                  for (const result of results)
                    if (result.status === 'rejected') throw result.reason
                }
                await staging.remove(file)
              }
            }),
          )
        } finally {
          clearInterval(sample)
          delay.disable()
        }
        const elapsed = performance.now() - started
        const used = process.cpuUsage(cpu)
        console.info(
          '[INFO]',
          JSON.stringify({
            threads: process.env.UV_THREADPOOL_SIZE ?? '4',
            size,
            concurrency,
            mode,
            ms: Math.round(elapsed),
            mibPerSecond: Math.round((size * iterations) / 1024 / 1024 / (elapsed / 1000)),
            cpuMs: Math.round((used.user + used.system) / 1000),
            peakRssMiB: Math.round(peakRss / 1024 / 1024),
            eventLoopMaxMs: Math.round(delay.max / 1e6),
          }),
        )
      }
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
