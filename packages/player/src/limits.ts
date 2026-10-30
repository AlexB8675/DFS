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
