import { isTextSubtitles, languageOf, type MediaInfo, type SubtitleFile } from '@dfs/shared'
import { languageName } from './codecs'

// The subtitles a video offers (DESIGN.md §6.7, §10.4): files beside it, from
// GET /files/:id/playback at once, and text streams inside it, once its media
// info comes. Each is WebVTT from the API, for a `<track>`.

export interface SubtitleOption {
  /** `file:<id>` or `stream:<index>`. */
  key: string
  label: string
  /** A BCP 47 tag, or `null` when it says none. */
  language: string | null
  /** Only the parts in another language: shown without being chosen. */
  forced: boolean
  /** Where its WebVTT is. */
  src: string
}

/** What the viewer chose last, kept in the browser. */
export interface SubtitlePreference {
  /** Subtitles were on: a track was chosen, not Off. */
  on: boolean
  /** The language of the track chosen, if it had one. */
  language: string | null
}

/** Every subtitle track of the version: beside it first, then inside it. */
export function subtitleOptions(
  base: string,
  versionId: string,
  files: readonly SubtitleFile[],
  info: MediaInfo | null,
): SubtitleOption[] {
  const path = (track: string) => `/api${base}/media/${versionId}/subtitles/${track}.vtt`
  const options: (SubtitleOption & { detail: string })[] = files.map((file) => ({
    key: `file:${file.id}`,
    label: labelOf(file.language, file.forced, file.hearingImpaired),
    language: file.language,
    forced: file.forced,
    src: path(file.id),
    detail: file.name,
  }))
  const streams = info?.streams.filter(isTextSubtitles) ?? []
  for (const stream of streams) {
    const language = normalLanguage(stream.language)
    options.push({
      key: `stream:${String(stream.index)}`,
      label: labelOf(language, stream.forced, false),
      language,
      forced: stream.forced,
      src: path(String(stream.index)),
      detail: stream.title ?? `track ${String(stream.index)}`,
    })
  }
  // Two that would read the same say which is which.
  return options.map(({ detail, ...option }) =>
    options.filter((other) => other.label === option.label).length > 1
      ? { ...option, label: `${option.label} · ${detail}` }
      : option,
  )
}

/**
 * The track to show when the video starts: one in the language chosen last
 * if subtitles were on, else forced subtitles, else none.
 */
export function defaultSubtitle(
  options: readonly SubtitleOption[],
  preference: SubtitlePreference,
): string | null {
  const full = options.filter((option) => !option.forced)
  if (preference.on) {
    const chosen = preference.language
      ? full.find((option) => sameLanguage(option.language, preference.language))
      : full[0]
    if (chosen) return chosen.key
  }
  return options.find((option) => option.forced)?.key ?? null
}

/** C: subtitles off if some were chosen, else on in the language chosen last. */
export function toggledSubtitle(
  options: readonly SubtitleOption[],
  current: string | null,
  preference: SubtitlePreference,
): string | null {
  const shown = options.find((option) => option.key === current)
  if (shown && !shown.forced) return null
  const full = options.filter((option) => !option.forced)
  return (
    full.find((option) => sameLanguage(option.language, preference.language))?.key ??
    full[0]?.key ??
    null
  )
}

function labelOf(language: string | null, forced: boolean, hearingImpaired: boolean): string {
  const name = languageName(language) ?? 'Subtitles'
  const notes = [forced && 'forced', hearingImpaired && 'SDH'].filter(Boolean)
  return notes.length ? `${name} (${notes.join(', ')})` : name
}

/** ffmpeg's three letters as a tag: `ita` → `it`; `und` says none. */
function normalLanguage(language: string | null): string | null {
  if (!language || language === 'und') return null
  return languageOf(language) ?? language
}

/** `pt-BR` and `pt` are the same language, for choosing. */
function sameLanguage(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.split('-')[0]?.toLowerCase() === b.split('-')[0]?.toLowerCase()
}
