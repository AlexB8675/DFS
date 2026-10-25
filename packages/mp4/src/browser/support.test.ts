import { describe, expect, it } from 'vitest'
import { expectedSupport, familyOf, supportVerdict } from './support.ts'
import type { Engine } from './support.ts'

// Which browser's Media Source takes which codec (DESIGN.md §10.4, D45): the table
// the browser suite holds each browser to, and the rule it applies to each track
// before a file plays. Both are pure functions of the names a track has, so they
// are checked here, in Node, with the names `codecNames` gives.

/** A track as the table sees it: the names Media Source can be asked about, the RFC 6381 one first. */
function track(...names: [string, ...string[]]): { codec: string; codecNames: readonly string[] } {
  return { codec: names[0], codecNames: names }
}

/** One row for each family of the table: a track of it, and who plays it (the 2026-10-25 evidence). */
const ROWS: {
  family: string
  names: [string, ...string[]]
  chromium: boolean
  firefox: boolean
}[] = [
  { family: 'avc1', names: ['avc1.64001f'], chromium: true, firefox: true },
  { family: 'avc3', names: ['avc3.64001f'], chromium: true, firefox: true },
  { family: 'hvc1', names: ['hvc1.2.4.L153.B0'], chromium: true, firefox: true },
  { family: 'hev1', names: ['hev1.1.6.L93.B0'], chromium: true, firefox: true },
  { family: 'av01', names: ['av01.0.05M.08'], chromium: true, firefox: true },
  {
    family: 'vp09',
    names: ['vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'],
    chromium: true,
    firefox: true,
  },
  { family: 'opus', names: ['opus', 'Opus'], chromium: true, firefox: true },
  { family: 'flac', names: ['flac', 'fLaC'], chromium: true, firefox: true },
  { family: 'mp4a.40', names: ['mp4a.40.2'], chromium: true, firefox: true },
  {
    family: 'mp4a.40',
    names: ['mp4a.40.2', 'mp4a.67'],
    chromium: true,
    firefox: true,
  },
  {
    family: 'iamf',
    names: ['iamf.000.000.Opus'],
    chromium: true,
    firefox: false,
  },
  {
    family: 'mp4a.6B',
    names: ['mp4a.6B', 'mp3', 'mp4a.40.34'],
    chromium: false,
    firefox: true,
  },
  { family: 'ac-3', names: ['ac-3'], chromium: false, firefox: false },
  { family: 'ec-3', names: ['ec-3'], chromium: false, firefox: false },
  { family: 'alac', names: ['alac'], chromium: false, firefox: false },
]

describe('familyOf', () => {
  it('is the part of the first name before its first dot', () => {
    expect(familyOf(track('avc1.64001f'))).toBe('avc1')
    expect(familyOf(track('hvc1.2.4.L153.B0'))).toBe('hvc1')
    expect(familyOf(track('vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'))).toBe('vp09')
    expect(familyOf(track('iamf.000.000.Opus'))).toBe('iamf')
    expect(familyOf(track('dvh1.08.06'))).toBe('dvh1')
  })

  it('is the whole of a name that has no dot', () => {
    expect(familyOf(track('opus', 'Opus'))).toBe('opus')
    expect(familyOf(track('flac', 'fLaC'))).toBe('flac')
    expect(familyOf(track('ac-3'))).toBe('ac-3')
    expect(familyOf(track('flak'))).toBe('flak')
  })

  it('keeps the object type of an MPEG-4 audio name and of MP3, and reads MPEG-2 AAC by its MPEG-4 name', () => {
    for (const aot of ['2', '5', '29', '42']) {
      expect(familyOf(track(`mp4a.40.${aot}`))).toBe('mp4a.40')
    }
    // MPEG-2 AAC is named `mp4a.40.N` first, and `mp4a.67` after it.
    expect(familyOf(track('mp4a.40.2', 'mp4a.67'))).toBe('mp4a.40')
    expect(familyOf(track('mp4a.6B', 'mp3', 'mp4a.40.34'))).toBe('mp4a.6B')
  })

  it("leaves the object type off any other 'mp4a' name, which no table row is named for", () => {
    for (const name of ['mp4a.66', 'mp4a.67', 'mp4a.68', 'mp4a.69', 'mp4a.A5', 'mp4a.DD']) {
      expect(familyOf(track(name))).toBe('mp4a')
    }
  })

  it('reads the first name alone: a later one makes no family', () => {
    expect(familyOf(track('mp4a.A5', 'ac-3'))).toBe('mp4a')
  })
})

