import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runToFile, streamStart } from './ffprobe.ts'

// The corpus suite's helpers for ffprobe (DESIGN.md §10.4): what they do when
// ffprobe isn't there, and when it can't say where a stream starts.

describe('runToFile', () => {
  it('rejects, once and with a sentence, when the program cannot be run', async () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-test-'))
    try {
      await expect(
        runToFile('dfs-no-such-program', ['-version'], resolve(folder, 'out.json')),
      ).rejects.toThrow(/dfs-no-such-program could not be run.*PATH/)
      // A second close of the output file, if there is one, comes as an event after the first: give it time to throw.
      await new Promise((done) => setTimeout(done, 200))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('streamStart', () => {
  it('is the start in ticks of the time base, exactly', () => {
    expect(streamStart({ index: 0, start_pts: 22976, time_base: '1/48000' })).toBeCloseTo(
      22976 / 48000,
      12,
    )
  })

  it('falls back to the start time when there is no start in ticks', () => {
    expect(streamStart({ index: 0, start_time: '0.478667', time_base: '1/48000' })).toBe(0.478667)
  })

  it('is null when ffprobe prints N/A for the start, as it does when it has none', () => {
    expect(
      streamStart({ index: 0, start_pts: 'N/A', start_time: 'N/A', time_base: '1/90000' }),
    ).toBeNull()
    expect(streamStart({ index: 0, start_time: 'N/A', time_base: '1/90000' })).toBeNull()
    expect(streamStart({ index: 0, start_time: '', time_base: '1/90000' })).toBeNull()
    expect(streamStart({ index: 0 })).toBeNull()
  })

  it('does not take a start in ticks when the time base is not a fraction', () => {
    expect(streamStart({ index: 0, start_pts: 5, time_base: 'N/A' })).toBeNull()
    expect(streamStart({ index: 0, start_pts: 5, time_base: '1/0' })).toBeNull()
  })
})
