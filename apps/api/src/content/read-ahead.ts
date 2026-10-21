import { READ_AHEAD_AFTER_BYTES, type PrefetchOutcome, type ReadableVersion } from './reader.ts'
import { SESSION_IDLE_MS } from './stream-sessions.ts'

// A stream's read-ahead window (DESIGN.md §6.2): while a player's reads carry
// on through a file, the chunks after them are fetched from Discord into the
// frame cache, so a read that gets there finds them kept. `ReadAhead` holds the
// rules alone, with no I/O: it is told what the stream's reads have sent, and
// says which chunks to fetch through the function it is given. It follows a run
// of reads that has sent 2 MiB and has gone on for a second, so a seek bar
// dragged, each step of which is given up within a second whatever it sent, sets
// nothing reading. A single request's own read-ahead (the reader's, at most 2
// chunks) is a separate thing and stays; this one works across the requests of a
// stream, which a player makes one after another (and a seek makes one for
// each). `ReadAheads` keeps a window for each stream session and version, for
// `sendFile` to feed.

/** The window ahead is never longer than this. */
export const WINDOW_BYTES = 128 * 1024 * 1024
/** The window ahead is at most this many times what its run has sent. */
export const WINDOW_GROWTH = 4
/** Chunks fetched at once for a stream. */
export const PARALLEL_FETCHES = 2
/** A chunk that found no room, or leaned on another read's fetch, is tried again no sooner than this. */
export const BUSY_RETRY_MS = 1000
/** Runs of reads kept to tell which a read carries on, the most recently updated. */
export const MAX_RUNS = 8
/**
 * A run is followed only once it has been read for this long, as well as
 * having sent `READ_AHEAD_AFTER_BYTES`. Bytes sent don't tell a seek passed by
 * from one played on: through the proxy and the sockets' buffers, a read its
 * client gave up after 0.3 s had been sent 3.5 to 14.5 MiB (the lab, 2026-10-22),
 * so every step of a seek bar being dragged had sent enough to start fetches.
 * Time does: a drag's reads are given up within a second, a play's go on.
 */
export const FOLLOW_AFTER_MS = 1000

/** A fetch ahead that ended, for the session's log: not one the cache had, nor one skipped. */
export interface AheadFetch {
  /** The chunk's first byte in the file, and its plaintext bytes. */
  from: number
  bytes: number
  ms: number
  outcome: 'fetched' | 'failed' | 'busy'
}

/** Reads that follow one another: `start` is where the first began, `reach` how far they have sent, `began` when the first did. */
interface Run {
  start: number
  reach: number
  /** On the window's clock; a read that carries on the run leaves it. */
  began: number
}

interface Underway {
  controller: AbortController
  startedAt: number
}

export class ReadAhead {
  readonly #size: number
  readonly #chunkSize: number
  readonly #chunkCount: number
  readonly #prefetch: (index: number, signal: AbortSignal) => Promise<PrefetchOutcome>
  readonly #onFetched: ((fetch: AheadFetch) => void) | undefined
  readonly #now: () => number
  readonly #windowBytes: number
  readonly #parallel: number
  /** The runs kept, the most recently updated first. */
  readonly #runs: Run[] = []
  /** The run the window follows, held here even once it is no longer among the kept. */
  #followed: Run | null = null
  readonly #underway = new Map<number, Underway>()
  /** Chunks whose fetch ended in anything but `busy` or `shared`: this window fetches them no more. */
  readonly #finished = new Set<number>()
  /** Chunks that were busy or shared, and when each may be tried again. */
  readonly #busyUntil = new Map<number, number>()
  /** Chunks reported busy, once each. */
  readonly #busyReported = new Set<number>()
  #stopped = false
  #lastReachedAt: number

  constructor(options: {
    size: number
    chunkSize: number
    chunkCount: number
    /** Never rejects. */
    prefetch: (index: number, signal: AbortSignal) => Promise<PrefetchOutcome>
    onFetched?: (fetch: AheadFetch) => void
    now?: () => number
    windowBytes?: number
    parallel?: number
  }) {
    this.#size = options.size
    this.#chunkSize = options.chunkSize
    this.#chunkCount = options.chunkCount
    this.#prefetch = options.prefetch
    this.#onFetched = options.onFetched
    this.#now = options.now ?? (() => performance.now())
    this.#windowBytes = options.windowBytes ?? WINDOW_BYTES
    this.#parallel = options.parallel ?? PARALLEL_FETCHES
    this.#lastReachedAt = this.#now()
  }

