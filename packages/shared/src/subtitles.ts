import { splitExtension } from './names.ts'

// Subtitle files beside a video (DESIGN.md §6.7, §10.4): which files are a
// video's, what their names say, and their text as WebVTT, the one format
// browsers show. Converted in plain code, since the media service opens no
// subtitle formats. ASS styling is lost; italics, bold and underline stay.

export type SubtitleFormat = 'srt' | 'vtt' | 'ass'

const FORMATS: Record<string, SubtitleFormat> = {
  '.srt': 'srt',
  '.vtt': 'vtt',
  '.ass': 'ass',
  '.ssa': 'ass',
}

/** Larger files aren't taken for subtitles: a film's are a few hundred KB. */
export const MAX_SUBTITLE_FILE_BYTES = 5 * 1024 * 1024

/** What a subtitle file's name says about it. */
export interface SubtitleName {
  /** A BCP 47 tag (`it`, `pt-BR`), from a code or an English name; `null` if it gives none. */
  language: string | null
  /** Only the parts in another language (`forced`). */
  forced: boolean
  /** For the deaf and hard of hearing (`sdh`, `cc`, or `hi` after a language). */
  hearingImpaired: boolean
}

export function subtitleFormat(name: string): SubtitleFormat | null {
  return FORMATS[splitExtension(name).extension.toLowerCase()] ?? null
}

/**
 * What `name` says, if it is the video's subtitle file: `Film.mkv` has
 * `Film.srt`, `Film.it.srt`, `Film.en.forced.vtt` and `Film.eng.sdh.ass`.
 */
export function subtitleFileOf(videoName: string, name: string): SubtitleName | null {
  if (!subtitleFormat(name)) return null
  const video = splitExtension(videoName).base.toLowerCase()
  const base = splitExtension(name).base
  const lower = base.toLowerCase()
  if (lower !== video && !lower.startsWith(`${video}.`)) return null
  const said: SubtitleName = { language: null, forced: false, hearingImpaired: false }
  for (const tag of base.slice(video.length + 1).split('.')) {
    const word = tag.toLowerCase()
    if (word === 'forced') said.forced = true
    else if (word === 'sdh' || word === 'cc' || (word === 'hi' && said.language !== null))
      said.hearingImpaired = true
    else said.language ??= languageOf(tag)
  }
  return said
}

let names: Intl.DisplayNames | null = null
let byName: Map<string, string> | null = null

/** ISO 639-1, for languages written out in English (`Film.Italian.srt`). */
const ISO_639_1 = (
  'af am ar az be bg bn bs ca cs cy da de el en eo es et eu fa fi fil fr ga gl gu he hi hr hu ' +
  'hy id is it ja ka kk km kn ko ku ky lo lt lv mk ml mn mr ms mt my nb ne nl nn no pa pl ps ' +
  'pt ro ru si sk sl so sq sr sv sw ta te tg th tk tr uk ur uz vi yi zh zu'
).split(' ')

/** A language tag from a code (`it`, `ita`, `pt-BR`, `pt_BR`) or an English name (`Italian`). */
export function languageOf(tag: string): string | null {
  names ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
  const code = tag.replace('_', '-')
  if (/^[a-z]{2,3}(-[a-z\d]{2,8})*$/i.test(code)) {
    try {
      // Three letters become two where there are both: `ita` → `it`, `ger` → `de`.
      const [canonical] = Intl.getCanonicalLocales(code)
      if (canonical && names.of(canonical) !== undefined) return canonical
    } catch {
      // Not a language tag after all.
    }
  }
  if (!byName) {
    byName = new Map()
    for (const known of ISO_639_1) {
      const name = names.of(known)
      if (name) byName.set(name.toLowerCase(), known)
    }
  }
  return byName.get(tag.toLowerCase()) ?? null
}

/**
 * Where a file isn't UTF-8 (older subtitles rarely are), the Windows code
 * page of its language, by the language its name gives; Western otherwise.
 */
