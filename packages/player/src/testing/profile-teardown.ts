// The browser run's teardown for its profile folder (DESIGN.md §10.4; vitest.browser.config.ts makes the folder and
// names it in `DFS_PLAYER_PROFILE`): it is removed when the run ends, retrying while the browser lets go of its
// files. It holds the store's files of the plays, encrypted, the user's videos among them. A folder that this misses
// is swept by the next run (stale-profiles.ts).

import { rm } from 'node:fs/promises'

/** Vitest's `globalSetup`: nothing to set up; the returned function is the teardown. */
export default function setup(): () => Promise<void> {
  return async () => {
    const folder = process.env.DFS_PLAYER_PROFILE
    if (folder === undefined || folder === '') return
    try {
      await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch {
      // A browser that has not let go: the exit handler of the config tries once more, and the next run sweeps it.
    }
  }
}
