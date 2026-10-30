import { describe, expect, expectTypeOf, it } from 'vitest'
import * as player from './index.ts'

// What the package gives the playback engine of the next step (DESIGN.md §10.4): one open call,
// the downloader it answers, the store's interface and errors, the connection of the page, the
// clean-up, and the bounds.

describe('the package', () => {
  it('exports what the engine uses', () => {
    for (const name of [
      'openDownload',
      'Downloader',
      'ReadError',
      'StoreError',
      'pageConnectivity',
      'cleanLeftovers',
      'BLOCK_BYTES',
      'DISK_CAP_BYTES',
      'QUOTA_SHARE',
      'DISK_FLOOR_BYTES',
      'MEMORY_CAP_BYTES',
      'FRONTIER_BLOCKS',
      'RETRY_BASE_MS',
      'RETRY_MAX_MS',
      'RETRY_JITTER',
      'RATE_WINDOW_MS',
      'LEVEL_EVERY_MS',
      'HEAD_BYTES',
    ]) {
      expect(player).toHaveProperty(name)
    }
  })

  it('exports the types the engine needs', () => {
    expectTypeOf<player.PlayStore>().toHaveProperty('write')
    expectTypeOf<player.Connectivity>().toHaveProperty('onOnline')
    expectTypeOf<player.WriteOutcome>().toHaveProperty('full')
    expectTypeOf<player.StoreStats>().toHaveProperty('storedBytes')
    expectTypeOf<player.OpenDownloadOptions>().toHaveProperty('playId')
    expectTypeOf(player.openDownload).returns.resolves.toEqualTypeOf<player.Downloader>()
  })
})
