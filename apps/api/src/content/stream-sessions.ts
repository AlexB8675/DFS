import { randomUUID } from 'node:crypto'
import type { AppendOutcome, TimelineOwner } from '@dfs/db'
import { TIMELINE_MAX_EVENTS, type ServedEvent, type StreamEvent } from '@dfs/shared'
import { addressKey, RateLimiter } from '../auth/rate-limit.ts'
import type { ReadSources } from './reader.ts'

// Stream sessions (DESIGN.md §6.2, §16): a player's range reads of a file,
// grouped. A page that names its play (`?play=`) groups all its reads by that
// ID; any other player's by link or user, version, address and user agent. A
// session is made of reads that follow one another, and ends after
// `SESSION_IDLE_MS` without one. Each read becomes a `served` event when its
// response closes, and what a session has collected is written to the
// timeline store every `FLUSH_EVERY_MS` and when the API stops, so a slow play
// can be read afterwards from the server's side as well as the page's. The
// content routes of links and stream links have no request limiter, so how many
// sessions are held, and how many one reader may begin, are bounded here: past
// either, a read is served as always but not logged.

/** A session with no read running and none for this long has ended. */
export const SESSION_IDLE_MS = 120_000
/** How often what the sessions collected is written. */
export const FLUSH_EVERY_MS = 5000
/** A session's events waiting to be written; past this, the oldest are dropped, counted. */
export const MAX_PENDING_EVENTS = 5000
/** The ranges a session's reads served, kept to tell a seek from a read that carries on, and how far back one starts: the latest. */
const MAX_STOPS = 1000
/** Sessions held in memory at once, each a timeline once written; past it, no new one begins. */
export const MAX_LIVE_SESSIONS = 2000
/** The sessions one reader (a user, or an address) may begin in a window; joining isn't counted. */
export const NEW_SESSIONS_PER_READER = 120
const NEW_SESSIONS_WINDOW_MS = 10 * 60_000

export interface StreamRequest {
  via: 'drive' | 'link' | 'stream'
  nodeId: string
  versionId: string
  userId: string | null
  shareId: string | null
  /** The page's play, from `?play=`; null for other players. */
  playId: string | null
  address: string
  userAgent: string | null
  /** The first byte asked for. */
  from: number
  /** The last byte asked for; an open-ended range runs to the file's end. */
  to: number
  status: 200 | 206
}

export interface ServedResult {
  bytes: number
  finished: boolean
  failed: boolean
  firstByteMs: number | null
  totalMs: number
  sources: ReadSources
  clientMs: number
}

export type SessionWriter = (
  id: string,
  owner: TimelineOwner,
  batch: { seq: number; events: readonly StreamEvent[]; address: string },
) => Promise<AppendOutcome>

interface Running {
  from: number
  /** The read's figures so far; its `bytes` grows as the response sends. */
  progress: () => ServedResult
  /** Records the read as closed with these figures; once only. */
  end: (result: ServedResult) => void
}

/** The bytes a read sent: `start` to `end`, the end not included. */
interface Served {
  start: number
  end: number
}

interface Batch {
  seq: number
  events: StreamEvent[]
}

interface Session {
  id: string
  key: string
  owner: TimelineOwner
  /** `now()` when it began, which each event's `t` counts from. */
  startedAt: number
  /** The latest request's, which each batch is written with. */
  address: string
  requests: number
  running: Set<Running>
  /** What closed requests sent (`from` to `from` + their bytes), by their range, oldest first. */
  sent: Map<string, Served>
  lastClosedAt: number | null
  /** The last open or close. */
  lastActivity: number
  /** Events not in a batch yet. */
  pending: ServedEvent[]
  /** How many of the oldest `pending` dropped; the next batch begins by saying so. */
  dropped: number
  nextSeq: number
  /** A batch whose write failed, sent again as it was until the store answers (a lost answer may mean it is there). */
  unsent: Batch | null
  /** The store refused it: it collects nothing more. */
  stopped: boolean
}

export class StreamSessions {
  readonly #write: SessionWriter
  readonly #log: { warn(details: object, message: string): void }
  readonly #now: () => number
  readonly #wallNow: () => number
  /** Every session not forgotten yet, including ones whose key has a newer. */
  readonly #sessions = new Set<Session>()
  /** The latest session of each key, which a request may join. */
  readonly #byKey = new Map<string, Session>()
  readonly #maxLive: number
  readonly #newPerReader: RateLimiter
  /** Reads served without a session since the last flush, because of the two limits above. */
  #skipped = 0
  #flushing: Promise<void> = Promise.resolve()

  constructor(options: {
    write: SessionWriter
    log: { warn(details: object, message: string): void }
    now?: () => number
    wallNow?: () => number
    /** Sessions held at once; past it, a read that would begin one isn't logged. */
    maxLive?: number
    /** Counts the sessions each reader begins; one it makes wait isn't logged. */
    newPerReader?: RateLimiter
  }) {
    this.#write = options.write
    this.#log = options.log
    this.#now = options.now ?? (() => performance.now())
    this.#wallNow = options.wallNow ?? (() => Date.now())
    this.#maxLive = options.maxLive ?? MAX_LIVE_SESSIONS
    this.#newPerReader =
      options.newPerReader ?? new RateLimiter(NEW_SESSIONS_PER_READER, NEW_SESSIONS_WINDOW_MS)
  }

