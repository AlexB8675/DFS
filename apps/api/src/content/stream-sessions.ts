import { randomUUID } from 'node:crypto'
import type { AppendOutcome, TimelineOwner } from '@dfs/db'
import { TIMELINE_MAX_EVENTS, type ServedEvent, type StreamEvent } from '@dfs/shared'
import type { ReadSources } from './reader.ts'

// Stream sessions (DESIGN.md §6.2, §16): a player's range reads of a file,
// grouped. A page that names its play (`?play=`) groups all its reads by that
// ID; any other player's by link or user, version, address and user agent. A
// session is made of reads that follow one another, and ends after
// `SESSION_IDLE_MS` without one. Each read becomes a `served` event when its
// response closes, and what a session has collected is written to the
// timeline store every `FLUSH_EVERY_MS` and when the API stops, so a slow play
// can be read afterwards from the server's side as well as the page's.

/** A session with no read running and none for this long has ended. */
export const SESSION_IDLE_MS = 120_000
/** How often what the sessions collected is written. */
export const FLUSH_EVERY_MS = 5000
/** A session's events waiting to be written; past this, the oldest are dropped, counted. */
export const MAX_PENDING_EVENTS = 5000
/** Where a session's reads stopped, kept to tell a seek from a read that carries on: the latest. */
const MAX_STOPS = 1000

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
  /** Grows as the response sends. */
  sent: { readonly bytes: number }
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
  /** Where closed requests stopped (`from` + the bytes they sent), oldest first. */
  stops: Set<number>
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
  #flushing: Promise<void> = Promise.resolve()

  constructor(options: {
    write: SessionWriter
    log: { warn(details: object, message: string): void }
    now?: () => number
    wallNow?: () => number
  }) {
    this.#write = options.write
    this.#log = options.log
    this.#now = options.now ?? (() => performance.now())
    this.#wallNow = options.wallNow ?? (() => Date.now())
  }

  /**
   * Joins the request to its session, or begins one; call `close` when its
   * response closes. `sent` is the request's live count of bytes sent so far
   * (`sendFile` passes its `SendStats`), which another request opening meanwhile
   * reads to tell whether it carries on from here.
   */
  open(
    request: StreamRequest,
    sent: { readonly bytes: number },
  ): { sessionId: string; close: (result: ServedResult) => void } {
    const openedAt = this.#now()
    const session = this.#join(request, openedAt)
    session.address = request.address
    session.lastActivity = openedAt

    // A read is a seek unless it carries on from where another stopped, or has got to. What it
    // asked for (`to`) says nothing: players ask for `bytes=X-`, which runs to the file's end.
    let carriesOn = session.stops.has(request.from)
    for (const other of session.running) {
      if (other.from + other.sent.bytes === request.from) carriesOn = true
    }
    const seek = session.requests > 0 && !carriesOn
    const gapMs =
      session.running.size === 0 && session.lastClosedAt !== null
        ? Math.round(openedAt - session.lastClosedAt)
        : null
    session.requests++
    const running: Running = { from: request.from, sent }
    session.running.add(running)

    let closed = false
    const close = (result: ServedResult): void => {
      if (closed) return
      closed = true
      const closedAt = this.#now()
      session.running.delete(running)
      session.lastClosedAt = closedAt
      session.lastActivity = closedAt
      this.#remember(session, request.from + result.bytes)
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

  /** Flushes every `FLUSH_EVERY_MS`; `stop` flushes everything and ends every session. */
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

  /** The key's session if it is still going, else a new one. */
  #join(request: StreamRequest, now: number): Session {
    // A play ID comes from the page, so it is not trusted alone: another reader giving the same
    // one must not join this reader's session, and have their reads logged under it.
    const reader = `${request.via}|${request.userId ?? request.shareId ?? ''}`
    const key =
      request.playId === null
        ? `${reader}|${request.versionId}|${request.address}|${request.userAgent ?? ''}`
        : `play:${request.playId}|${reader}`
    const existing = this.#byKey.get(key)
    if (
      existing &&
      (existing.running.size > 0 ||
        (existing.lastClosedAt !== null && now - existing.lastClosedAt <= SESSION_IDLE_MS))
    ) {
      return existing
    }
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
      stops: new Set(),
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

  #remember(session: Session, position: number): void {
    // Seen again, it is the latest: the oldest go first.
    session.stops.delete(position)
    session.stops.add(position)
    if (session.stops.size > MAX_STOPS) {
      const [oldest] = session.stops
      if (oldest !== undefined) session.stops.delete(oldest)
    }
  }

  async #flushAll(): Promise<void> {
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
          // timeout in turn. Every batch is kept, and the next flush tries again.
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

function roundedWait(figures: { bytes: number; waitMs: number }): {
  bytes: number
  waitMs: number
} {
  return { bytes: figures.bytes, waitMs: Math.round(figures.waitMs) }
}