const LEGACY_ENCODINGS: Record<string, string> = {
  ru: 'windows-1251',
  uk: 'windows-1251',
  bg: 'windows-1251',
  sr: 'windows-1251',
  mk: 'windows-1251',
  be: 'windows-1251',
  pl: 'windows-1250',
  cs: 'windows-1250',
  sk: 'windows-1250',
  hu: 'windows-1250',
  hr: 'windows-1250',
  sl: 'windows-1250',
  ro: 'windows-1250',
  bs: 'windows-1250',
  sq: 'windows-1250',
  el: 'windows-1253',
  tr: 'windows-1254',
  he: 'windows-1255',
  ar: 'windows-1256',
  fa: 'windows-1256',
  ur: 'windows-1256',
  lt: 'windows-1257',
  lv: 'windows-1257',
  et: 'windows-1257',
  vi: 'windows-1258',
  th: 'windows-874',
  ja: 'shift_jis',
  ko: 'euc-kr',
  zh: 'gb18030',
}

/**
 * A subtitle file's text: UTF-8 or UTF-16 by its byte-order mark, else
 * UTF-8 if it is valid, else its language's legacy encoding.
 */
export function decodeSubtitles(bytes: Uint8Array, language: string | null): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    const primary = language?.split('-')[0] ?? ''
    const traditional = /^zh-(hant|tw|hk|mo)\b/i.test(language ?? '')
    return new TextDecoder(
      traditional ? 'big5' : (LEGACY_ENCODINGS[primary] ?? 'windows-1252'),
    ).decode(bytes)
  }
}

/** A cue as WebVTT has it: times in milliseconds, text in WebVTT's markup. */
interface Cue {
  start: number
  end: number
  /** Cue settings (`line:0`), or empty. */
  settings: string
  text: string
}

/** A subtitle file's text as WebVTT. */
export function toWebVtt(text: string, format: SubtitleFormat): string {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (format === 'vtt' && /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(lines)) {
    // Already WebVTT, which browsers parse safely: only its line endings change.
    return lines.endsWith('\n') ? lines : `${lines}\n`
  }
  // A `.vtt` without its header is most often SRT under another name.
  const cues = format === 'ass' ? assCues(lines) : srtCues(lines)
  return writeWebVtt(cues)
}