  /** How many sessions are held, ended ones until they are written: for tests and the graphs. */
  get live(): number {
    return this.#sessions.size
  }

  /**
   * Joins the request to its session, or begins one; call `close` when its
   * response closes. `progress` gives the request's figures so far (`sendFile`
   * builds them from its `SendStats`): another request opening meanwhile reads
   * its `bytes` to tell whether it carries on from here, and stopping the
   * sessions with the request still open writes it as it stands.
   * A request that would begin a session while too many are held, or after
   * its reader has begun too many, is served all the same but has none: its
   * `sessionId` is null and its `close` writes nothing.
   */
  open(
    request: StreamRequest,
    progress: () => ServedResult,
  ): { sessionId: string | null; close: (result: ServedResult) => void } {
    const openedAt = this.#now()
    const session = this.#join(request, openedAt)
    if (!session) {
      this.#skipped++
      return { sessionId: null, close: () => undefined }
    }
    session.address = request.address
    session.lastActivity = openedAt

    // A read is a seek unless it carries on from where another stopped, or has got to. What it
    // asked for (`to`) says nothing: players ask for `bytes=X-`, which runs to the file's end.
    // A seek that starts inside what was served says how far before its end: a client that
    // reconnects at what it actually received starts a little behind what the server sent.
    let carriesOn = false
    let rewind: number | null = null
    for (const { start, end } of servedRanges(session)) {
      if (end === request.from) carriesOn = true
      else if (start <= request.from && request.from < end) {
        if (rewind === null || end - request.from < rewind) rewind = end - request.from
      }
    }
    const seek = session.requests > 0 && !carriesOn
    const rewindBytes = seek ? rewind : null
    const gapMs =
      session.running.size === 0 && session.lastClosedAt !== null
        ? Math.round(openedAt - session.lastClosedAt)
        : null
    session.requests++
    const running: Running = {
      from: request.from,
      progress,
      end: (result) => {
        close(result)
      },
    }
    session.running.add(running)

    let closed = false
    const close = (result: ServedResult): void => {
      if (closed) return
      closed = true
      const closedAt = this.#now()
      session.running.delete(running)
      session.lastClosedAt = closedAt
      session.lastActivity = closedAt
      this.#remember(session, { start: request.from, end: request.from + result.bytes })
      if (session.stopped) return
      session.pending.push({
        type: 'served',
        t: Math.round(openedAt - session.startedAt),
        address: request.address,
        from: request.from,
        to: request.to,
        status: request.status,
        bytes: result.bytes,
        finished: result.finished,
        failed: result.failed,
        firstByteMs: result.firstByteMs === null ? null : Math.round(result.firstByteMs),
        totalMs: Math.round(result.totalMs),
        sources: {
          staging: roundedWait(result.sources.staging),
          cache: roundedWait(result.sources.cache),
          discord: roundedWait(result.sources.discord),
        },
        clientMs: Math.round(result.clientMs),
        seek,
        rewindBytes,
        gapMs,
      })
      if (session.pending.length > MAX_PENDING_EVENTS) {
        const excess = session.pending.length - MAX_PENDING_EVENTS
        session.pending.splice(0, excess)
        session.dropped += excess
      }
    }
    return { sessionId: session.id, close }
  }

  /** Writes what each session collected; forgets sessions idle past `SESSION_IDLE_MS`. */
  flush(): Promise<void> {
    // One at a time: two flushes of a session would send its batches twice over.
    const run = this.#flushing.then(() => this.#flushAll())
    this.#flushing = run.catch(() => undefined)
    return run
  }

