// The store's worker entry (DESIGN.md §10.4; the iron-clad spec §4.7). The app's worker
// file calls `serveStoreInWorker`, and the page opens its stores with `WorkerStore`.
// It is checked with the browser's files, because it needs the worker's own scope.

/**
 * Serves the store of a play on the worker's own scope. The private file system and the
 * lock of a play are not wired yet, so it cannot serve and says so, and does not pretend.
 */
export function serveStoreInWorker(): void {
  throw new Error('the store worker is not wired to the private file system yet')
}
