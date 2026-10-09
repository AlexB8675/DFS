import type { MediaInfo, MediaStream, SubtitleFile } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { defaultSubtitle, subtitleOptions, toggledSubtitle } from './subtitle-options'

const BASE = '/files/f'
const VERSION = 'v'

function stream(index: number, codec: string, language: string, forced = false): MediaStream {
  return {
    index,
    type: 'subtitle',
    codec,
    codecString: null,
    profile: null,
    width: null,
    height: null,
    frameRate: null,
    bitDepth: null,
    hdr: null,
    dolbyVision: null,
    rotation: null,
    channels: null,
    channelLayout: null,
    sampleRate: null,
    language,
    title: null,
    default: false,
    forced,
  }
}

function info(streams: MediaStream[]): MediaInfo {
  return {
    kind: 'video',
    container: 'matroska,webm',
    durationMs: 1000,
    bitRate: null,
    streams,
    chapters: [],
    tags: {
      title: null,
      artist: null,
      album: null,
      albumArtist: null,
      genre: null,
      track: null,
      disc: null,
      year: null,
    },
    hasCover: false,
  }
}

const file = (id: string, name: string, language: string | null, forced = false): SubtitleFile => ({
  id,
  name,
  language,
  forced,
  hearingImpaired: false,
})

describe('the subtitles a video offers', () => {
  it('lists the files beside it, then the text streams inside it, each with its WebVTT', () => {
    const options = subtitleOptions(
      BASE,
      VERSION,
      [file('a', 'Film.it.srt', 'it')],
      info([
        stream(2, 'subrip', 'eng'),
        stream(3, 'hdmv_pgs_subtitle', 'eng'),
        stream(4, 'ass', 'ita', true),
      ]),
    )
    expect(options).toEqual([
      {
        key: 'file:a',
        label: 'Italian',
        language: 'it',
        forced: false,
        src: '/api/files/f/media/v/subtitles/a.vtt',
      },
      {
        key: 'stream:2',
        label: 'English',
        language: 'en',
        forced: false,
        src: '/api/files/f/media/v/subtitles/2.vtt',
      },
      {
        key: 'stream:4',
        label: 'Italian (forced)',
        language: 'it',
        forced: true,
        src: '/api/files/f/media/v/subtitles/4.vtt',
      },
    ])
  })

  it('tells apart two that would read the same', () => {
    const options = subtitleOptions(
      BASE,
      VERSION,
      [file('a', 'Film.srt', null)],
      info([stream(2, 'subrip', 'und')]),
    )
    expect(options.map((option) => option.label)).toEqual([
      'Subtitles · Film.srt',
      'Subtitles · track 2',
    ])
  })
})

describe('choosing subtitles', () => {
  const options = subtitleOptions(
    BASE,
    VERSION,
    [file('a', 'Film.it.srt', 'it'), file('b', 'Film.en.forced.srt', 'en', true)],
    info([stream(2, 'subrip', 'eng')]),
  )

  it('starts with the language chosen last, else forced subtitles, else none', () => {
    expect(defaultSubtitle(options, { on: true, language: 'en' })).toBe('stream:2')
    expect(defaultSubtitle(options, { on: true, language: 'it-IT' })).toBe('file:a')
    expect(defaultSubtitle(options, { on: false, language: 'it' })).toBe('file:b')
    // On in a language it hasn't: forced ones.
    expect(defaultSubtitle(options, { on: true, language: 'fr' })).toBe('file:b')
    expect(defaultSubtitle(options.slice(0, 1), { on: false, language: null })).toBeNull()
  })

  it('turns them off with C, and back on in the language chosen last', () => {
    const preference = { on: true, language: 'en' }
    expect(toggledSubtitle(options, 'stream:2', preference)).toBeNull()
    expect(toggledSubtitle(options, null, preference)).toBe('stream:2')
    // Forced ones showing aren't a choice: C turns full ones on.
    expect(toggledSubtitle(options, 'file:b', { on: false, language: null })).toBe('file:a')
  })
})
