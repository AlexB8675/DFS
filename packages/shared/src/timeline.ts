import { z } from 'zod'

// A video play's timeline (DESIGN.md §16): what the page, the engine and the
// server saw of one play, as events in order, so a slow or failed play can be
// read afterwards. The page sends them in batches and the API takes them only
// within these bounds. The union only grows: later steps add their own event
// types, and an older page's batches stay valid.

/** Events in one batch. */
export const TIMELINE_MAX_EVENTS = 2000
/** A batch's body, the route's limit; the page sends at most 32 KiB. */
export const TIMELINE_MAX_BATCH_BYTES = 64 * 1024
/** One timeline's stored events. */
export const TIMELINE_MAX_BYTES = 16 * 1024 * 1024
/** The latest `t` an event may have, milliseconds after the play's start. */
export const TIMELINE_MAX_MS = 7 * 24 * 60 * 60 * 1000

/** Milliseconds, from the play's start or as a duration. */
const ms = z.number().int().min(0).max(TIMELINE_MAX_MS)
/** Seconds of video. */
const seconds = z.number().min(0).max(1e7)
/** Bytes, and offsets into a file. */
const offset = z.number().int().min(0).max(1e13)
/** Frames, request IDs and the like. */
const count = z.number().int().min(0).max(1e9)
const readyState = z.number().int().min(0).max(4)
const track = z.enum(['video', 'audio'])
/**
 * Text up to `max` characters, without U+0000 or an unpaired surrogate:
 * PostgreSQL's jsonb can't store them, so a batch holding one would fail to
 * save and be sent again for good. The page drops such an event, counted,
 * rather than send it.
 */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes('\u0000') && value.isWellFormed(), {
      message: 'Text can’t hold U+0000 or half a surrogate pair',
    })

/** What `navigator.connection` said, where the browser has it. */
export const timelineConnectionSchema = z.object({
  effectiveType: text(10).nullable(),
  downlinkMbps: z.number().min(0).max(1e6).nullable(),
  rttMs: z.number().min(0).max(1e6).nullable(),
  saveData: z.boolean().nullable(),
})

export type TimelineConnection = z.infer<typeof timelineConnectionSchema>

/**
 * One thing that happened in a play, `t` milliseconds after it started. The
 * page, the engine, the server and the CLI all read this union, so its shapes
 * are fixed (§16).
 */