describe('expectedSupport', () => {
  it.each(ROWS)('has $family as chromium $chromium and firefox $firefox', (row) => {
    expect(expectedSupport(track(...row.names), 'chromium')).toBe(row.chromium)
    expect(expectedSupport(track(...row.names), 'firefox')).toBe(row.firefox)
  })

  it('knows every AAC object type of MPEG-4 audio by the one family', () => {
    for (const aot of ['2', '5', '29', '42']) {
      expect(expectedSupport(track(`mp4a.40.${aot}`), 'chromium')).toBe(true)
      expect(expectedSupport(track(`mp4a.40.${aot}`), 'firefox')).toBe(true)
    }
  })

  it.each<[string, Engine]>([
    ['mp4v.20.9', 'chromium'],
    ['mp4v.20.9', 'firefox'],
    ['vp08.00.20.08', 'chromium'],
    ['dvh1.08.06', 'firefox'],
    ['avc2.64001f', 'chromium'],
    ['mp4a.A5', 'chromium'],
    ['mp4a.66', 'firefox'],
    ['mp4a.67', 'chromium'],
  ])('has no answer for %s on %s: its family is not in the table', (name, engine) => {
    expect(expectedSupport(track(name), engine)).toBeUndefined()
  })

  it('asks the first name alone, so a table family past it is not found', () => {
    expect(expectedSupport(track('mp4a.A5', 'ac-3'), 'chromium')).toBeUndefined()
  })

  it('has no answer for a name that is a property every object has', () => {
    expect(expectedSupport(track('constructor'), 'chromium')).toBeUndefined()
    expect(expectedSupport(track('toString'), 'firefox')).toBeUndefined()
  })
})

describe('supportVerdict', () => {
  it('plays a track that the browser takes and the table says it takes', () => {
    expect(supportVerdict(track('avc1.64001f'), 'chromium', 'Chrome', true)).toEqual({
      outcome: 'play',
    })
    expect(supportVerdict(track('iamf.000.000.Opus'), 'chromium', 'Chrome', true)).toEqual({
      outcome: 'play',
    })
  })

  it("skips a track that neither the browser nor the table takes, saying the browser doesn't take it", () => {
    expect(supportVerdict(track('ac-3'), 'chromium', 'Chrome', false)).toEqual({
      outcome: 'skip',
      reason: "Chrome's Media Source doesn't take ac-3",
    })
    expect(supportVerdict(track('iamf.000.000.Opus'), 'firefox', 'Firefox', false)).toEqual({
      outcome: 'skip',
      reason: "Firefox's Media Source doesn't take iamf.000.000.Opus",
    })
    expect(
      supportVerdict(track('mp4a.6B', 'mp3', 'mp4a.40.34'), 'chromium', 'Chrome', false),
    ).toEqual({ outcome: 'skip', reason: "Chrome's Media Source doesn't take mp4a.6B" })
  })

  it('fails a browser that takes what the table says it does not, naming every name asked', () => {
    expect(supportVerdict(track('alac'), 'firefox', 'Firefox', true)).toEqual({
      outcome: 'fail',
      reason:
        "Firefox's Media Source takes alac, against support.ts: check the names, or update the table",
    })
    expect(
      supportVerdict(track('mp4a.6B', 'mp3', 'mp4a.40.34'), 'chromium', 'Chrome', true),
    ).toEqual({
      outcome: 'fail',
      reason:
        "Chrome's Media Source takes mp4a.6B, mp3, mp4a.40.34, against support.ts: check the names, or update the table",
    })
  })

  it('fails a browser that refuses what the table says it takes, naming every name asked', () => {
    expect(supportVerdict(track('flac', 'fLaC'), 'chromium', 'Chrome', false)).toEqual({
      outcome: 'fail',
      reason:
        "Chrome's Media Source doesn't take flac, fLaC, against support.ts: check the names, or update the table",
    })
    expect(
      supportVerdict(
        track('vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'),
        'firefox',
        'Firefox',
        false,
      ),
    ).toEqual({
      outcome: 'fail',
      reason:
        "Firefox's Media Source doesn't take vp09.00.20.08.01.02.02.02.00, vp09.00.20.08, against support.ts: check the names, or update the table",
    })
  })

  it('fails a family that is not in the table, whatever the browser says', () => {
    expect(supportVerdict(track('flak'), 'chromium', 'Chrome', false)).toEqual({
      outcome: 'fail',
      reason: 'add flak to support.ts',
    })
    expect(supportVerdict(track('mp4v.20.9'), 'firefox', 'Firefox', true)).toEqual({
      outcome: 'fail',
      reason: 'add mp4v to support.ts',
    })
    // The names after the first make no family, though one of them is in the table.
    expect(supportVerdict(track('mp4a.A5', 'ac-3'), 'chromium', 'Chrome', false)).toEqual({
      outcome: 'fail',
      reason: 'add mp4a to support.ts',
    })
  })
})
