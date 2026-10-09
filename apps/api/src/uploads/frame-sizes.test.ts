import { frameOverheadBytes, loadConfig } from '@dfs/config'
import { chunkFrameLength, SEGMENT_BYTES } from '@dfs/crypto'
import { describe, expect, it } from 'vitest'

// The settings work out the chunk size from the frame overhead without
// @dfs/crypto (packages/config/src/sizes.ts): both must say the same.

describe('frame sizes (§7.3)', () => {
  it('are the same in the settings and in the frames sealed', () => {
    const { sizes } = loadConfig({ NODE_ENV: 'test' }, { service: 'api', rootDir: '.' })
    for (const size of [
      0,
      1,
      SEGMENT_BYTES - 1,
      SEGMENT_BYTES,
      SEGMENT_BYTES + 1,
      sizes.packThresholdBytes,
      sizes.chunkSize,
    ]) {
      expect(size + frameOverheadBytes(size)).toBe(chunkFrameLength(size))
    }
    expect(chunkFrameLength(sizes.chunkSize)).toBeLessThanOrEqual(sizes.blobMaxBytes)
  })
})