  /** Chunks being fetched, in order. */
  get fetching(): readonly number[] {
    return [...this.#underway.keys()].sort((a, b) => a - b)
  }

  /** When a read last reported what it had sent, on this window's clock; its creation before any did. */
  get lastReachedAt(): number {
    return this.#lastReachedAt
  }

  /**
   * A read that began at byte `from` has sent bytes up to `to` (not included).
   * It carries on the run that reaches `from`, or begins one; the window
   * follows a run once it has sent `READ_AHEAD_AFTER_BYTES` and has been read
   * for `FOLLOW_AFTER_MS` (from the first read of it, whichever carried it on),
   * the one most recently read of. So a storm of short reads (a player probing a
   * file) moves nothing, nor does one of reads given up quickly however much
   * they sent (a seek bar dragged), and a jump to somewhere the player then
   * plays on from does.
   */
  reached(from: number, to: number): void {
    if (this.#stopped) return
    const now = this.#now()
    this.#lastReachedAt = now
    const carries = (run: Run) => run.start <= from && from <= run.reach
    // The followed run too, though short reads elsewhere have pushed it off the
    // runs kept: a request that goes on where it reached isn't a new run.
    const followed = this.#followed !== null && carries(this.#followed) ? this.#followed : undefined
    const run = this.#runs.find(carries) ?? followed ?? { start: from, reach: from, began: now }
    run.reach = Math.max(run.reach, to)
    // The run read of last goes first; with a new one, the oldest may fall off.
    const at = this.#runs.indexOf(run)
    if (at >= 0) this.#runs.splice(at, 1)
    this.#runs.unshift(run)
    if (this.#runs.length > MAX_RUNS) this.#runs.length = MAX_RUNS
    if (run.reach - run.start < READ_AHEAD_AFTER_BYTES || now - run.began < FOLLOW_AFTER_MS) return
    this.#followed = run
    this.#fill()
  }

  /** Aborts the fetches under way; `reached` does nothing after, nor does anything that ends later. */
  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const { controller } of this.#underway.values()) controller.abort()
    this.#underway.clear()
  }

  /**
   * Starts fetches for the chunks the followed run's window reaches, nearest
   * first, while fewer than `parallel` are under way. Chunks fetched, kept or
   * skipped before, under way, or busy or shared not long ago are passed over. A window
   * that has moved leaves what is under way for the old one to finish into the
   * cache (the fetch isn't wasted), and only what isn't started is dropped.
   */
  #fill(): void {
    const run = this.#followed
    if (run === null || this.#stopped) return
    const last = this.#chunkCount - 1
    // The chunk holding the last byte sent, the one before `reach`: when a read
    // stops exactly where a chunk ends, the chunk that begins there is next.
    const current = Math.min(last, Math.floor((run.reach - 1) / this.#chunkSize))
    const count = Math.max(
      1,
      Math.ceil(
        Math.min(this.#windowBytes, WINDOW_GROWTH * (run.reach - run.start)) / this.#chunkSize,
      ),
    )
    const end = Math.min(last, current + count)
    const now = this.#now()
    for (let index = current + 1; index <= end; index += 1) {
      if (this.#underway.size >= this.#parallel) return
      if (this.#underway.has(index) || this.#finished.has(index)) continue
      const busyUntil = this.#busyUntil.get(index)
      if (busyUntil !== undefined && now < busyUntil) continue
      this.#start(index)
    }
  }

  #start(index: number): void {
    const entry: Underway = { controller: new AbortController(), startedAt: this.#now() }
    this.#underway.set(index, entry)
    const settled = (outcome: PrefetchOutcome) => {
      this.#settled(index, entry, outcome)
    }
    // `prefetch` never rejects; one that does is a fetch that failed, not an
    // unhandled rejection in the API.
    void this.#prefetch(index, entry.controller.signal).then(settled, () => {
      settled('failed')
    })
  }

  /** A fetch ended: what became of the chunk, the window filled again, and a report of it. */
  #settled(index: number, entry: Underway, outcome: PrefetchOutcome): void {
    if (this.#stopped || this.#underway.get(index) !== entry) return
    this.#underway.delete(index)
    const ms = this.#now() - entry.startedAt
    let reported: AheadFetch['outcome'] | null = null
    if (outcome === 'busy' || outcome === 'shared') {
      this.#busyUntil.set(index, this.#now() + BUSY_RETRY_MS)
      // A chunk without room is reported once; one that leaned on another read's fetch, not
      // at all: it fetched nothing, and may be tried again.
      if (outcome === 'busy' && !this.#busyReported.has(index)) {
        this.#busyReported.add(index)
        reported = 'busy'
      }
    } else {
      this.#busyUntil.delete(index)
      this.#finished.add(index)
      if (outcome === 'fetched' || outcome === 'failed') reported = outcome
    }
    // Filled before it reports.
    this.#fill()
    if (reported !== null) {
      const from = index * this.#chunkSize
      try {
        this.#onFetched?.({
          from,
          bytes: Math.min(this.#chunkSize, this.#size - from),
          ms,
          outcome: reported,
        })
      } catch {
        // The recorder is not the window's business: what it throws mustn't
        // stop the window, nor become an unhandled rejection in the API.
      }
    }
  }
}

/** A session's window of a version, the reads of it still open, and when it last had activity. */
interface Followed {
  ahead: ReadAhead
  /** Reads of the window that have begun and are not over. */
  open: number
  /** When a read of it last began or ended. */
  activeAt: number
}

/**
 * The windows of the API's stream sessions (DESIGN.md §6.2): one for each
 * session and version, made when a read of it first begins and fed by every
 * read of the session as it sends, so the chunks after what a stream has sent
 * are fetched across its requests. It runs the fetches through `prefetch`, which
 * never rejects.
 */
export class ReadAheads {
  readonly #prefetch: (
    version: ReadableVersion,
    index: number,
    signal: AbortSignal,
  ) => Promise<PrefetchOutcome>
  readonly #note: ((sessionId: string, fetch: AheadFetch) => void) | undefined
  readonly #now: () => number
  readonly #windows = new Map<string, Followed>()
  #stopped = false

  constructor(options: {
    prefetch: (
      version: ReadableVersion,
      index: number,
      signal: AbortSignal,
    ) => Promise<PrefetchOutcome>
    /** Told of each fetch that ends, with the ID of the session whose window made it, for its log (§16). */
    note?: (sessionId: string, fetch: AheadFetch) => void
    now?: () => number
  }) {
    this.#prefetch = options.prefetch
    this.#note = options.note
    this.#now = options.now ?? (() => performance.now())
  }

  /** Windows held, for tests. */
  get size(): number {
    return this.#windows.size
  }

  /**
   * The window of a session's reads of a version, made at its first read, for a
   * read that is beginning: call `done` once it is over, which counts it off
   * (once, however often it is called). Keyed by session and version, so a play
   * whose file is replaced mid-play gets a window of its own for the new
   * version. A window is forgotten, and stopped, only when no read of it is
   * open, nothing is under way, and it has had no read begin or end and nothing
   * reported for `SESSION_IDLE_MS`, as a stream session lasts while a read of
   * it runs: a player paused for minutes keeps its request open and sends
   * nothing, and reads ahead again when it plays on. Windows are forgotten here,
   * when the next is asked for.
   */
  follow(sessionId: string, version: ReadableVersion): { ahead: ReadAhead; done: () => void } {
    const now = this.#now()
    this.#forgetIdle(now)
    const key = `${sessionId}|${version.version_id}`
    let held = this.#windows.get(key)
    if (!held) {
      const ahead = new ReadAhead({
        size: version.size_bytes,
        chunkSize: version.chunk_size,
        chunkCount: version.chunk_count,
        prefetch: (index, signal) => this.#prefetch(version, index, signal),
        onFetched: (fetch) => {
          this.#note?.(sessionId, fetch)
        },
        now: this.#now,
      })
      // A read that begins as the API closes gets a window that fetches nothing.
      if (this.#stopped) {
        ahead.stop()
        return { ahead, done: () => undefined }
      }
      held = { ahead, open: 0, activeAt: now }
      this.#windows.set(key, held)
    }
    const entry = held
    entry.open += 1
    entry.activeAt = now
    let over = false
    return {
      ahead: entry.ahead,
      done: () => {
        if (over) return
        over = true
        entry.open -= 1
        entry.activeAt = this.#now()
      },
    }
  }

  /** Stops every window, aborting the fetches under way: the API is closing. */
  stop(): void {
    this.#stopped = true
    for (const { ahead } of this.#windows.values()) ahead.stop()
    this.#windows.clear()
  }

  #forgetIdle(now: number): void {
    for (const [key, { ahead, open, activeAt }] of this.#windows) {
      if (open > 0 || ahead.fetching.length > 0) continue
      if (now - Math.max(activeAt, ahead.lastReachedAt) <= SESSION_IDLE_MS) continue
      ahead.stop()
      this.#windows.delete(key)
    }
  }
}
