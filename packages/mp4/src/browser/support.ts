// What the browser suites hold each browser to (DESIGN.md §10.4, D45): which codecs
// a browser's Media Source takes, and the rule applied to each track before a
// file plays. Pure functions of the names a track has (`PlayTrack.codecNames`)
// and of what the browser answered to `MediaSource.isTypeSupported`, so that they
// are tested in Node, though only the browser suite uses them. They stand beside
// the player's own choice of a name, which comes in step 5.

import type { PlayTrack } from '../choose.ts'

/** The browser engines the suites run: Chrome (and the other Chromium browsers) and Firefox. */
export type Engine = 'chromium' | 'firefox'

/** What the table says of one codec family: who takes it. */
type Takes = Record<Engine, boolean>

/**
 * Who takes what, from what each browser's Media Source answered on this PC on
 * 2026-10-25 (Chrome 155 and Firefox 157), asked for `video/mp4` and `audio/mp4`
 * by each name a codec has. A family is the part of a track's first codec name
 * before its first dot, except that the `mp4a` object types that browsers answer
 * differently are families of their own: `mp4a.40.42` (xHE-AAC, which Chrome
 * takes and Firefox doesn't), `mp4a.40` (the other audio object types of MPEG-4
 * audio, and MPEG-2 AAC, which is named `mp4a.40.N` and written as MPEG-4 audio,
 * as Chrome takes nothing else) and `mp4a.6B` (MP3, which Firefox takes as `mp3`
 * and Chrome doesn't take in MP4). AC-3, E-AC-3 and ALAC are taken by neither of
 * them: Safari plays them. A family that isn't here is a codec the suite has
 * never seen a browser answer for, and the suite fails on it until the table
 * says.
 */
export const SUPPORT: Readonly<Record<string, Takes>> = {
  avc1: { chromium: true, firefox: true },
  avc3: { chromium: true, firefox: true },
  hvc1: { chromium: true, firefox: true },
  hev1: { chromium: true, firefox: true },
  av01: { chromium: true, firefox: true },
  vp09: { chromium: true, firefox: true },
  opus: { chromium: true, firefox: true },
  flac: { chromium: true, firefox: true },
  'mp4a.40': { chromium: true, firefox: true },
  'mp4a.40.42': { chromium: true, firefox: false },
  iamf: { chromium: true, firefox: false },
  'mp4a.6B': { chromium: false, firefox: true },
  'ac-3': { chromium: false, firefox: false },
  'ec-3': { chromium: false, firefox: false },
  alac: { chromium: false, firefox: false },
}

/**
 * The `mp4a` families that are more than `mp4a`: the first name of a track begins
 * with one, or is one. The most particular comes first, as the first that fits is
 * the family: `mp4a.40.42` is looked for before `mp4a.40`, which it begins with.
 */
const MP4A_FAMILIES = ['mp4a.40.42', 'mp4a.40', 'mp4a.6B']

/**
 * The family of a track: its first name up to the first dot (`avc1`, `iamf`,
 * `flac`), or `mp4a.40.42`, `mp4a.40` or `mp4a.6B` for those; any other `mp4a`
 * name is `mp4a`, which the table doesn't have. Only the first name is read, the
 * RFC 6381 one: the names after it are other ways to ask for the same codec.
 */
export function familyOf(track: Pick<PlayTrack, 'codecNames'>): string {
  const first = track.codecNames[0] ?? ''
  const own = MP4A_FAMILIES.find((family) => first === family || first.startsWith(`${family}.`))
  if (own !== undefined) return own
  const dot = first.indexOf('.')
  return dot === -1 ? first : first.slice(0, dot)
}

/** Whether the engine's Media Source takes the track by the table, or undefined where the table has no row for its family. */
export function expectedSupport(
  track: Pick<PlayTrack, 'codecNames'>,
  engine: Engine,
): boolean | undefined {
  const family = familyOf(track)
  return Object.hasOwn(SUPPORT, family) ? SUPPORT[family]?.[engine] : undefined
}

/**
 * The name that a browser takes for a family by the table, though it is not the
 * first: Firefox takes MP3 in MP4 as `mp3` and not as `mp4a.6B`, the RFC 6381
 * name, which it refuses (the probe of 2026-10-25). This is the one exception;
 * which name the player asks by is step 5's to choose.
 */
function takenByAnotherName(family: string, engine: Engine, accepted: string): boolean {
  return family === 'mp4a.6B' && engine === 'firefox' && accepted === 'mp3'
}

/** What to do with a track: play it, skip the test (agreed not to be taken), or fail it with why. */
export type Verdict = { outcome: 'play' } | { outcome: 'skip' | 'fail'; reason: string }

/**
 * The rule applied to each of a file's tracks before the file plays (DESIGN.md
 * §10.4). `accepted` is the first of the track's names that the running browser's
 * Media Source took, or null where it took none, and `browser` is how that
 * browser is called in a sentence.
 * - A family that isn't in the table fails, so a new codec or a wrong name is
 *   noticed and not skipped over.
 * - A browser that disagrees with the table fails, saying which way: the names
 *   are wrong or the table is.
 * - A browser and a table that agree it isn't taken skip the test.
 * - A browser that takes the track by a name other than the first, the RFC 6381
 *   one, fails, so that a wrong first name is not hidden by a right later one:
 *   the file would play with it all the same. The exception is Firefox's `mp3`
 *   for MP3 in MP4 (`takenByAnotherName`).
 * - Otherwise the file plays.
 */
export function supportVerdict(
  track: Pick<PlayTrack, 'codec' | 'codecNames'>,
  engine: Engine,
  browser: string,
  accepted: string | null,
): Verdict {
  const says = accepted !== null
  const expected = expectedSupport(track, engine)
  if (expected === undefined)
    return { outcome: 'fail', reason: `add ${familyOf(track)} to support.ts` }
  if (expected !== says) {
    return {
      outcome: 'fail',
      reason: `${browser}'s Media Source ${says ? 'takes' : "doesn't take"} ${track.codecNames.join(', ')}, against support.ts: check the names, or update the table`,
    }
  }
  if (!says)
    return { outcome: 'skip', reason: `${browser}'s Media Source doesn't take ${track.codec}` }
  const first = track.codecNames[0] ?? ''
  if (accepted !== first && !takenByAnotherName(familyOf(track), engine, accepted)) {
    return {
      outcome: 'fail',
      reason: `${browser}'s Media Source took ${accepted} and not ${first}, the name that codecNames gives first: check that name`,
    }
  }
  return { outcome: 'play' }
}
