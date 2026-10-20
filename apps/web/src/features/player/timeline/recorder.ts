import {
  TIMELINE_MAX_EVENTS,
  timelineEventSchema,
  type TimelineBatch,
  type TimelineEvent,
  type TimelineEventInput,
} from '@dfs/shared'
import { ApiError, apiFetch } from '@/lib/api/client'

// A play's timeline as the page keeps it (§10.4, §16): the events of one
// viewing of a video, each stamped in milliseconds since the viewer opened it,
// checked against the shared schema and sent to the API in numbered batches,
// every 5 s and at once past 16 KiB. The last goes with `keepalive` as the page
// hides or leaves, which the browser lets outlive it. A batch that failed to
// send goes again under its number, so the server takes it once. Batches don't
// wait for the version: a play that ends before the page knows it (the viewer
// left, or `/playback` failed) still leaves its trail, naming no version, and
// the API takes the file's served one. The recorder stops at the first
// refusal: a link that ended answers 404 or 410, and every answer would count
// against the viewer's address under the guess limit (D46).

/** How often what is kept goes, while there is something. */
const FLUSH_EVERY_MS = 5000
/** What is kept goes at once when it reaches this. */
const FLUSH_AT_BYTES = 16 * 1024
/** One batch's events, by their JSON; the API takes 64 KiB, and a keepalive request shares its budget. */
const BATCH_MAX_BYTES = 32 * 1024
/** The newest events sent with `keepalive`, under the browser's 64 KiB budget, which the play report shares at `pagehide`. */
const KEEPALIVE_MAX_BYTES = 24 * 1024
/** What an outage may leave held; past it the oldest events are dropped, counted. */
const MAX_KEPT_BYTES = 256 * 1024

/** What a browser may leave out of `crypto`, which the DOM library types as always there. */
type OptionalCrypto = Partial<Pick<Crypto, 'randomUUID'>>

/**
 * A new play's ID, which can't fail: logging must never stop a video, and the
 * video waits for its timeline. `crypto.randomUUID` exists only in a secure
 * context (https, localhost) and is missing elsewhere, as on a development
 * server opened by a LAN address; `crypto.getRandomValues` works anywhere, so
 * then an RFC 4122 version 4 UUID is made of its bytes.
 */
