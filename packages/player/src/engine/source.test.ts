import { describe, expectTypeOf, it } from 'vitest'
import type { Downloader } from '../downloader.ts'
import type { ByteSource } from './source.ts'

// What the feeder reads a file through (DESIGN.md §10.4): the part of the
// downloader that it needs, so that a test can give it a file in memory.

describe('ByteSource', () => {
  it('is what a Downloader is', () => {
    expectTypeOf<Downloader>().toExtend<ByteSource>()
  })
})
