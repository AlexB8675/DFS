import { splitExtension, type MediaInfo, type MediaKind, type MediaStream } from '@dfs/shared'

// Media info the mock makes up per file (§6.7), as the media service would
// find it: a video is H.264 and AAC at 1080p with chapters and Italian
// subtitles inside, as the sample every video plays; but an AVI is MPEG-4
// Part 2, which browsers can't play, and an MKV's sound Dolby Digital,
// which most can't, so the player's reasons show too. Audio is an MP3 whose
// tags come from its name.

const STREAM: Omit<MediaStream, 'index' | 'type' | 'codec' | 'codecString'> = {
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
  language: null,
  title: null,
  default: true,
  forced: false,
}

const NO_TAGS: MediaInfo['tags'] = {
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  genre: null,
  track: null,
  disc: null,
  year: null,
}

/** The subtitles inside the demo's videos, as the media service extracts them. */
export const SAMPLE_SUBTITLES = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:04.000',
  'Questi sottotitoli sono dentro il file.',
  '',
  '00:00:05.000 --> 00:00:09.000',
  '<i>Estratti una volta, e conservati.</i>',
  '',
].join('\n')

/** What examining a file of this kind finds, made up. */
export function sampleMediaInfo(kind: MediaKind, name: string): MediaInfo {
  if (kind === 'audio') {
    return {
      kind,
      container: 'mp3',
      durationMs: 214_000,
      bitRate: 320_000,
      streams: [
        {
          ...STREAM,
          index: 0,
          type: 'audio',
          codec: 'mp3',
          codecString: 'mp4a.6B',
          channels: 2,
          channelLayout: 'stereo',
          sampleRate: 44_100,
        },
      ],
      chapters: [],
      tags: { ...NO_TAGS, title: splitExtension(name).base, artist: 'Demo Artist', track: 1 },
      hasCover: false,
    }
  }
  const extension = splitExtension(name).extension.toLowerCase()
  return {
    kind,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationMs: 12_000,
    bitRate: 2_500_000,
    streams: [
      {
        ...STREAM,
        index: 0,
        type: 'video',
        codec: 'h264',
        codecString: 'avc1.640028',
        profile: 'High',
        width: 1920,
        height: 1080,
        frameRate: 30,
        bitDepth: 8,
        ...(extension === '.avi' && {
          codec: 'mpeg4',
          codecString: 'mp4v.20.9',
          profile: 'Simple Profile',
        }),
      },
      {
        ...STREAM,
        index: 1,
        type: 'audio',
        codec: 'aac',
        codecString: 'mp4a.40.2',
        profile: 'LC',
        channels: 2,
        channelLayout: 'stereo',
        sampleRate: 48_000,
        language: 'eng',
        ...(extension === '.mkv' && {
          codec: 'ac3',
          codecString: 'ac-3',
          profile: null,
          channels: 6,
          channelLayout: '5.1(side)',
        }),
      },
      {
        ...STREAM,
        index: 2,
        type: 'subtitle',
        codec: 'subrip',
        codecString: null,
        language: 'ita',
        default: false,
      },
    ],
    chapters: [
      { startMs: 0, endMs: 4000, title: 'Opening' },
      { startMs: 4000, endMs: 8000, title: 'Middle' },
      { startMs: 8000, endMs: 12_000, title: 'End' },
    ],
    tags: NO_TAGS,
    hasCover: false,
  }
}
