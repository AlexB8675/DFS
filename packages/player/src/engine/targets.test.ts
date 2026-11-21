import { describe, expect, it } from 'vitest'
import { DecoderWindow } from './window.ts'
import type { FedRun } from './window.ts'
import { feedTargets } from './targets.ts'

// The feed's targets (DESIGN.md §10.4): what the window wants of each playing track, as the distinct
// `until` values from the least up, so that a track far ahead never pulls the other past its window.

function fed(kind: 'video' | 'audio', start: number, end: number): FedRun {
  return { kind, start, end, bytes: 1000, keyframe: true }
}

describe('feedTargets', () => {
  it('is empty when no track wants anything', () => {
    expect(feedTargets([null, null])).toEqual([])
    expect(feedTargets([])).toEqual([])
  })

  it('gives the distinct untils from the least up, and leaves out what a track does not want', () => {
    expect(feedTargets([{ until: 9 }, null, { until: 4 }, { until: 9 }])).toEqual([4, 9])
  })

  it('puts the picture first when the sound is far ahead of it', () => {
    const window = new DecoderWindow()
    // The picture holds 0-2 s, the sound 0-20 s.
    window.fed(fed('video', 0, 2))
    window.fed(fed('audio', 0, 20))
    const wanted = [window.wants('video', 0), window.wants('audio', 0)]
    const targets = feedTargets(wanted)
    expect(targets).toHaveLength(2)
    expect(targets[0]).toBe(wanted[0]?.until)
    expect(targets[0]).toBeLessThan(targets[1] ?? 0)
  })
})
