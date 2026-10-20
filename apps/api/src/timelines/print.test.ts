import type { BatchRow, TimelineRead, TimelineRow } from '@dfs/db'
import type { ServedEvent } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { printTimeline, printTimelineList } from './print.ts'

// What an admin reads of a play's timeline and its stream sessions (DESIGN.md
// §16): the printers are pure, so these build the rows by hand.

const PLAY_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const NODE_ID = '33333333-3333-4333-8333-333333333333'
const VERSION_ID = '44444444-4444-4444-8444-444444444444'

function row(overrides: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id: PLAY_ID,
    kind: 'play',
    playId: null,
    via: 'drive',
    nodeId: NODE_ID,
    versionId: VERSION_ID,
    userId: 'u1',
    username: 'alex',
    shareId: null,
    address: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Linux; Android 15) Firefox/157.0',
    clientStartedAt: new Date('2026-10-19T12:00:00.000Z'),
    startedAt: new Date('2026-10-19T12:00:00.250Z'),
    updatedAt: new Date('2026-10-19T12:01:00.000Z'),
    bytes: 2500,
    batches: 2,
    fileName: 'holiday.mp4',
    ...overrides,
  }
}

function batch(seq: number, events: unknown[], overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    seq,
    receivedAt: new Date('2026-10-19T12:00:05.000Z'),
    sentMs: 5000,
    address: '203.0.113.7',
    events,
    ...overrides,
  }
}

function served(overrides: Partial<ServedEvent> = {}): ServedEvent {
  return {
    type: 'served',
    t: 500,
    address: '203.0.113.7',
    from: 0,
    to: 1_048_575,
    status: 206,
    bytes: 1_048_576,
    finished: true,
    failed: false,
    firstByteMs: 40,
    totalMs: 800,
    sources: {
      staging: { bytes: 0, waitMs: 0 },
      cache: { bytes: 0, waitMs: 0 },
      discord: { bytes: 0, waitMs: 0 },
    },
    clientMs: 12,
    seek: false,
    gapMs: null,
    ...overrides,
  }
}

const opened = {
  type: 'opened',
  t: 0,
  device: 'phone',
  visible: true,
  online: true,
  connection: null,
}
const playing = { type: 'element', t: 1250, name: 'playing', at: 0.5, readyState: 4 }

function playOf(events: unknown[]): TimelineRead {
  return { timeline: row(), batches: [batch(0, events)], sessions: [] }
}

/** A play with one stream session started at 12:00:02.000 whose events are `events`. */
function withSession(
  events: unknown[],
  clientStartedAt: Date | null = new Date('2026-10-19T12:00:00.000Z'),
): TimelineRead {
  return {
    timeline: row({ clientStartedAt }),
    batches: [
      // Zero on the server's clock is 12:00:00.000: the first batch says so, the second was late.
      batch(0, [opened], { receivedAt: new Date('2026-10-19T12:00:05.000Z'), sentMs: 5000 }),
      batch(1, [playing], { receivedAt: new Date('2026-10-19T12:00:11.000Z'), sentMs: 10_900 }),
    ],
    sessions: [
      {
        timeline: row({
          id: SESSION_ID,
          kind: 'stream',
          via: 'stream',
          playId: PLAY_ID,
          startedAt: new Date('2026-10-19T12:00:02.000Z'),
          clientStartedAt: null,
        }),
        batches: [
          batch(0, events, { receivedAt: new Date('2026-10-19T12:00:09.000Z'), sentMs: null }),
        ],
      },
    ],
  }
}

function lines(text: string): string[] {
  return text.split('\n')
}

