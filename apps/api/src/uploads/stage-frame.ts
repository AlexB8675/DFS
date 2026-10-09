import { sealChunkFrame, sha256, type AesKey } from '@dfs/crypto'
import type { Staging } from '@dfs/storage'

// Chunks are sealed in format 2 (§7.3): segments, so reads can check part of
// one. Hashing and fsync share the native thread pool. Overlap under light load;
// additional writers stay sequential so busy uploads do not flood that pool.
const writers = new WeakMap<Staging, number>()

/** Encrypts a part and returns only after its durable write and hash both finish. */
export async function stageFrame(
  staging: Staging,
  file: string,
  key: AesKey,
  body: Uint8Array,
  context: Uint8Array,
): Promise<{ frame: Uint8Array; hash: Uint8Array }> {
  const active = (writers.get(staging) ?? 0) + 1
  writers.set(staging, active)
  try {
    const frame = await sealChunkFrame(key, body, context)
    if ((writers.get(staging) ?? 0) > 1) {
      await staging.write(file, frame)
      return { frame, hash: await sha256(frame) }
    }
    // Wait for both even on failure. Caller cleanup must not race a write
    // that is still creating the staged file.
    const [write, hash] = await Promise.allSettled([staging.write(file, frame), sha256(frame)])
    if (write.status === 'rejected') throw write.reason
    if (hash.status === 'rejected') throw hash.reason
    return { frame, hash: hash.value }
  } finally {
    const remaining = (writers.get(staging) ?? 1) - 1
    if (remaining === 0) writers.delete(staging)
    else writers.set(staging, remaining)
  }
}
