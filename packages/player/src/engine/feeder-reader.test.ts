import { Mp4Error } from '@dfs/mp4'
import type * as Mp4 from '@dfs/mp4'
import type { SourceIndex } from '@dfs/mp4'
import { matroskaMovie } from '@dfs/mp4/testing'
import type { TimelineEventInput } from '@dfs/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Feeder } from './feeder.ts'
import type { ByteSource } from './source.ts'

// Two cases that no file a test can build gives (DESIGN.md §10.4): an index with no duration
// (the reader leaves it null only when the reads that opening is allowed run out), and a chunk
// that the reader's frames function calls damaged. The reader is the real one, wrapped.

const control = { noDuration: false, damage: false }

vi.mock('@dfs/mp4', async (importOriginal) => {
  const real = await importOriginal<typeof Mp4>()
  return {
    ...real,
    openSource: ((...args: Parameters<typeof real.openSource>) => {
      const step = real.openSource(...args)
      if (control.noDuration && 'done' in step) {
        return { done: { ...step.done, durationSeconds: null } as SourceIndex }
      }
      return step
    }) as typeof real.openSource,
    framesIn: ((...args: Parameters<typeof real.framesIn>) => {
      if (control.damage) throw new real.Mp4Error('damaged', 'A block is damaged.')
      return real.framesIn(...args)
    }) as typeof real.framesIn,
  }
})

const VP9_KEY = Uint8Array.of(0x82, 0x49, 0x83, 0x42, 0x00)

function file(): Uint8Array {
  return matroskaMovie({
    docType: 'webm',
    scale: 1_000_000,
    duration: 2000,
    tracks: [
      {
        number: 1,
        type: 1,
        codecId: 'V_VP9',
        defaultDuration: 33_333_333,
        video: { pixelWidth: 320, pixelHeight: 240 },
      },
    ],
    clusters: [
      { timestamp: 0, frames: [{ track: 1, time: 0, keyframe: true, data: VP9_KEY }] },
      { timestamp: 1000, frames: [{ track: 1, time: 1000, keyframe: true, data: VP9_KEY }] },
    ],
  }).bytes
}

class Source implements ByteSource {
  readonly positions: number[] = []
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  get fileSize(): number {
    return this.bytes.length
  }
  read(range: { start: number; end: number }): Promise<Uint8Array> {
    return Promise.resolve(this.bytes.subarray(range.start, range.end))
  }
  fetchNow(): Promise<void> {
    return Promise.resolve()
  }
  setPosition(offset: number): void {
    this.positions.push(offset)
  }
}

beforeEach(() => {
  control.noDuration = false
  control.damage = false
})

describe('the feeder over an index with no duration (R29 i)', () => {
  it('has a null duration and sets only the position a seek ends at', async () => {
    control.noDuration = true
    const source = new Source(file())
    const feeder = await Feeder.open(
      source,
      () => true,
      () => undefined,
    )
    expect(feeder.durationSeconds).toBeNull()
    await feeder.seek(1, new AbortController().signal)
    expect(source.positions).toHaveLength(1)
  })
})

describe('damage that the reader reports (R29 h)', () => {
  it('logs it once as an engine error and rethrows it', async () => {
    const source = new Source(file())
    const events: TimelineEventInput[] = []
    const feeder = await Feeder.open(
      source,
      () => true,
      (event) => events.push(event),
    )
    control.damage = true
    const sink = { init: () => Promise.resolve(), append: () => Promise.resolve() }
    const failed = await feeder.feed(5, sink, new AbortController().signal).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(Mp4Error)
    expect(events).toEqual([
      { type: 'error', from: 'engine', code: null, message: 'A block is damaged.' },
    ])
  })
})
