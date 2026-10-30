// The bounds of the player's store and downloader (DESIGN.md §10.4; the iron-clad spec §4.7): how
// much a play keeps and where, how it retries a failed read, and what it reports
// while it downloads. Each is named as the plan names it, and the later steps of
// the store add theirs here.

/** The unit of storage, of sealing and of eviction: 1 MiB. */
export const BLOCK_BYTES = 1024 * 1024

/** The most that the disk store holds for one play: 2 GiB, the spec's "up to 2 GB". */
export const DISK_CAP_BYTES = 2 * 1024 ** 3

/** The share of the free quota (`quota − usage`, as `navigator.storage.estimate()` says) that a play may take: 80%, if that is less than the cap. */
export const QUOTA_SHARE = 0.8

/** The least that the disk store is worth: 64 MiB. A quota that leaves less sends the play to memory, with the reason `quota`. */
export const DISK_FLOOR_BYTES = 64 * 1024 * 1024

/** The most that the memory fallback holds: 256 MiB, the spec's "a few hundred MB", where storage is unavailable or refused. */
export const MEMORY_CAP_BYTES = 256 * 1024 * 1024

/** How many blocks being filled, or full and waiting for a slot, are kept in memory outside the cap: 8 (8 MiB), enough for two onward reads, the priority reads, a block pending on disk and the partial blocks that aborted reads leave. */
export const FRONTIER_BLOCKS = 8

/** The first pause before a failed read is tried again: 500 ms, and each pause after it doubles. */
export const RETRY_BASE_MS = 500

/** The longest pause between two tries of a read: 30 s. The downloader retries for as long as the play lasts, so this is a pause and not a limit. */
export const RETRY_MAX_MS = 30_000

/** How far each pause is moved, up or down, at random: 20%, as the uploads' retries are (`apps/web/src/features/uploads/retry.ts`). */
export const RETRY_JITTER = 0.2

/** The span of the measured rate: the last 5 s of receiving. */
export const RATE_WINDOW_MS = 5_000

/** How often the `storeLevel` event is recorded while the play downloads: every 5 s, where one per block would fill the timeline. */
export const LEVEL_EVERY_MS = 5_000

/** The first read of a play: 1 MiB, which also says the file's size. */
export const HEAD_BYTES = 1024 * 1024

/** How long a request to the store's worker may wait for its answer: 15 s from when it is sent, so that it counts the time spent behind the requests before it. Sealing and writing a megabyte takes milliseconds; a worker that is silent for this long is gone, and the play moves to memory. */
export const STORE_CALL_MS = 15_000

/** How long the opening of the store's worker may take: 30 s, for the worker's script to load, the lock to be taken, the directory and its file to open, and the probe of the file. A worker that does not open in this time is not used, and the play goes on in memory. */
export const STORE_OPEN_MS = 30_000

/** How long the browser's estimate of its room (`navigator.storage.estimate()`) is waited for: 5 s. An estimate that has not come by then is taken as one that failed, and the disk store has its full cap. */
export const ESTIMATE_MS = 5_000

/** How late a deadline's timer may fire before the page is taken to have stood still: 1 s past the deadline by the clock. A timer that fires later than that fired in a page that was asleep, frozen or throttled, where the worker's answer may be waiting to be handled, so the worker has not had its time. */
export const LATE_TIMER_MS = 1_000

/** The extra time given once to a request whose deadline fired late: 2 s, for the answers that were waiting to be handled when the page woke. An expiry that is not late, and the expiry of this grace, are the worker's death. */
export const WAKE_GRACE_MS = 2_000

/** How long a read may wait on the network before it is given up as stalled: 10 s with no response headers, or with no new piece of the body. Only the time spent waiting on the network counts, never the time spent writing what came to the store. The read is tried again from its next byte, after the usual pause. */
export const READ_IDLE_MS = 10_000

/** How long a read may go without a piece (or without a write finishing) before it no longer covers any place, so that the engine's reads go around it, and before a return of the network opens it again: 2 s. */
export const STALL_COVER_MS = 2_000

/** How far ahead of its next byte a read covers a place, in time at the measured rate: half a second, but never more than a block. Where the rate is not known yet a read covers a block. */
export const COVER_AHEAD_MS = 500