describe('printTimeline', () => {
  it('prints a play’s events on its own clock', () => {
    const text = printTimeline(playOf([opened, playing]))
    expect(text).toContain('+0.000s opened')
    expect(lines(text).some((line) => line.startsWith('+1.250s element name=playing'))).toBe(true)
  })

  it('heads a play with where it came from and what it played', () => {
    const text = printTimeline(playOf([opened]))
    expect(text).toContain('play/drive')
    expect(text).toContain(`holiday.mp4`)
    expect(text).toContain(NODE_ID)
    expect(text).toContain(VERSION_ID)
    expect(text).toContain('alex')
    expect(text).toContain('203.0.113.7')
    expect(text).toContain('client start 2026-10-19T12:00:00.000Z')
    expect(text).toContain('server start 2026-10-19T12:00:00.250Z')
    expect(text).toContain('2 batches')
    expect(text).toContain('3 KiB')
  })

  it('names a link’s viewer, a deleted file and an unknown client start', () => {
    const text = printTimeline({
      timeline: row({
        via: 'link',
        userId: null,
        username: null,
        shareId: 'abc123',
        fileName: null,
        clientStartedAt: null,
      }),
      batches: [batch(0, [opened])],
      sessions: [],
    })
    expect(text).toContain('play/link')
    expect(text).toContain('link abc123')
    expect(text).toContain('(deleted)')
    expect(text).toContain('client start unknown')
  })

  it('names a deleted account once in the header', () => {
    const text = printTimeline({
      timeline: row({ username: null, userId: 'u1' }),
      batches: [batch(0, [opened])],
      sessions: [],
    })
    expect(lines(text)).toContain('viewer user u1')
    expect(text).not.toContain('user user')
    // A named viewer and a link's keep their form.
    expect(lines(printTimeline(playOf([opened])))).toContain('viewer alex')
    const link = printTimeline({
      timeline: row({ username: null, userId: null, shareId: 'abc123' }),
      batches: [batch(0, [opened])],
      sessions: [],
    })
    expect(lines(link)).toContain('viewer link abc123')
  })

  it('orders events by their time across batches, ties in the order they came', () => {
    const text = printTimeline({
      timeline: row(),
      batches: [
        batch(0, [
          { type: 'closed', t: 3000 },
          { type: 'network', t: 1000, online: false },
        ]),
        batch(1, [
          { type: 'network', t: 1000, online: true },
          { type: 'visibility', t: 2000, hidden: true },
        ]),
      ],
      sessions: [],
    })
    const events = lines(text).filter((line) => line.startsWith('+'))
    expect(events).toEqual([
      '+1.000s network online=false',
      '+1.000s network online=true',
      '+2.000s visibility hidden=true',
      '+3.000s closed',
    ])
  })

  it('prints objects and arrays as compact JSON and quotes text with spaces', () => {
    const text = printTimeline(
      playOf([
        {
          type: 'sample',
          t: 2000,
          at: 1.5,
          aheadS: 4,
          ranges: [[0, 5.5]],
          readyState: 4,
          paused: false,
          frames: 10,
          dropped: 0,
        },
        { type: 'error', t: 2500, from: 'engine', code: null, message: 'Failed to fetch' },
      ]),
    )
    expect(text).toContain('ranges=[[0,5.5]]')
    expect(text).toContain('paused=false')
    expect(text).toContain('code=null')
    expect(text).toContain('message="Failed to fetch"')
  })

  it('spells out control characters from outside, so a page can’t write to the terminal', () => {
    const text = printTimeline(
      playOf([{ type: 'error', t: 10, from: 'page', code: null, message: '\u001b[31mred\u009b' }]),
    )
    for (const line of lines(text)) expect(line).not.toMatch(/\p{Cc}/u)
    expect(text).toContain('\\u001b[31mred\\u009b')
  })

  it('prints an event it can’t read after the others', () => {
    const text = printTimeline(playOf(['odd', { type: 'closed', t: 100 }, { t: 5 }]))
    const events = lines(text).filter((line) => line.startsWith('+'))
    expect(events).toEqual(['+0.100s closed', '+?s (unreadable) "odd"', '+?s (unreadable) {"t":5}'])
  })

  it('puts the server’s requests on the play’s clock, by the server’s own', () => {
    for (const clientStartedAt of [
      new Date('2026-10-19T12:00:00.000Z'),
      new Date('2026-10-19T12:00:03.000Z'),
    ]) {
      const text = printTimeline(withSession([served({ t: 500 })], clientStartedAt))
      const events = lines(text).filter((line) => line.startsWith('+'))
      expect(events.map((line) => line.split(' ')[0])).toEqual(['+0.000s', '+1.250s', '+2.500s'])
      expect(events[2]).toMatch(/^\+2\.500s server served /)
    }
  })

  it('falls back to the page’s start when no batch says when it was sent', () => {
    const read = withSession([served({ t: 500 })], new Date('2026-10-19T12:00:00.500Z'))
    for (const play of read.batches) play.sentMs = null
    const text = printTimeline(read)
    // Session at 12:00:02.000 + 0.5 s, from a zero of 12:00:00.500.
    expect(text).toMatch(/^\+2\.000s server served /m)
  })

  it('prints the sessions on their own clocks when the play’s zero is unknown', () => {
    const read = withSession([served({ t: 500 })], null)
    for (const play of read.batches) play.sentMs = null
    const text = printTimeline(read)
    const all = lines(text)
    const at = all.findIndex((line) => line.startsWith(`session ${SESSION_ID}`))
    expect(at).toBeGreaterThan(all.findIndex((line) => line.startsWith('+1.250s element')))
    expect(all.slice(at).some((line) => line.startsWith('+0.500s served '))).toBe(true)
    expect(text).not.toContain('server served')
  })

  it('lists the stream sessions that served a play in its header', () => {
    const text = printTimeline(withSession([served()]))
    expect(text).toContain(`session ${SESSION_ID}`)
  })

  it('prints a stream session read on its own, on its own clock', () => {
    const text = printTimeline({
      timeline: row({
        id: SESSION_ID,
        kind: 'stream',
        via: 'stream',
        playId: PLAY_ID,
        clientStartedAt: null,
      }),
      batches: [batch(0, [served({ t: 1500 })], { sentMs: null })],
      sessions: [],
    })
    expect(text).toContain('stream/stream')
    expect(text).toContain(`play ${PLAY_ID}`)
    expect(text).toContain('client start unknown')
    expect(text).toMatch(/^\+1\.500s served 0-1048575 206 /m)
  })

  it('prints a served read with its sources, seek and gap', () => {
    const text = printTimeline(
      withSession([
        served({
          bytes: 3 * 1024 * 1024,
          totalMs: 1000,
          firstByteMs: 85,
          sources: {
            staging: { bytes: 0, waitMs: 0 },
            cache: { bytes: 1024 * 1024, waitMs: 3 },
            discord: { bytes: 2 * 1024 * 1024, waitMs: 640 },
          },
          clientMs: 20,
          seek: true,
          gapMs: 1200,
        }),
      ]),
    )
    const line = lines(text).find((l) => l.includes('server served'))
    expect(line).toBeDefined()
    expect(line).toContain('0-1048575 206')
    expect(line).toContain('3.0MiB')
    expect(line).toContain('first=85ms')
    expect(line).toContain('total=1000ms')
    expect(line).toContain('25.2Mbit/s')
    expect(line).toContain('cache=1.0MiB/3ms')
    expect(line).toContain('discord=2.0MiB/640ms')
    expect(line).toContain('client=20ms')
    expect(line).toMatch(/ seek( |$)/)
    expect(line).toContain('gap=1200ms')
    expect(line).not.toContain('staging=')
    expect(line).not.toContain('unfinished')
    expect(line).not.toContain('failed')
  })

  it('marks an unfinished or failed read, and leaves out a rate it can’t work out', () => {
    const text = printTimeline(
      withSession([
        served({
          finished: false,
          failed: true,
          totalMs: 0,
          firstByteMs: null,
          bytes: 512,
          sources: {
            staging: { bytes: 512, waitMs: 1 },
            cache: { bytes: 0, waitMs: 0 },
            discord: { bytes: 0, waitMs: 0 },
          },
        }),
      ]),
    )
    const line = lines(text).find((l) => l.includes('server served'))
    expect(line).toContain('first=none')
    expect(line).toContain('total=0ms')
    expect(line).not.toContain('Mbit/s')
    expect(line).toContain('staging=0.5KiB/1ms')
    expect(line).toContain('unfinished')
    expect(line).toContain('failed')
    expect(line).not.toContain('gap=')
  })

  it('shows addr= on a session’s first read and where it changes, not where it repeats', () => {
    const text = printTimeline(
      withSession([
        served({ t: 100, address: '203.0.113.7' }),
        served({ t: 200, address: '198.51.100.9' }),
        served({ t: 300, address: '198.51.100.9' }),
        served({ t: 400, address: '203.0.113.7' }),
      ]),
    )
    const reads = lines(text).filter((line) => line.includes('server served'))
    expect(reads).toHaveLength(4)
    expect(reads[0]).toContain('addr=203.0.113.7')
    expect(reads[1]).toContain('addr=198.51.100.9')
    expect(reads[2]).not.toContain('addr=')
    expect(reads[3]).toContain('addr=203.0.113.7')
  })

  it('keeps each session’s addresses apart when several serve one play', () => {
    const read = withSession([served({ t: 100, address: '203.0.113.7' })])
    const [first] = read.sessions
    if (!first) throw new Error('no session')
    read.sessions.push({
      timeline: { ...first.timeline, id: '55555555-5555-4555-8555-555555555555' },
      batches: [batch(0, [served({ t: 200, address: '203.0.113.7' })], { sentMs: null })],
    })
    const reads = lines(printTimeline(read)).filter((line) => line.includes('server served'))
    expect(reads).toHaveLength(2)
    expect(reads[0]).toContain('addr=203.0.113.7')
    expect(reads[1]).toContain('addr=203.0.113.7')
  })

  it('prints a session’s dropped note as an ordinary event', () => {
    const text = printTimeline(withSession([{ type: 'dropped', t: 900, events: 3, invalid: 0 }]))
    expect(text).toMatch(/^\+2\.900s server dropped events=3 invalid=0$/m)
  })

  it('says when there are no events', () => {
    const text = printTimeline({
      timeline: row({ batches: 0, bytes: 0 }),
      batches: [],
      sessions: [],
    })
    expect(text).toContain('No events.')
  })
})

