// The profile folders of the browser run (DESIGN.md §10.4; vitest.browser.config.ts): Chrome's persistent context
// lives in a fresh folder of the OS temp folder, which the run removes at its end. A run that was interrupted leaves
// its folder (the store's encrypted files of the plays are in it), so the next run removes the ones that are this
// package's own and are old. Pure: names and ages in, names out.

/** What the names of this package's profile folders begin with: no other package's folder, or anything of the system's, has it. */
export const PROFILE_PREFIX = 'dfs-player-chrome-profile-'

/** A folder older than this is a left-over of a run that did not finish: a run that is going is never that old. */
export const STALE_PROFILE_MS = 12 * 60 * 60 * 1000

/** The names, of those given, that are this package's profile folders and were last modified more than `STALE_PROFILE_MS` before `nowMs`. */
export function staleProfiles(
  entries: readonly { name: string; modifiedMs: number }[],
  nowMs: number,
): string[] {
  return entries
    .filter(({ name, modifiedMs }) => {
      return name.startsWith(PROFILE_PREFIX) && nowMs - modifiedMs > STALE_PROFILE_MS
    })
    .map(({ name }) => name)
}
