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
  // xHE-AAC (the audio object type 42): Chrome takes it, and Firefox doesn't (the probe of 2026-10-25).
  { family: 'mp4a.40.42', names: ['mp4a.40.42'], chromium: true, firefox: false },
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
  // Dolby Vision as its own entry (profile 5, or no compatible base layer): neither browser takes it (the probe of 2026-10-25).
  { family: 'dvh1', names: ['dvh1.05.06'], chromium: false, firefox: false },
  { family: 'dvhe', names: ['dvhe.04.06'], chromium: false, firefox: false },
  { family: 'dav1', names: ['dav1.10.06'], chromium: false, firefox: false },
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
    for (const aot of ['1', '2', '5', '29']) {
      expect(familyOf(track(`mp4a.40.${aot}`))).toBe('mp4a.40')
    }
    // MPEG-2 AAC is named `mp4a.40.N` and no other.
    expect(familyOf(track('mp4a.40.2'))).toBe('mp4a.40')
    expect(familyOf(track('mp4a.6B', 'mp3', 'mp4a.40.34'))).toBe('mp4a.6B')
  })

  it('makes xHE-AAC (the audio object type 42) a family of its own, which the other object types of MPEG-4 audio are not in', () => {
    expect(familyOf(track('mp4a.40.42'))).toBe('mp4a.40.42')
    // Not a prefix match: 4 (AAC LTP) is the start of 42 and is not it.
    expect(familyOf(track('mp4a.40.4'))).toBe('mp4a.40')
    expect(familyOf(track('mp4a.40.420'))).toBe('mp4a.40')
    // Only the first name is read.
    expect(familyOf(track('mp4a.40.4', 'mp4a.40.42'))).toBe('mp4a.40')
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

  it('knows every AAC object type of MPEG-4 audio but xHE-AAC by the one family', () => {
    for (const aot of ['2', '4', '5', '29']) {
      expect(expectedSupport(track(`mp4a.40.${aot}`), 'chromium')).toBe(true)
      expect(expectedSupport(track(`mp4a.40.${aot}`), 'firefox')).toBe(true)
    }
  })

  it('has Chrome take xHE-AAC and Firefox not, as the probe found', () => {
    expect(expectedSupport(track('mp4a.40.42'), 'chromium')).toBe(true)
    expect(expectedSupport(track('mp4a.40.42'), 'firefox')).toBe(false)
  })

  it.each<[string, Engine]>([
    ['mp4v.20.9', 'chromium'],
    ['mp4v.20.9', 'firefox'],
    ['vp08.00.20.08', 'chromium'],
    ['dvav.08.06', 'firefox'],
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
    expect(supportVerdict(track('avc1.64001f'), 'chromium', 'Chrome', 'avc1.64001f')).toEqual({
      outcome: 'play',
    })
    expect(
      supportVerdict(track('iamf.000.000.Opus'), 'chromium', 'Chrome', 'iamf.000.000.Opus'),
    ).toEqual({
      outcome: 'play',
    })
  })

  it("skips a track that neither the browser nor the table takes, saying the browser doesn't take it", () => {
    expect(supportVerdict(track('ac-3'), 'chromium', 'Chrome', null)).toEqual({
      outcome: 'skip',
      reason: "Chrome's Media Source doesn't take ac-3",
    })
    expect(supportVerdict(track('iamf.000.000.Opus'), 'firefox', 'Firefox', null)).toEqual({
      outcome: 'skip',
      reason: "Firefox's Media Source doesn't take iamf.000.000.Opus",
    })
    expect(
      supportVerdict(track('mp4a.6B', 'mp3', 'mp4a.40.34'), 'chromium', 'Chrome', null),
    ).toEqual({ outcome: 'skip', reason: "Chrome's Media Source doesn't take mp4a.6B" })
  })

  it('skips a Dolby Vision entry on both browsers, which take none of dvh1, dvhe and dav1', () => {
    for (const name of ['dvh1.05.06', 'dvhe.04.06', 'dav1.10.06']) {
      expect(supportVerdict(track(name), 'chromium', 'Chrome', null)).toEqual({
        outcome: 'skip',
        reason: `Chrome's Media Source doesn't take ${name}`,
      })
      expect(supportVerdict(track(name), 'firefox', 'Firefox', null)).toEqual({
        outcome: 'skip',
        reason: `Firefox's Media Source doesn't take ${name}`,
      })
      expect(supportVerdict(track(name), 'chromium', 'Chrome', name)).toMatchObject({
        outcome: 'fail',
      })
    }
  })

  it('fails a browser that takes what the table says it does not, naming every name asked', () => {
    expect(supportVerdict(track('alac'), 'firefox', 'Firefox', 'alac')).toEqual({
      outcome: 'fail',
      reason:
        "Firefox's Media Source takes alac, against support.ts: check the names, or update the table",
    })
    expect(
      supportVerdict(track('mp4a.6B', 'mp3', 'mp4a.40.34'), 'chromium', 'Chrome', 'mp4a.6B'),
    ).toEqual({
      outcome: 'fail',
      reason:
        "Chrome's Media Source takes mp4a.6B, mp3, mp4a.40.34, against support.ts: check the names, or update the table",
    })
  })

  it('fails a browser that refuses what the table says it takes, naming every name asked', () => {
    expect(supportVerdict(track('flac', 'fLaC'), 'chromium', 'Chrome', null)).toEqual({
      outcome: 'fail',
      reason:
        "Chrome's Media Source doesn't take flac, fLaC, against support.ts: check the names, or update the table",
    })
    expect(
      supportVerdict(
        track('vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'),
        'firefox',
        'Firefox',
        null,
      ),
    ).toEqual({
      outcome: 'fail',
      reason:
        "Firefox's Media Source doesn't take vp09.00.20.08.01.02.02.02.00, vp09.00.20.08, against support.ts: check the names, or update the table",
    })
  })

  it('skips xHE-AAC in Firefox, which the table says does not take it, and plays it in Chrome', () => {
    expect(supportVerdict(track('mp4a.40.42'), 'firefox', 'Firefox', null)).toEqual({
      outcome: 'skip',
      reason: "Firefox's Media Source doesn't take mp4a.40.42",
    })
    expect(supportVerdict(track('mp4a.40.42'), 'chromium', 'Chrome', 'mp4a.40.42')).toEqual({
      outcome: 'play',
    })
    expect(supportVerdict(track('mp4a.40.42'), 'firefox', 'Firefox', 'mp4a.40.42')).toMatchObject({
      outcome: 'fail',
    })
  })

  describe('the name that the browser took', () => {
    const LONG = 'vp09.00.20.08.01.02.02.02.00'
    const MP3 = track('mp4a.6B', 'mp3', 'mp4a.40.34')

    it('plays a track whose first name the browser took, the other names it has notwithstanding', () => {
      expect(supportVerdict(track(LONG, 'vp09.00.20.08'), 'chromium', 'Chrome', LONG)).toEqual({
        outcome: 'play',
      })
      expect(supportVerdict(track('opus', 'Opus'), 'firefox', 'Firefox', 'opus')).toEqual({
        outcome: 'play',
      })
      expect(supportVerdict(track('flac', 'fLaC'), 'chromium', 'Chrome', 'flac')).toEqual({
        outcome: 'play',
      })
      expect(supportVerdict(MP3, 'firefox', 'Firefox', 'mp4a.6B')).toEqual({ outcome: 'play' })
    })

    it('fails a track that the browser took by a later name, saying which name and which was first', () => {
      expect(
        supportVerdict(track(LONG, 'vp09.00.20.08'), 'firefox', 'Firefox', 'vp09.00.20.08'),
      ).toEqual({
        outcome: 'fail',
        reason: `Firefox's Media Source took vp09.00.20.08 and not ${LONG}, the name that codecNames gives first: check that name`,
      })
      expect(supportVerdict(track('opus', 'Opus'), 'chromium', 'Chrome', 'Opus')).toEqual({
        outcome: 'fail',
        reason:
          "Chrome's Media Source took Opus and not opus, the name that codecNames gives first: check that name",
      })
      expect(supportVerdict(track('flac', 'fLaC'), 'firefox', 'Firefox', 'fLaC')).toMatchObject({
        outcome: 'fail',
      })
    })

    it('takes mp3 for MP3 in MP4 in Firefox, which accepts it by that name alone', () => {
      expect(supportVerdict(MP3, 'firefox', 'Firefox', 'mp3')).toEqual({ outcome: 'play' })
      // The third name of MP3 is no exception.
      expect(supportVerdict(MP3, 'firefox', 'Firefox', 'mp4a.40.34')).toEqual({
        outcome: 'fail',
        reason:
          "Firefox's Media Source took mp4a.40.34 and not mp4a.6B, the name that codecNames gives first: check that name",
      })
      // Chrome takes MP3 in MP4 by no name, by the table, so that it taking one is a disagreement with the table.
      expect(supportVerdict(MP3, 'chromium', 'Chrome', 'mp3')).toMatchObject({
        outcome: 'fail',
        reason: expect.stringContaining('against support.ts') as string,
      })
    })

    it('makes the mp3 exception for MP3 alone: a name that happens to be mp3 fails for any other family', () => {
      expect(supportVerdict(track('opus', 'mp3'), 'firefox', 'Firefox', 'mp3')).toMatchObject({
        outcome: 'fail',
      })
      expect(supportVerdict(track('mp4a.40.2', 'mp3'), 'firefox', 'Firefox', 'mp3')).toMatchObject({
        outcome: 'fail',
      })
    })

    it('does not look at the name where the browser took none', () => {
      expect(supportVerdict(track('ac-3'), 'chromium', 'Chrome', null)).toMatchObject({
        outcome: 'skip',
      })
      expect(supportVerdict(track('flac', 'fLaC'), 'chromium', 'Chrome', null)).toMatchObject({
        outcome: 'fail',
        reason: expect.stringContaining('against support.ts') as string,
      })
    })
  })

  it('fails a family that is not in the table, whatever the browser says', () => {
    expect(supportVerdict(track('flak'), 'chromium', 'Chrome', null)).toEqual({
      outcome: 'fail',
      reason: 'add flak to support.ts',
    })
    expect(supportVerdict(track('mp4v.20.9'), 'firefox', 'Firefox', 'mp4v.20.9')).toEqual({
      outcome: 'fail',
      reason: 'add mp4v to support.ts',
    })
    // The names after the first make no family, though one of them is in the table.
    expect(supportVerdict(track('mp4a.A5', 'ac-3'), 'chromium', 'Chrome', null)).toEqual({
      outcome: 'fail',
      reason: 'add mp4a to support.ts',
    })
  })
})