describe('printTimelineList', () => {
  it('prints a list line per timeline, a session with its play', () => {
    const text = printTimelineList([
      row(),
      row({
        id: SESSION_ID,
        kind: 'stream',
        via: 'stream',
        playId: PLAY_ID,
        fileName: null,
        batches: 1,
        bytes: 1,
        startedAt: new Date('2026-10-19T11:59:00.000Z'),
        userAgent: null,
      }),
    ])
    const [first, second, ...rest] = lines(text)
    expect(rest).toEqual([])
    expect(first).toBe(
      `2026-10-19T12:00:00Z  ${PLAY_ID}  play/drive  holiday.mp4  2 batches  3 KiB  alex  Mozilla/5.0 (Linux; Android 15) Firefox/157.0`,
    )
    expect(first).not.toContain('play ' + PLAY_ID)
    expect(second).toContain(`${SESSION_ID}  stream/stream  (deleted)  1 batch  1 KiB  alex`)
    expect(second).toMatch(new RegExp(`play ${PLAY_ID}$`))
  })

  it('cuts the user agent to 60 characters and names a link’s viewer', () => {
    const text = printTimelineList([
      row({ userAgent: 'x'.repeat(100), username: null, userId: null, shareId: 'abc123' }),
    ])
    expect(text).toContain(`  link abc123  ${'x'.repeat(60)}`)
    expect(text).not.toContain('x'.repeat(61))
  })

  it('prints No timelines. for an empty list', () => {
    expect(printTimelineList([])).toBe('No timelines.')
  })
})
