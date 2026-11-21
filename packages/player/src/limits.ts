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

// The playback engine's bounds (DESIGN.md §10.4; the iron-clad spec §4.8).

/** How far ahead the decoder window reaches, when bytes allow: 30 s. */
export const WINDOW_AHEAD_SECONDS = 30

/** The played time kept in the decoder window for a short seek back: 5 s. */
export const WINDOW_BEHIND_SECONDS = 5

/** The least a track is fed ahead of the playhead even when the window is full in bytes: 1 s. The byte cap never starves the playhead, so a 4K file's full window still gets its next second, and the overshoot is about a second's worth plus a fragment. */
export const WINDOW_MIN_AHEAD_SECONDS = 1

/** How far ahead of what a track holds the engine feeds in one call: 1 s. `wants` answers a step, never the whole 30 s, so a full window is not overshot by more than a step. */
export const FEED_STEP_SECONDS = 1

/** The gap at a playhead that a track's coverage steps over: 2 s. A track whose first frame comes after the playhead (a B-frame picture's first shows at about 0.03 s, a sound may start late) counts from its first run when that starts within this. The watchdog steps over a gap of the same size. */
export const GAP_STEP_SECONDS = 2

/** The window's total across tracks: 64 MiB, well under Firefox's ~150 MB and phones' lower caps. At 120 Mbit/s it is about 4 s ahead, and the store refills it just in time. */
export const WINDOW_BYTES = 64 * 1024 * 1024

/** The least the window shrinks to after quota errors: 16 MiB. */
export const WINDOW_FLOOR_BYTES = 16 * 1024 * 1024

/** The factor by which each quota error shrinks the window: 0.75. */
export const QUOTA_SHRINK = 0.75

/** The first read for the feeder at a cursor: 1 MiB. */
export const CHUNK_BYTES = 1024 * 1024

/** The largest read the feeder doubles to before a cursor that won't advance is damage: 32 MiB. */
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024

/** The read of the file's end, started as soon as the size is known: 1 MiB. Samsung phone files keep a `moov` of 70 KB or less there (measured on the corpus, 2026-11-20); the OBS recordings' 7.6 MiB needs a second read. */
export const TAIL_BYTES = 1024 * 1024

/** The chunks that opening and seeks needed (the head, the tail, the Cues; `CUES_LIMIT` is 32 MiB), kept in memory for the play so that seeks don't read them again: 40 MiB. */
export const INDEX_CACHE_BYTES = 40 * 1024 * 1024

/** How often the playhead's byte offset is given to the downloader while playing: every second. */
export const POSITION_EVERY_MS = 1_000

/** The hold rule's goal at the start, in seconds of picture: 2, as the old engine's. */
export const START_GOAL_SECONDS = 2

/** The hold rule's goal after a stall, in seconds of picture: 4, as the old engine's. */
export const STALL_GOAL_SECONDS = 4

/** How long a seek may wait for its picture: 10 s. A seek with none by then is logged and refed by the watchdog. */
export const SEEK_DEADLINE_MS = 10_000

/** How long a clock or frame count that has not moved, while playing with data at the playhead, is taken as stuck: 2 s. */
export const STUCK_MS = 2_000

/** The watchdog's cadence: every 500 ms. */
export const WATCH_EVERY_MS = 500

/** The watchdog's last resort, a new Media Source at the current time, at most this many times per play: 3. After that the play fails with the reason. */
export const REOPENS_MAX = 3

/** Added to a track's `appendWindowEnd`, in seconds, so that rounding never drops its last frame: 1 ms. */
export const APPEND_WINDOW_PAD_SECONDS = 0.001

/** How much picture a play's first feed waits through for a sound frame before it goes on with no sound: 3 s. The first feed's fragments are held until then (about 45 MB at 120 Mbit/s, only when no sound frame comes). */
export const SOUND_WAIT_SECONDS = 3

/** How near a buffered range's end the playhead counts as sitting at it, in seconds: 0.25. Chrome and Firefox stop about a frame before the end of a range. */
export const GAP_EDGE_SECONDS = 0.25

/** Taken off the end of a removal from a SourceBuffer, in seconds, so that rounding never removes the keyframe of the group being played (carry from R23): 1 ms. */
export const REMOVE_PAD_SECONDS = 0.001