export const timelineEventSchema = z.discriminatedUnion('type', [
  // The viewer opened the video (t = 0).
  z.object({
    type: z.literal('opened'),
    t: ms,
    device: text(20),
    visible: z.boolean(),
    online: z.boolean(),
    connection: timelineConnectionSchema.nullable(),
  }),
  // `/playback` or the media info answered, or failed.
  z.object({
    type: z.literal('answered'),
    t: ms,
    what: z.enum(['playback', 'media']),
    ok: z.boolean(),
    status: z.number().int().min(100).max(599).nullable(),
  }),
  // `pagePlay` decided where the video plays.
  z.object({
    type: z.literal('decided'),
    t: ms,
    play: z.enum(['buffered', 'native', 'elsewhere']),
    reason: text(20).nullable(),
    codec: text(40).nullable(),
  }),
  // The element or the engine was given a source.
  z.object({
    type: z.literal('source'),
    t: ms,
    versionId: z.uuid(),
    startAt: seconds,
    attempt: z.number().int().min(0).max(1e6),
    player: z.enum(['buffered', 'native']),
  }),
  // The `<video>` fired an event.
  z.object({
    type: z.literal('element'),
    t: ms,
    name: z.enum([
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'canplaythrough',
      'play',
      'playing',
      'pause',
      'waiting',
      'stalled',
      'seeking',
      'seeked',
      'ended',
      'emptied',
    ]),
    at: seconds,
    readyState,
  }),
  // The regular sample.
  z.object({
    type: z.literal('sample'),
    t: ms,
    at: seconds,
    aheadS: seconds,
    ranges: z.array(z.tuple([seconds, seconds])).max(20),
    readyState,
    paused: z.boolean(),
    frames: count,
    dropped: count,
  }),
  // The first frame presented after a start or a seek.
  z.object({
    type: z.literal('picture'),
    t: ms,
    at: seconds,
    after: z.enum(['start', 'seek']),
  }),
  // `online` or `offline`.
  z.object({ type: z.literal('network'), t: ms, online: z.boolean() }),
  // `navigator.connection` changed.
  z.object({ type: z.literal('connection'), t: ms, connection: timelineConnectionSchema }),
  // `visibilitychange`.
  z.object({ type: z.literal('visibility'), t: ms, hidden: z.boolean() }),
  // Any failure.
  z.object({
    type: z.literal('error'),
    t: ms,
    from: z.enum(['element', 'engine', 'page']),
    code: z.number().int().min(0).max(1e6).nullable(),
    message: text(300),
  }),
  // The engine opened a read.
  z.object({
    type: z.literal('request'),
    t: ms,
    id: count,
    from: offset,
    to: offset.nullable(),
  }),
  // The read's first bytes came.
  z.object({ type: z.literal('firstByte'), t: ms, id: count }),
  // The read ended.
  z.object({
    type: z.literal('requestEnd'),
    t: ms,
    id: count,
    bytes: offset,
    outcome: z.enum(['done', 'aborted', 'failed']),
    message: text(300).nullable(),
  }),
  // A segment was appended.
  z.object({ type: z.literal('append'), t: ms, track, bytes: offset }),
  // Played data was removed.
  z.object({ type: z.literal('remove'), t: ms, track, before: seconds }),
  // The engine began or ended holding.
  z.object({
    type: z.literal('hold'),
    t: ms,
    on: z.boolean(),
    reason: text(20).nullable(),
    aheadS: seconds,
    targetS: seconds,
  }),
  // A quota error.
  z.object({ type: z.literal('quota'), t: ms, track, pendingBytes: count }),
  // The engine reopens a read after a failure.
  z.object({
    type: z.literal('retry'),
    t: ms,
    attempt: z.number().int().min(1).max(1e6),
    delayMs: ms,
    offset,
  }),
  // The engine starts reading at a new place.
  z.object({
    type: z.literal('restart'),
    t: ms,
    offset,
    reason: z.enum(['start', 'seek']),
  }),
  // The engine's phase changed.
  z.object({
    type: z.literal('phase'),
    t: ms,
    phase: z.enum(['opening', 'buffering', 'ended', 'failed']),
  }),
  // The page lost events to its size cap, or the schema refused some: either
  // may be 0.
  z.object({ type: z.literal('dropped'), t: ms, events: count, invalid: count }),
  // The play ended: the view closed or moved on.
  z.object({ type: z.literal('closed'), t: ms }),
])

export type TimelineEvent = z.infer<typeof timelineEventSchema>

/** An event without its `t`, which the recorder stamps. */
export type TimelineEventInput = TimelineEvent extends infer E
  ? E extends unknown
    ? Omit<E, 't'>
    : never
  : never

/**
 * `POST …/timeline`: some of a play's events, in order (§16). The page sends
 * them as they come and when the play ends; `seq` numbers the batches so the
 * server can keep them in order and take a resent one once.
 */
export const timelineBatchSchema = z.object({
  playId: z.uuid(),
  versionId: z.uuid(),
  seq: z.number().int().min(0).max(100_000),
  /** The page's `Date.now()` at t = 0, for people to read. */
  startedAt: z.number().int().min(0),
  /**
   * Milliseconds since t = 0 when the batch was sent, on the page's monotonic
   * clock: the reader lines the server's clock up with the play by it.
   */
  sentAt: ms,
  events: z.array(timelineEventSchema).min(1).max(TIMELINE_MAX_EVENTS),
})

export type TimelineBatch = z.infer<typeof timelineBatchSchema>

// What the API writes into a play's timeline itself. These are types only: it
// writes them, so validating them costs nothing.

/** Bytes a read took from one source, and how long it waited for them. */
export interface SourceFigures {
  bytes: number
  waitMs: number
}

/** The API answered a read of the video (§16). */
export interface ServedEvent {
  type: 'served'
  t: number
  from: number
  to: number
  status: 200 | 206
  bytes: number
  finished: boolean
  failed: boolean
  firstByteMs: number | null
  totalMs: number
  sources: { staging: SourceFigures; cache: SourceFigures; discord: SourceFigures }
  clientMs: number
  seek: boolean
  gapMs: number | null
}

/** An event of a stream session's own log: the server writes `invalid: 0`. */
export type StreamEvent = ServedEvent | Extract<TimelineEvent, { type: 'dropped' }>
