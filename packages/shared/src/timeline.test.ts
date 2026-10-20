import { describe, expect, it } from 'vitest'
import { playbackReportSchema } from './media.ts'
import {
  TIMELINE_MAX_EVENTS,
  TIMELINE_MAX_MS,
  timelineBatchSchema,
  timelineEventSchema,
  type TimelineEvent,
} from './timeline.ts'

const versionId = '0198f7a2-1111-7a2b-8c3d-4e5f60718293'
const playId = '0198f7a2-2222-7a2b-8c3d-4e5f60718293'

const connection = { effectiveType: '4g', downlinkMbps: 12.5, rttMs: 60, saveData: false }

/** One valid event of every type the schema names, in the table's order (§16). */
const EXAMPLES: TimelineEvent[] = [
  { type: 'opened', t: 0, device: 'android', visible: true, online: true, connection },
  { type: 'answered', t: 40, what: 'playback', ok: true, status: 200 },
  { type: 'decided', t: 80, play: 'buffered', reason: null, codec: 'hvc1.2.4.L153.B0' },
  { type: 'source', t: 90, versionId, startAt: 0, attempt: 0, player: 'buffered' },
  { type: 'element', t: 100, name: 'loadedmetadata', at: 0, readyState: 1 },
  {
    type: 'sample',
    t: 1000,
    at: 1.5,
    aheadS: 6.25,
    ranges: [
      [0, 7.75],
      [20, 30],
    ],
    readyState: 4,
    paused: false,
    frames: 90,
    dropped: 1,
  },
  { type: 'picture', t: 450, at: 0, after: 'start' },
  { type: 'network', t: 500, online: false },
  { type: 'connection', t: 510, connection: { ...connection, saveData: null } },
  { type: 'visibility', t: 520, hidden: true },
  { type: 'error', t: 530, from: 'engine', code: null, message: 'The read failed' },
  { type: 'request', t: 540, id: 1, from: 0, to: null },
  { type: 'firstByte', t: 560, id: 1 },
  { type: 'requestEnd', t: 900, id: 1, bytes: 1_048_576, outcome: 'done', message: null },
  { type: 'append', t: 910, track: 'video', bytes: 262_144 },
  { type: 'remove', t: 920, track: 'audio', before: 12.5 },
  { type: 'hold', t: 930, on: true, reason: 'start', aheadS: 0.5, targetS: 2 },
  { type: 'quota', t: 940, track: 'video', pendingBytes: 4096 },
  { type: 'retry', t: 950, attempt: 1, delayMs: 500, offset: 1_048_576 },
  { type: 'restart', t: 960, offset: 52_428_800, reason: 'seek' },
  { type: 'phase', t: 970, phase: 'buffering' },
  { type: 'dropped', t: 980, events: 0, invalid: 1 },
  { type: 'closed', t: 2000 },
]

const TYPES = [
  'opened',
  'answered',
  'decided',
  'source',
  'element',
  'sample',
  'picture',
  'network',
  'connection',
  'visibility',
  'error',
  'request',
  'firstByte',
  'requestEnd',
  'append',
  'remove',
  'hold',
  'quota',
  'retry',
  'restart',
  'phase',
  'dropped',
  'closed',
]

function batch(events: unknown[]) {
  return { playId, versionId, seq: 0, startedAt: 1_760_000_000_000, sentAt: 2000, events }
}

describe('timeline events (§16)', () => {
  it('takes one event of every type', () => {
    expect(EXAMPLES.map((e) => e.type)).toEqual(TYPES)
    expect(timelineEventSchema.options.map((o) => o.shape.type.value)).toEqual(TYPES)
    const input = batch(EXAMPLES)
    expect(timelineBatchSchema.parse(input)).toEqual(input)
  })

  it('refuses an unknown type, a time past seven days and a message over 300 characters', () => {
    const closed = { type: 'closed', t: 0 }
    expect(timelineBatchSchema.safeParse(batch([closed])).success).toBe(true)
    expect(timelineBatchSchema.safeParse(batch([{ type: 'exploded', t: 0 }])).success).toBe(false)
    expect(timelineBatchSchema.safeParse(batch([{ ...closed, t: TIMELINE_MAX_MS }])).success).toBe(
      true,
    )
    expect(
      timelineBatchSchema.safeParse(batch([{ ...closed, t: TIMELINE_MAX_MS + 1 }])).success,
    ).toBe(false)
    const error = { type: 'error', t: 0, from: 'page', code: null, message: 'x'.repeat(300) }
    expect(timelineBatchSchema.safeParse(batch([error])).success).toBe(true)
    expect(
      timelineBatchSchema.safeParse(batch([{ ...error, message: 'x'.repeat(301) }])).success,
    ).toBe(false)
  })

  it('refuses text PostgreSQL can’t store', () => {
    const accepted = (message: string) =>
      timelineBatchSchema.safeParse(
        batch([{ type: 'error', t: 0, from: 'page', code: null, message }]),
      ).success
    // jsonb can’t hold U+0000 or an unpaired surrogate.
    expect(accepted('read\u0000failed')).toBe(false)
    expect(accepted('half a pair \ud800')).toBe(false)
    expect(accepted('\udc00 the other half first')).toBe(false)
    expect(accepted('a whole pair \u{1f4fa}, and é')).toBe(true)
  })

  it('refuses a start a Date can’t hold', () => {
    const startingAt = (startedAt: number) =>
      timelineBatchSchema.safeParse({ ...batch([{ type: 'closed', t: 0 }]), startedAt }).success
    // The latest time a Date holds: past it the API's `new Date(startedAt)` is invalid.
    expect(startingAt(8_640_000_000_000_000)).toBe(true)
    expect(startingAt(8_640_000_000_000_001)).toBe(false)
  })

  it('refuses an empty batch and one over 2000 events', () => {
    const closed = { type: 'closed', t: 0 }
    expect(timelineBatchSchema.safeParse(batch([])).success).toBe(false)
    expect(
      timelineBatchSchema.safeParse(
        batch(Array.from({ length: TIMELINE_MAX_EVENTS }, () => closed)),
      ).success,
    ).toBe(true)
    expect(
      timelineBatchSchema.safeParse(
        batch(Array.from({ length: TIMELINE_MAX_EVENTS + 1 }, () => closed)),
      ).success,
    ).toBe(false)
  })
})

describe('the play report names its timeline (§16)', () => {
  const report = {
    versionId,
    outcome: 'played',
    firstFrameMs: 400,
    startMs: 450,
    openMs: 60_000,
    stalls: 0,
    stallMs: 0,
    seeks: 1,
    seekWaitMs: 800,
    frames: 3600,
    droppedFrames: 2,
    arrivalBitsPerSecond: null,
    decoding: null,
    problem: null,
  }

  it("keeps a play report's play ID, and takes one without", () => {
    expect(playbackReportSchema.parse({ ...report, playId }).playId).toBe(playId)
    expect(playbackReportSchema.parse(report).playId).toBeUndefined()
    expect(playbackReportSchema.safeParse({ ...report, playId: 'not-a-uuid' }).success).toBe(false)
  })
})
