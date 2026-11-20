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
  { type: 'store', t: 972, backend: 'memory', capBytes: 268_435_456, reason: 'no-opfs' },
  { type: 'storeFull', t: 974, on: true, storedBytes: 2_147_483_648 },
  {
    type: 'storeLevel',
    t: 976,
    storedBytes: 1_073_741_824,
    aheadBytes: 536_870_912,
    evictedBytes: 0,
  },
  { type: 'seek', t: 978, to: 61.5, inWindow: true, ms: null },
  { type: 'watchdog', t: 979, action: 'gap', at: 12.25, detail: 'stepped over 0.04 s' },
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
  'store',
  'storeFull',
  'storeLevel',
  'seek',
  'watchdog',
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

  it('takes the store’s events, with a disk store’s null reason', () => {
    const disk = { type: 'store', t: 5, backend: 'disk', capBytes: 2_147_483_648, reason: null }
    expect(timelineBatchSchema.parse(batch([disk])).events).toEqual([disk])
    // Every reason the player sends fits; the field is text, so a later one does too.
    for (const reason of ['no-worker', 'no-opfs', 'refused', 'quota', 'disk-error']) {
      expect(timelineEventSchema.safeParse({ ...disk, backend: 'memory', reason }).success).toBe(
        true,
      )
    }
    const full = { type: 'storeFull', t: 6, on: false, storedBytes: 0 }
    expect(timelineEventSchema.parse(full)).toEqual(full)
    const level = { type: 'storeLevel', t: 7, storedBytes: 9, aheadBytes: 5, evictedBytes: 3 }
    expect(timelineEventSchema.parse(level)).toEqual(level)
  })

  it('refuses a store event with a wrong backend, a negative size or a reason over 40 characters', () => {
    const store = { type: 'store', t: 5, backend: 'memory', capBytes: 1024, reason: 'quota' }
    const full = { type: 'storeFull', t: 6, on: true, storedBytes: 1024 }
    const level = { type: 'storeLevel', t: 7, storedBytes: 9, aheadBytes: 5, evictedBytes: 3 }
    const accepted = (event: unknown) => timelineEventSchema.safeParse(event).success
    expect(accepted(store)).toBe(true)
    expect(accepted({ ...store, backend: 'cloud' })).toBe(false)
    expect(accepted({ ...store, capBytes: -1 })).toBe(false)
    expect(accepted({ ...store, capBytes: 1.5 })).toBe(false)
    expect(accepted({ ...store, reason: 'x'.repeat(40) })).toBe(true)
    expect(accepted({ ...store, reason: 'x'.repeat(41) })).toBe(false)
    expect(accepted({ ...store, reason: 'half a pair \ud800' })).toBe(false)
    expect(accepted({ ...store, reason: undefined })).toBe(false)
    expect(accepted(full)).toBe(true)
    expect(accepted({ ...full, on: 'yes' })).toBe(false)
    expect(accepted({ ...full, storedBytes: -1 })).toBe(false)
    expect(accepted(level)).toBe(true)
    expect(accepted({ ...level, storedBytes: -1 })).toBe(false)
    expect(accepted({ ...level, aheadBytes: -1 })).toBe(false)
    expect(accepted({ ...level, evictedBytes: -1 })).toBe(false)
  })

  it('takes a batch that mixes the older events and the store’s', () => {
    const events = [
      { type: 'phase', t: 1, phase: 'opening' },
      { type: 'store', t: 2, backend: 'disk', capBytes: 1_000_000, reason: null },
      { type: 'storeLevel', t: 3, storedBytes: 4, aheadBytes: 4, evictedBytes: 0 },
      { type: 'storeFull', t: 4, on: true, storedBytes: 1_000_000 },
      { type: 'closed', t: 5 },
    ]
    const input = batch(events)
    expect(timelineBatchSchema.parse(input)).toEqual(input)
    // One bad event refuses the batch, as for any other type.
    const bad = { type: 'store', t: 6, backend: 'cloud', capBytes: 0, reason: null }
    expect(timelineBatchSchema.safeParse(batch([...events, bad])).success).toBe(false)
  })

  it('takes the engine’s seeks, with a null time to picture until the picture comes', () => {
    const started = { type: 'seek', t: 5, to: 61.5, inWindow: false, ms: null }
    expect(timelineBatchSchema.parse(batch([started])).events).toEqual([started])
    const shown = { ...started, t: 480, ms: 475 }
    expect(timelineEventSchema.parse(shown)).toEqual(shown)
  })

  it('takes every watchdog action', () => {
    for (const action of ['gap', 'refeed', 'reopen', 'quota', 'stuck']) {
      const event = { type: 'watchdog', t: 9, action, at: 3, detail: 'x' }
      expect(timelineEventSchema.parse(event)).toEqual(event)
    }
  })

  it('refuses a seek or a watchdog event with a bad field', () => {
    const seek = { type: 'seek', t: 5, to: 10, inWindow: true, ms: 20 }
    const dog = { type: 'watchdog', t: 6, action: 'refeed', at: 10, detail: 'window' }
    const accepted = (event: unknown) => timelineEventSchema.safeParse(event).success
    expect(accepted(seek)).toBe(true)
    expect(accepted({ ...seek, to: -1 })).toBe(false)
    expect(accepted({ ...seek, to: 1e7 + 1 })).toBe(false)
    expect(accepted({ ...seek, inWindow: 'yes' })).toBe(false)
    expect(accepted({ ...seek, ms: -1 })).toBe(false)
    expect(accepted({ ...seek, ms: 1.5 })).toBe(false)
    expect(accepted({ ...seek, ms: undefined })).toBe(false)
    expect(accepted(dog)).toBe(true)
    expect(accepted({ ...dog, action: 'panic' })).toBe(false)
    expect(accepted({ ...dog, at: -1 })).toBe(false)
    expect(accepted({ ...dog, detail: 'x'.repeat(300) })).toBe(true)
    expect(accepted({ ...dog, detail: 'x'.repeat(301) })).toBe(false)
    expect(accepted({ ...dog, detail: 'half a pair \ud800' })).toBe(false)
  })

  it('takes a batch that mixes the older events and the engine’s', () => {
    const events = [
      { type: 'phase', t: 1, phase: 'buffering' },
      { type: 'seek', t: 2, to: 30, inWindow: false, ms: null },
      { type: 'watchdog', t: 3, action: 'quota', at: 30, detail: 'window 48 MiB' },
      { type: 'seek', t: 4, to: 30, inWindow: false, ms: 2 },
      { type: 'closed', t: 5 },
    ]
    const input = batch(events)
    expect(timelineBatchSchema.parse(input)).toEqual(input)
    const bad = { type: 'watchdog', t: 6, action: 'panic', at: 0, detail: '' }
    expect(timelineBatchSchema.safeParse(batch([...events, bad])).success).toBe(false)
  })

  it('takes a batch whose version isn’t known yet', () => {
    const unknown = { ...batch([{ type: 'closed', t: 0 }]), versionId: null }
    expect(timelineBatchSchema.parse(unknown).versionId).toBeNull()
    // Left out is not null: the page says it doesn’t know.
    const without: Record<string, unknown> = batch([{ type: 'closed', t: 0 }])
    delete without.versionId
    expect(timelineBatchSchema.safeParse(without).success).toBe(false)
    expect(timelineBatchSchema.safeParse({ ...unknown, versionId: 'not-a-uuid' }).success).toBe(
      false,
    )
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