function writeWebVtt(cues: Cue[]): string {
  const blocks = cues.map(
    (cue) =>
      `${timestamp(cue.start)} --> ${timestamp(cue.end)}${cue.settings ? ` ${cue.settings}` : ''}\n${cue.text}`,
  )
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`
}

function timestamp(ms: number): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

// ── SRT ──────────────────────────────────────────────────────────────────────

const SRT_TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.:](\d{1,3})`
const SRT_TIMING = new RegExp(`^\\s*${SRT_TIME}\\s*-->\\s*${SRT_TIME}`)

function srtTime(hours: string | undefined, minutes = '0', seconds = '0', fraction = '0'): number {
  return (
    (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 +
    Number(fraction.padEnd(3, '0'))
  )
}

/** SRT's cues: each a timing line and its text up to a blank line. The numbers aren't needed. */
function srtCues(text: string): Cue[] {
  const lines = text.split('\n')
  const cues: Cue[] = []
  let cue: { start: number; end: number; lines: string[] } | null = null
  const finish = () => {
    if (cue && cue.end > cue.start && cue.lines.length) {
      cues.push(srtCue(cue.start, cue.end, cue.lines))
    }
    cue = null
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const timing = SRT_TIMING.exec(line)
    if (timing) {
      finish()
      const [, h1, m1, s1, f1, h2, m2, s2, f2] = timing
      cue = { start: srtTime(h1, m1, s1, f1), end: srtTime(h2, m2, s2, f2), lines: [] }
    } else if (line.trim() === '') {
      finish()
    } else if (cue && !(/^\d+$/.test(line.trim()) && SRT_TIMING.test(lines[i + 1] ?? ''))) {
      // A number just before a timing line is the next cue's, when the blank line is missing.
      cue.lines.push(line)
    }
  }
  finish()
  return cues
}

/** SRT's text: `<i>`, `<b>` and `<u>` stay; `{\an8}` puts it at the top; the rest is dropped. */
function srtCue(start: number, end: number, lines: string[]): Cue {
  let settings = ''
  const text = lines
    .join('\n')
    .replace(/\{\\an?(\d+)\}/g, (_, position: string) => {
      settings = topSettings(Number(position)) || settings
      return ''
    })
    .replace(/\{\\[^}]*\}/g, '')
  return { start, end, settings, text: markup(text) }
}

/** `\an7`–`\an9` are at the top; WebVTT's `line:0` is its first line. */
function topSettings(alignment: number): string {
  return alignment >= 7 && alignment <= 9 ? 'line:0' : ''
}

/** Text with `<i>`, `<b>` and `<u>` kept, other tags dropped, and the rest escaped for WebVTT. */
function markup(text: string): string {
  let out = ''
  let at = 0
  for (const tag of text.matchAll(/<(\/?)([a-z]+)\b[^>]*>/gi)) {
    out += escapeText(text.slice(at, tag.index))
    const name = (tag[2] ?? '').toLowerCase()
    if (name === 'i' || name === 'b' || name === 'u') out += `<${tag[1] ?? ''}${name}>`
    at = tag.index + tag[0].length
  }
  return out + escapeText(text.slice(at))
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// ── ASS and SSA ──────────────────────────────────────────────────────────────

/** SSA's order when a file gives none; ASS's has a layer first, which doesn't matter here. */
const SSA_FIELDS = [
  'marked',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
]

/** `[Events]`'s dialogue lines, in time order. */
function assCues(text: string): Cue[] {
  const cues: Cue[] = []
  let inEvents = false
  let fields = SSA_FIELDS
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inEvents = trimmed.toLowerCase() === '[events]'
      continue
    }
    if (!inEvents) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const kind = trimmed.slice(0, colon).toLowerCase()
    const rest = trimmed.slice(colon + 1).trim()
    if (kind === 'format') {
      fields = rest.split(',').map((field) => field.trim().toLowerCase())
    } else if (kind === 'dialogue') {
      const cue = assCue(fields, rest)
      if (cue) cues.push(cue)
    }
  }
  return cues.sort((a, b) => a.start - b.start)
}

function assCue(fields: string[], line: string): Cue | null {
  // The text is the last field, and may hold commas of its own.
  const values = line.split(',')
  const text = values.slice(fields.length - 1).join(',')
  const value = (field: string) => values[fields.indexOf(field)]?.trim() ?? ''
  const start = assTime(value('start'))
  const end = assTime(value('end'))
  if (start === null || end === null || end <= start) return null
  // Drawings (`\p1`) are shapes, not words.
  if (/\{[^}]*\\p[1-9]/.test(text)) return null
  let settings = ''
  let out = ''
  const open = { i: false, b: false, u: false }
  for (const part of text.split(/(\{[^}]*\})/)) {
    if (!part.startsWith('{')) {
      out += escapeText(part.replace(/\\[Nn]/g, '\n').replace(/\\h/g, '\u00a0'))
      continue
    }
    for (const [, name, on] of part.matchAll(/\\([ibu])(\d*)(?=\\|\}|$)/g)) {
      const tag = name as 'i' | 'b' | 'u'
      // `\b` takes a weight too: 400 and below is regular.
      const wanted =
        on === '' || on === '0' ? false : tag !== 'b' || Number(on) === 1 || Number(on) > 400
      if (wanted !== open[tag]) out += wanted ? `<${tag}>` : `</${tag}>`
      open[tag] = wanted
    }
    const alignment = /\\an(\d)/.exec(part)
    if (alignment) settings = topSettings(Number(alignment[1])) || settings
  }
  for (const tag of ['u', 'b', 'i'] as const) if (open[tag]) out += `</${tag}>`
  // A blank line would end the cue in WebVTT.
  const trimmed = out.replace(/\n\s*(?=\n)/g, '').replace(/^\n+|\n+$/g, '')
  return trimmed.trim() ? { start, end, settings, text: trimmed } : null
}

/** `H:MM:SS.cc` */
function assTime(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(value)
  if (!match) return null
  const [, hours, minutes, seconds, fraction = '0'] = match
  return (
    (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 +
    Number(fraction.padEnd(3, '0'))
  )
}