export function newPlayId(): string {
  const optional: OptionalCrypto = crypto
  if (typeof optional.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

/** What a send came to: it got there, it may go again, or the API turned it away for good. */
export type SendResult = 'sent' | 'retry' | 'refused'
export type TimelineSend = (batch: TimelineBatch, keepalive: boolean) => Promise<SendResult>

const encoder = new TextEncoder()

interface Kept {
  event: TimelineEvent
  /** The UTF-8 bytes of its JSON. */
  bytes: number
}

/** A batch cut from what was kept: its number and its events are fixed, whatever happens to its send. */
interface Cut {
  seq: number
  events: TimelineEvent[]
  bytes: number
}

function sizeOf(event: TimelineEvent): number {
  return encoder.encode(JSON.stringify(event)).length
}

/** How many of `items[from..to)` go in one batch of at most `limit` bytes (always at least one). */
function fit(items: readonly Kept[], from: number, to: number, limit: number): number {
  let bytes = 0
  let end = from
  while (end < to && end - from < TIMELINE_MAX_EVENTS) {
    const item = items[end]
    if (item === undefined || (end > from && bytes + item.bytes > limit)) break
    bytes += item.bytes
    end += 1
  }
  return end
}

export class Timeline {
  readonly playId: string
  private readonly send: TimelineSend
  private readonly now: () => number
  private readonly start: number
  private readonly startedAt: number
  private versionId: string | null = null
  private kept: Kept[] = []
  private keptBytes = 0
  /** Batches already cut that came back `retry`, by seq. */
  private pending: Cut[] = []
  private nextSeq = 0
  /** Events dropped past the size cap, and events the schema refused, since the last batch said so. */
  private lost = 0
  private invalid = 0
  /** The ordinary send loop under way, if any: one at a time. */
  private inFlight: Promise<void> | null = null
  private refused = false
  private closed = false
  private timer: ReturnType<typeof setInterval> | null

  constructor(options: {
    playId: string
    send: TimelineSend
    now?: () => number
    wallNow?: () => number
  }) {
    this.playId = options.playId
    this.send = options.send
    this.now = options.now ?? (() => performance.now())
    this.start = this.now()
    this.startedAt = (options.wallNow ?? (() => Date.now()))()
    this.timer = setInterval(() => {
      void this.flush()
    }, FLUSH_EVERY_MS)
  }

  /** Stamps `t` and keeps the event; one the schema refuses is dropped and counted. */
  record(event: TimelineEventInput): void {
    this.keep(event)
    // A batch waiting to go again waits for the timer, so an outage isn't retried at every event.
    if (this.keptBytes >= FLUSH_AT_BYTES && this.pending.length === 0) void this.flush()
  }

  /** Batches name this version from now on; before, they carry null and the API takes the file’s served version. */
  setVersion(versionId: string): void {
    this.versionId = versionId
  }

  /** Sends what is kept; with `keepalive`, as the page hides or leaves. */
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.refused) return
    if (options.keepalive === true) {
      await this.flushKeepalive()
      return
    }
    // One ordinary send at a time: the timer's next tick goes on from here.
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = null
    })
    await this.inFlight
  }

  /** Records `closed`, flushes with keepalive, and stops its timer; later records are ignored. */
  close(): void {
    if (this.closed) return
    // Not through `record`: its at-once flush would send the last events without keepalive.
    this.keep({ type: 'closed' })
    this.closed = true
    void this.flush({ keepalive: true })
    this.stopTimer()
  }

  private keep(event: TimelineEventInput): void {
    if (this.closed || this.refused) return
    const parsed = timelineEventSchema.safeParse({ ...event, t: this.elapsed() })
    if (!parsed.success) {
      this.invalid += 1
      return
    }
    const bytes = sizeOf(parsed.data)
    this.kept.push({ event: parsed.data, bytes })
    this.keptBytes += bytes
    this.trim()
  }

  private elapsed(): number {
    return Math.max(0, Math.round(this.now() - this.start))
  }

  private stopTimer(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Events held and not yet sent, in batches or not. */
  private heldBytes(): number {
    return this.pending.reduce((sum, batch) => sum + batch.bytes, this.keptBytes)
  }

  /**
   * Keeps what is held within `MAX_KEPT_BYTES` by dropping the oldest first:
   * the batches that failed to send, whole (their numbers are left unused,
   * which the server takes), then kept events. The next batch says how many.
   */
  private trim(): void {
    while (this.heldBytes() > MAX_KEPT_BYTES) {
      const batch = this.pending.shift()
      if (batch !== undefined) {
        for (const event of batch.events) this.countLost(event)
        continue
      }
      const oldest = this.kept.shift()
      if (oldest === undefined) return
      this.keptBytes -= oldest.bytes
      this.countLost(oldest.event)
    }
  }

  /** Counts a dropped event as lost; a `dropped` event stands for the events it counted, and passes those on. */
  private countLost(event: TimelineEvent): void {
    if (event.type === 'dropped') {
      this.lost += event.events
      this.invalid += event.invalid
    } else this.lost += 1
  }

  /** The `dropped` event for what was lost or refused since the last batch said so, or `null`; the counts start again. */
  private takeCounts(): Kept | null {
    if (this.lost === 0 && this.invalid === 0) return null
    const event: TimelineEvent = {
      type: 'dropped',
      t: this.elapsed(),
      events: this.lost,
      invalid: this.invalid,
    }
    this.lost = 0
    this.invalid = 0
    return { event, bytes: sizeOf(event) }
  }

  /** Puts the count of what was lost or refused first among the kept events, as the next batch's start. */
  private foldCounts(): void {
    const counts = this.takeCounts()
    if (counts === null) return
    this.kept.unshift(counts)
    this.keptBytes += counts.bytes
  }

  private cut(items: readonly Kept[]): Cut {
    return {
      seq: this.nextSeq++,
      events: items.map((item) => item.event),
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    }
  }

  /** The next batch of what is kept, oldest first, or `null` if nothing is. */
  private cutNext(): Cut | null {
    this.foldCounts()
    if (this.kept.length === 0) return null
    const taken = this.kept.splice(0, fit(this.kept, 0, this.kept.length, BATCH_MAX_BYTES))
    const batch = this.cut(taken)
    this.keptBytes -= batch.bytes
    return batch
  }

  /** Sends one batch and acts on the answer; `retry` keeps the batch for a later flush. */
  private async dispatch(batch: Cut, keepalive: boolean): Promise<SendResult> {
    let result: SendResult
    try {
      result = await this.send(
        {
          playId: this.playId,
          versionId: this.versionId,
          seq: batch.seq,
          startedAt: this.startedAt,
          sentAt: this.elapsed(),
          events: batch.events,
        },
        keepalive,
      )
    } catch {
      result = 'retry'
    }
    if (this.refused) return result
    if (result === 'refused') this.refuse()
    else if (result === 'retry') {
      const at = this.pending.findIndex((other) => other.seq > batch.seq)
      this.pending.splice(at < 0 ? this.pending.length : at, 0, batch)
      this.trim()
    }
    return result
  }

  /** Sends the failed batches, then what is kept, a batch at a time, until a send fails or nothing is left. */
  private async drain(): Promise<void> {
    while (!this.refused) {
      const batch = this.pending.shift() ?? this.cutNext()
      if (batch === null) return
      if ((await this.dispatch(batch, false)) !== 'sent') return
    }
  }

  /**
   * Sends it all now, without waiting for a send in flight: the failed batches
   * and the older kept events as ordinary batches, and the newest events up to
   * `KEEPALIVE_MAX_BYTES` as one `keepalive` batch with the highest number.
   * The count of what was lost or refused goes in that batch, the one that
   * outlives the page, and counts toward its size.
   */
  private async flushKeepalive(): Promise<void> {
    const sends: Promise<SendResult>[] = []
    for (const batch of this.pending.splice(0)) sends.push(this.dispatch(batch, false))

    const counts = this.takeCounts()
    const all = this.kept
    this.kept = []
    this.keptBytes = 0
    // The tail is what goes with keepalive: the newest events that fit beside the count.
    let tail = all.length
    let tailBytes = counts?.bytes ?? 0
    let tailEvents = counts === null ? 0 : 1
    while (tail > 0 && tailEvents < TIMELINE_MAX_EVENTS) {
      const item = all[tail - 1]
      if (item === undefined || tailBytes + item.bytes > KEEPALIVE_MAX_BYTES) break
      tailBytes += item.bytes
      tailEvents += 1
      tail -= 1
    }
    let from = 0
    while (from < tail) {
      const to = fit(all, from, tail, BATCH_MAX_BYTES)
      sends.push(this.dispatch(this.cut(all.slice(from, to)), false))
      from = to
    }
    const last = counts === null ? all.slice(tail) : [counts, ...all.slice(tail)]
    if (last.length > 0) sends.push(this.dispatch(this.cut(last), true))
    await Promise.all(sends)
  }

  /** A refusal ends it: nothing more is sent, and what was held is let go. */
  private refuse(): void {
    this.refused = true
    this.stopTimer()
    this.kept = []
    this.keptBytes = 0
    this.pending = []
    this.lost = 0
    this.invalid = 0
  }
}

/** Sends a batch to `{base}/timeline`: 2xx is sent; a network failure, 408, 429 or 5xx is retry; any other 4xx is refused. */
export function timelineSender(base: string): TimelineSend {
  return async (batch, keepalive) => {
    try {
      await apiFetch(`${base}/timeline`, { method: 'POST', json: batch, keepalive })
      return 'sent'
    } catch (error) {
      if (error instanceof ApiError) {
        const again = error.status === 408 || error.status === 429 || error.status >= 500
        return again ? 'retry' : 'refused'
      }
      return 'retry'
    }
  }
}

/** `text` cut to `max` UTF-16 units without splitting a surrogate pair, with U+0000 and lone surrogates removed: what a timeline's text fields take (§16). */
export function clipText(text: string, max = 300): string {
  let clipped = ''
  // Iterating a string goes by code point, and a lone surrogate comes alone.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0 || (char.length === 1 && code >= 0xd800 && code <= 0xdfff)) continue
    if (clipped.length + char.length > max) break
    clipped += char
  }
  return clipped
}
