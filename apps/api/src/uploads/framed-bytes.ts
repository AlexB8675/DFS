import { chunkFrameLength } from '@dfs/crypto'

/**
 * What a file's parts from `fromIndex` on take in staging (§6.1, D38): each
 * part sealed in a frame of its own (§7.3), every one the chunk size but the
 * last.
 */
export function framedBytes(sizeBytes: number, chunkSize: number, fromIndex = 0): number {
  const chunkCount = Math.ceil(sizeBytes / chunkSize)
  if (fromIndex >= chunkCount) return 0
  const lastSize = sizeBytes - chunkSize * (chunkCount - 1)
  return (chunkCount - 1 - fromIndex) * chunkFrameLength(chunkSize) + chunkFrameLength(lastSize)
}
