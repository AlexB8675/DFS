import type { EngineStats } from '@dfs/player/page'

/** The play report's `lab` for a buffered play (DESIGN.md §10.4, §16): what the engine and its store say, as JSON. */
export function reportLab(stats: EngineStats | null): string {
  return JSON.stringify({
    player: 'buffered',
    phase: stats?.phase,
    bytesReceived: stats?.bytesReceived,
    readingMs: stats?.readingMs,
    heldMs: stats?.heldMs,
    holdMs: stats?.holdMs,
    holds: stats?.holds,
    seeks: stats?.seeks,
    targetAheadSeconds: stats?.targetAheadSeconds,
    keyframeGapSeconds: stats?.keyframeGapSeconds,
    quotaErrors: stats?.quotaErrors,
    reopens: stats?.reopens,
    backend: stats?.backend,
    storedBytes: stats?.storedBytes,
    evictedBytes: stats?.evictedBytes,
    rate: stats?.rate === null || stats?.rate === undefined ? stats?.rate : Math.round(stats.rate),
    slow: stats?.slow,
    failedOn: stats?.failedOn,
  })
}