  /**
   * Flushes every `FLUSH_EVERY_MS`. `stop` records the reads still running as
   * they stand, flushes everything and ends every session. A video read in
   * play is almost always still open when the API begins to close, as its
   * client sets the pace, and the process exits after its grace without waiting
   * for it: only a read recorded now would be written at all.
   */
  start(): { stop: () => Promise<void> } {
    let timer: NodeJS.Timeout | null = null
    let running: Promise<void> = Promise.resolve()
    let stopped = false
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(() => {
        running = this.#flushQuietly().finally(schedule)
      }, FLUSH_EVERY_MS)
      timer.unref()
    }
    schedule()
    return {
      stop: async () => {
        stopped = true
        if (timer) clearTimeout(timer)
        await running
        for (const session of this.#sessions) {
          for (const read of [...session.running]) read.end({ ...read.progress(), finished: false })
        }
        await this.#flushQuietly()
        this.#sessions.clear()
        this.#byKey.clear()
      },
    }
  }

  /** A flush whose failure is logged, not thrown: a timer's tick must not end the process, nor a stop. */
  #flushQuietly(): Promise<void> {
    return this.flush().catch((error: unknown) => {
      this.#log.warn({ err: error }, 'could not save stream sessions; trying again')
    })
  }

  /** The key's session if it is still going, else a new one; null if none may begin. */
  #join(request: StreamRequest, now: number): Session | null {
    // A play ID comes from the page, so it is not trusted alone: another reader giving the same
    // one must not join this reader's session, and have their reads logged under it; nor may
    // another file's, as a play is one file's view.
    const reader = `${request.via}|${request.userId ?? request.shareId ?? ''}`
    const key =
      request.playId === null
        ? `${reader}|${request.versionId}|${request.address}|${request.userAgent ?? ''}`
        : `play:${request.playId}|${request.nodeId}|${reader}`
    const existing = this.#byKey.get(key)
    if (
      existing &&
      (existing.running.size > 0 ||
        (existing.lastClosedAt !== null && now - existing.lastClosedAt <= SESSION_IDLE_MS))
    ) {
      return existing
    }
    // A reader is a signed-in user, whatever their address; else the address of a link or stream.
    const readerKey =
      request.via === 'drive' && request.userId !== null
        ? `user:${request.userId}`
        : addressKey(request.address)
    const wallNow = this.#wallNow()
    if (this.#sessions.size >= this.#maxLive || this.#newPerReader.waitMs(readerKey, wallNow) > 0) {
      return null
    }
    this.#newPerReader.hit(readerKey, wallNow)
    const session: Session = {
      id: randomUUID(),
      key,
      owner: {
        kind: 'stream',
        via: request.via,
        nodeId: request.nodeId,
        versionId: request.versionId,
        userId: request.userId,
        shareId: request.shareId,
        playId: request.playId,
        address: request.address,
        userAgent: request.userAgent,
        clientStartedAt: null,
        startedAt: new Date(this.#wallNow()),
      },
      startedAt: now,
      address: request.address,
      requests: 0,
      running: new Set(),
      sent: new Map(),
      lastClosedAt: null,
      lastActivity: now,
      pending: [],
      dropped: 0,
      nextSeq: 0,
      unsent: null,
      stopped: false,
    }
    this.#sessions.add(session)
    this.#byKey.set(key, session)
    return session
  }

  #remember(session: Session, served: Served): void {
    // Seen again, it is the latest: the oldest go first.
    const key = `${String(served.start)}-${String(served.end)}`
    session.sent.delete(key)
    session.sent.set(key, served)
    if (session.sent.size > MAX_STOPS) {
      const [oldest] = session.sent.keys()
      if (oldest !== undefined) session.sent.delete(oldest)
    }
  }

  async #flushAll(): Promise<void> {
    if (this.#skipped > 0) {
      this.#log.warn({ skipped: this.#skipped }, 'stream reads not logged: too many sessions')
      this.#skipped = 0
    }
    for (const session of [...this.#sessions]) {
      while (!session.stopped) {
        const batch = session.unsent ?? this.#take(session)
        if (!batch) break
        session.unsent = batch
        let outcome: AppendOutcome
        try {
          outcome = await this.#write(session.id, session.owner, {
            seq: batch.seq,
            events: batch.events,
            address: session.address,
          })
        } catch (error) {
          // The run ends here: a store that is down would make every session wait on a connection
          // timeout in turn. Every batch is kept, and the next flush tries again, beginning with
          // the others: a session that always fails goes to the back, so it can't hold them back.
          if (this.#sessions.delete(session)) this.#sessions.add(session)
          this.#log.warn(
            { err: error, sessionId: session.id },
            'could not save a stream session; trying again',
          )
          return
        }
        if (outcome === 'stored' || outcome === 'duplicate') {
          session.unsent = null
        } else {
          this.#log.warn({ sessionId: session.id, outcome }, 'stream session no longer logged')
          session.stopped = true
          session.unsent = null
          session.pending = []
          session.dropped = 0
        }
      }
      this.#forgetIfEnded(session)
    }
  }

  /** The next batch of the session's pending events, at most `TIMELINE_MAX_EVENTS`, or null. */
  #take(session: Session): Batch | null {
    if (session.pending.length === 0) return null
    const events: StreamEvent[] = []
    if (session.dropped > 0) {
      events.push({
        type: 'dropped',
        t: session.pending[0]?.t ?? 0,
        events: session.dropped,
        invalid: 0,
      })
      session.dropped = 0
    }
    events.push(...session.pending.splice(0, TIMELINE_MAX_EVENTS - events.length))
    return { seq: session.nextSeq++, events }
  }

  #forgetIfEnded(session: Session): void {
    if (
      session.pending.length > 0 ||
      session.unsent ||
      session.running.size > 0 ||
      this.#now() - session.lastActivity <= SESSION_IDLE_MS
    ) {
      return
    }
    this.#sessions.delete(session)
    if (this.#byKey.get(session.key) === session) this.#byKey.delete(session.key)
  }
}

/** What the session's reads have sent: the closed ones' ranges, then the running ones' so far. */
function* servedRanges(session: Session): Generator<Served> {
  yield* session.sent.values()
  for (const read of session.running) {
    yield { start: read.from, end: read.from + read.progress().bytes }
  }
}

function roundedWait(figures: { bytes: number; waitMs: number }): {
  bytes: number
  waitMs: number
} {
  return { bytes: figures.bytes, waitMs: Math.round(figures.waitMs) }
}
