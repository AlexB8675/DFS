import { fragmentRuns } from '@dfs/mp4'
import { box, concat, u32 } from '@dfs/mp4/testing'
import { describe, expect, it } from 'vitest'

// The engine's suites build the files they play with the box builders of
// `@dfs/mp4/testing` (DESIGN.md §10.4), and cut fragments with `fragmentRuns` from
// the package's entry point: both must resolve from here.

describe('what @dfs/mp4 gives the player', () => {
  it('has the box builders under @dfs/mp4/testing', () => {
    const made = box('free', concat(u32(7)))
    expect(made).toEqual(Uint8Array.of(0, 0, 0, 12, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 7))
  })

  it('has fragmentRuns under @dfs/mp4', () => {
    const table = {
      count: 2,
      timescale: 1000,
      durations: Uint32Array.of(100, 100),
      sync: Uint8Array.of(1, 0),
    }
    expect(fragmentRuns(table, 0, 2, false)).toEqual([[0, 2]])
  })
})
