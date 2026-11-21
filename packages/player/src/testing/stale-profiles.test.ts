import { describe, expect, it } from 'vitest'
import { PROFILE_PREFIX, STALE_PROFILE_MS, staleProfiles } from './stale-profiles.ts'

// The browser run's profile folders (DESIGN.md §10.4): a run that was interrupted leaves its folder in the OS temp
// folder, and the next run removes the ones that are old and are this package's own.

const HOUR = 60 * 60 * 1000
const NOW = 1_000 * HOUR

describe('staleProfiles', () => {
  it('names the folders with the player prefix that are older than 12 hours', () => {
    const entries = [
      { name: `${PROFILE_PREFIX}abc123`, modifiedMs: NOW - 13 * HOUR },
      { name: `${PROFILE_PREFIX}def456`, modifiedMs: NOW - 12 * HOUR - 1 },
    ]
    expect(staleProfiles(entries, NOW)).toEqual([
      `${PROFILE_PREFIX}abc123`,
      `${PROFILE_PREFIX}def456`,
    ])
  })

  it('keeps the ones that are 12 hours old or less: a run may be going', () => {
    const entries = [
      { name: `${PROFILE_PREFIX}now`, modifiedMs: NOW },
      { name: `${PROFILE_PREFIX}edge`, modifiedMs: NOW - STALE_PROFILE_MS },
    ]
    expect(staleProfiles(entries, NOW)).toEqual([])
  })

  it("never names a folder that is not this package's: another prefix, or the prefix inside the name", () => {
    const old = NOW - 100 * HOUR
    const entries = [
      { name: 'dfs-mp4-chrome-profile-abc', modifiedMs: old },
      { name: 'dfs-scan-test-abc', modifiedMs: old },
      { name: `x${PROFILE_PREFIX}abc`, modifiedMs: old },
      { name: PROFILE_PREFIX.slice(0, -1), modifiedMs: old },
      { name: 'Temp', modifiedMs: old },
    ]
    expect(staleProfiles(entries, NOW)).toEqual([])
  })

  it("has a prefix that is the player's own", () => {
    expect(PROFILE_PREFIX).toBe('dfs-player-chrome-profile-')
  })
})
