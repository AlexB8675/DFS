// The store's worker entry (DESIGN.md §10.4; the iron-clad spec §4.7). The app's worker
// file calls `serveStoreInWorker`, and the page opens its stores with `WorkerStore`.
// It is checked with the browser's files, because it needs the worker's own scope.

import { opfsDirectory, playLock } from './opfs.ts'
import { serveStore } from './serve.ts'

/**
 * Serves the store of a play on the worker's own scope, on the browser's private file
 * system and under the play's Web Lock. It must run in a dedicated worker: a page has
 * no synchronous access to a file, and says so (`no-opfs`) when the page opens a play.
 */
export function serveStoreInWorker(): void {
  serveStore(self, opfsDirectory, playLock)
}
