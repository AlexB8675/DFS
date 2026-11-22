import { describe, expect, it } from 'vitest'
import type { EngineStats } from '@dfs/player/page'
import { reportLab } from './report-lab'

function stats(overrides: Partial<EngineStats> = {}): EngineStats {
  return {
    phase: 'buffering',
    codecs: ['avc1.640028', 'mp4a.40.2'],
    supported: {},
    bytesReceived: 1000,
    readingMs: 10,
    heldMs: 20,
    aheadSeconds: 5,
    targetAheadSeconds: 30,
    keyframeGapSeconds: 2,
    quotaErrors: 0,
    reopens: 0,
    seeks: 0,
    holding: false,
    holds: 0,
    holdMs: 0,
    segments: 3,
    error: null,
    failedOn: null,
    backend: 'memory',
    storedBytes: 1000,
    evictedBytes: 0,
    windowBytes: 1000,
    rate: 1000,
    slow: false,
    ...overrides,
  }
}

describe('the play report’s lab for a buffered play', () => {
  it('keeps the old fields and adds the store’s, as JSON', () => {
    const lab: unknown = JSON.parse(
      reportLab(
        stats({
          phase: 'buffering',
          bytesReceived: 11,
          readingMs: 12,
          heldMs: 13,
          holdMs: 14,
          holds: 15,
          seeks: 16,
          targetAheadSeconds: 17,
          keyframeGapSeconds: 18,
          quotaErrors: 19,
          reopens: 20,
          backend: 'disk',
          storedBytes: 5_000_000,
          evictedBytes: 21,
          rate: 1234.6,
          slow: true,
          failedOn: 'read',
        }),
      ),
    )
    expect(lab).toEqual({
      player: 'buffered',
      phase: 'buffering',
      bytesReceived: 11,
      readingMs: 12,
      heldMs: 13,
      holdMs: 14,
      holds: 15,
      seeks: 16,
      targetAheadSeconds: 17,
      keyframeGapSeconds: 18,
      quotaErrors: 19,
      reopens: 20,
      backend: 'disk',
      storedBytes: 5_000_000,
      evictedBytes: 21,
      rate: 1235,
      slow: true,
      failedOn: 'read',
    })
  })

  it('keeps a rate that is not known yet as null', () => {
    const lab = JSON.parse(reportLab(stats({ rate: null }))) as Record<string, unknown>
    expect(lab.rate).toBeNull()
  })

  it('stays within the report’s 2000 characters at the largest values', () => {
    const big = Number.MAX_SAFE_INTEGER
    const lab = reportLab(
      stats({ bytesReceived: big, storedBytes: big, evictedBytes: big, rate: big }),
    )
    expect(lab.length).toBeLessThanOrEqual(2000)
  })

  it('says only the player before the engine has reported', () => {
    expect(JSON.parse(reportLab(null))).toEqual({ player: 'buffered' })
  })
})
