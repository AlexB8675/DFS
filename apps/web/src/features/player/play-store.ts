import { cleanLeftovers } from '@dfs/player'

// The page's side of the play's encrypted store (DESIGN.md §10.4; the iron-clad spec
// §4.7): the worker that serves it, and the clean-up of what a crashed play left behind.

/**
 * A new worker that serves a play's store. Its file is the app's own and same-origin:
 * Vite emits it under `assets/` and rewrites this URL to it, which the CSP allows where
 * it would refuse a `blob:` or an inline worker. The player gives it to `openDownload`.
 */
export function makeStoreWorker(): Worker {
  return new Worker(new URL('./store.worker.ts', import.meta.url), { type: 'module' })
}

/** Removes the stores that crashed plays left, and says how many on the console. It never fails. */
async function clearLeftovers(): Promise<void> {
  try {
    const removed = await cleanLeftovers()
    if (removed > 0) console.debug(`Removed ${removed} play store(s) left by crashed plays (§10.4)`)
  } catch {
    // A clean-up that fails is not worth a page's attention: the next start tries again.
  }
}

/**
 * Clears the leftovers of crashed plays, at the start of the app (§10.4): a play's store
 * is deleted when the play ends, so one that remains is from a crash, and a store whose
 * play another tab still holds is left alone. It does not wait, and it swallows every
 * failure, a synchronous one as well as a rejection.
 */
export function clearPlayLeftovers(): void {
  void clearLeftovers()
}
