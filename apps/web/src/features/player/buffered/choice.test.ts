import type { MediaInfo, MediaStream } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import type { Device } from '../external-players'
import { bufferedPlayAvailable, mayPlayBuffered, pagePlay } from './choice'

/** The proof file's picture: 4K HEVC. */
const HEVC: MediaStream = {
  index: 0,
  type: 'video',
  codec: 'hevc',
  codecString: 'hvc1.2.4.L153.B0',
  profile: 'Main 10',
  width: 3840,
  height: 2160,
  frameRate: 60,
  bitDepth: 10,
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

/** The proof file's sound: AAC stereo. */
const AAC: MediaStream = {
  index: 1,
  type: 'audio',
  codec: 'aac',
  codecString: 'mp4a.40.2',
  profile: 'LC',
  width: null,
  height: null,
  frameRate: null,
  bitDepth: null,
  hdr: null,
  dolbyVision: null,
  rotation: null,
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48_000,
  language: 'eng',
  title: null,
  default: true,
  forced: false,
}

/** A second sound track, in another language. */
const AAC_ITALIAN: MediaStream = { ...AAC, index: 2, language: 'ita', default: false }

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

/** The proof file as the media service describes it: an MP4 with a picture and one sound track. */
const PROOF: MediaInfo = {
  kind: 'video',
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs: 60_000,
  bitRate: 12_000_000,
  streams: [HEVC, AAC],
  chapters: [],
  tags: NO_TAGS,
  hasCover: false,
}

/** An AC-3 sound track: a browser's Media Source seldom takes it. */
const AC3: MediaStream = { ...AAC, codec: 'ac3', codecString: 'ac-3' }

const HEVC_MIME = 'video/mp4; codecs="hvc1.2.4.L153.B0"'
const AAC_MIME = 'audio/mp4; codecs="mp4a.40.2"'
const AC3_MIME = 'audio/mp4; codecs="ac-3"'

/**
 * The input of a Windows desktop that can buffer, with a `supports` that says yes to the MIME
 * types in `yes` only and notes every one it is asked, in `asked`.
 */
function input(
  info: MediaInfo | null,
  ...yes: string[]
): Parameters<typeof pagePlay>[0] & { asked: string[] } {
  const asked: string[] = []
  return {
    name: 'Clip.mp4',
    info,
    device: 'windows',
    canBuffer: true,
    supports: (mime) => {
      asked.push(mime)
      return yes.includes(mime)
    },
    asked,
  }
}

/** A video file's info: a picture and the given sounds, in the given container. */
function fileInfo(
  container: string,
  parts: {
    video: string
    audio: { codec: string; codecString: string; default?: boolean }[]
  },
): MediaInfo {
  const picture: MediaStream = { ...HEVC, codec: 'h264', codecString: parts.video }
  const sounds = parts.audio.map((sound, at): MediaStream => ({
    ...AAC,
    ...sound,
    index: at + 1,
    default: sound.default ?? true,
  }))
  return { ...PROOF, container, streams: [picture, ...sounds] }
}

const mkvInfo = (parts: Parameters<typeof fileInfo>[1]): MediaInfo =>
  fileInfo('matroska,webm', parts)
const mp4Info = (parts: Parameters<typeof fileInfo>[1]): MediaInfo =>
  fileInfo('mov,mp4,m4a,3gp,3g2,mj2', parts)

describe('deciding how a video plays', () => {
  it('leaves an iPhone or iPad to Safari’s own player, whatever the info', () => {
    for (const info of [PROOF, null, { ...PROOF, container: 'matroska,webm' }]) {
      for (const name of ['Clip.mp4', 'film.mkv']) {
        for (const canBuffer of [true, false]) {
          const given = { ...input(info), name, device: 'ios' as Device, canBuffer }
          expect(pagePlay(given)).toEqual({ play: 'native' })
          expect(given.asked).toEqual([])
        }
      }
    }
  })

  it('offers another player where the browser cannot buffer', () => {
    const elsewhere = { play: 'elsewhere', reason: 'browser', codec: null }
    expect(pagePlay({ ...input(PROOF, HEVC_MIME, AAC_MIME), canBuffer: false })).toEqual(elsewhere)
    expect(pagePlay({ ...input(null), canBuffer: false })).toEqual(elsewhere)
  })

  it('buffers an MP4 by its name while there is no info; the player checks the codecs as it opens', () => {
    const given = input(null)
    expect(pagePlay({ ...given, name: 'Clip.mp4' })).toEqual({ play: 'buffered' })
    expect(pagePlay({ ...given, name: 'a.MOV' })).toEqual({ play: 'buffered' })
    expect(given.asked).toEqual([])
  })

  it('offers another player for a name that cannot be an MP4 or Matroska while there is no info', () => {
    expect(pagePlay({ ...input(null), name: 'film.avi' })).toEqual({
      play: 'elsewhere',
      reason: 'format',
      codec: null,
    })
  })

  it('offers another player for a container that is neither MP4 nor Matroska', () => {
    const info = { ...PROOF, container: 'avi' }
    expect(pagePlay(input(info, HEVC_MIME, AAC_MIME))).toEqual({
      play: 'elsewhere',
      reason: 'format',
      codec: null,
    })
  })

  it('plays a Matroska file in the page when the browser takes its picture and the sound that plays', () => {
    expect(
      pagePlay({
        name: 'a.mkv',
        info: mkvInfo({
          video: 'av01.0.08M.08',
          audio: [{ codec: 'opus', codecString: 'opus', default: false }],
        }),
        device: 'windows',
        canBuffer: true,
        supports: () => true,
      }),
    ).toEqual({ play: 'buffered' })
  })

  it('checks the Matroska sound flagged default, not the first, as the engine plays it', () => {
    const info = mkvInfo({
      video: 'avc1.64001f',
      audio: [
        { codec: 'opus', codecString: 'opus', default: false },
        { codec: 'ac3', codecString: 'ac-3', default: true },
      ],
    })
    const supports = (mime: string) => !mime.includes('ac-3')
    expect(pagePlay({ name: 'a.mkv', info, device: 'windows', canBuffer: true, supports })).toEqual(
      {
        play: 'elsewhere',
        reason: 'sound',
        codec: 'ac3',
      },
    )
  })

  it('checks the first Matroska sound when none is flagged default', () => {
    const info = mkvInfo({
      video: 'avc1.64001f',
      audio: [
        { codec: 'ac3', codecString: 'ac-3', default: false },
        { codec: 'opus', codecString: 'opus', default: false },
      ],
    })
    const supports = (mime: string) => !mime.includes('ac-3')
    expect(pagePlay({ name: 'a.mkv', info, device: 'windows', canBuffer: true, supports })).toEqual(
      {
        play: 'elsewhere',
        reason: 'sound',
        codec: 'ac3',
      },
    )
  })

  it('checks an MP4’s first sound, as before', () => {
    const info = mp4Info({
      video: 'avc1.64001f',
      audio: [
        { codec: 'aac', codecString: 'mp4a.40.2', default: false },
        { codec: 'ac3', codecString: 'ac-3', default: true },
      ],
    })
    const supports = (mime: string) => !mime.includes('ac-3')
    expect(pagePlay({ name: 'a.mp4', info, device: 'windows', canBuffer: true, supports })).toEqual(
      {
        play: 'buffered',
      },
    )
  })

  it('lets an MP3 sound through where Media Source takes it only as "mp3" (Firefox)', () => {
    const supports = (mime: string) =>
      mime.startsWith('video/') || mime === 'audio/mp4; codecs="mp3"'
    expect(
      pagePlay({
        name: 'a.mp4',
        info: mp4Info({ video: 'avc1.64001f', audio: [{ codec: 'mp3', codecString: 'mp4a.6B' }] }),
        device: 'windows',
        canBuffer: true,
        supports,
      }),
    ).toEqual({ play: 'buffered' })
  })

  it('offers another player for an audio file, even one whose cover is a picture stream', () => {
    expect(pagePlay(input({ ...PROOF, kind: 'audio' }, HEVC_MIME, AAC_MIME))).toEqual({
      play: 'elsewhere',
      reason: 'format',
      codec: null,
    })
  })

  it('offers another player for a file with no picture', () => {
    expect(pagePlay(input({ ...PROOF, streams: [AAC] }, AAC_MIME))).toEqual({
      play: 'elsewhere',
      reason: 'format',
      codec: null,
    })
  })

  it('names the picture’s codec when the browser cannot take it', () => {
    const given = input(PROOF, AAC_MIME)
    expect(pagePlay(given)).toEqual({ play: 'elsewhere', reason: 'picture', codec: 'hevc' })
    expect(given.asked).toEqual([HEVC_MIME])
  })

  it('names the sound’s codec when the browser cannot take it', () => {
    const given = input({ ...PROOF, streams: [HEVC, AC3] }, HEVC_MIME)
    expect(pagePlay(given)).toEqual({ play: 'elsewhere', reason: 'sound', codec: 'ac3' })
    expect(given.asked).toEqual([HEVC_MIME, AC3_MIME])
  })

  it('asks about the picture before the sound', () => {
    const given = input({ ...PROOF, streams: [HEVC, AC3] })
    expect(pagePlay(given)).toEqual({ play: 'elsewhere', reason: 'picture', codec: 'hevc' })
    expect(given.asked).toEqual([HEVC_MIME])
  })

  it('judges the first sound track only: it is the one the engine plays', () => {
    const second = input({ ...PROOF, streams: [HEVC, AAC, AC3] }, HEVC_MIME, AAC_MIME)
    expect(pagePlay(second)).toEqual({ play: 'buffered' })
    expect(second.asked).toEqual([HEVC_MIME, AAC_MIME])
    const first = input({ ...PROOF, streams: [HEVC, AC3, AAC] }, HEVC_MIME, AAC_MIME)
    expect(pagePlay(first)).toEqual({ play: 'elsewhere', reason: 'sound', codec: 'ac3' })
  })

  it('judges the first picture only', () => {
    const other: MediaStream = { ...HEVC, index: 3, codec: 'h264', codecString: 'avc1.640028' }
    const given = input({ ...PROOF, streams: [HEVC, AAC, other] }, HEVC_MIME, AAC_MIME)
    expect(pagePlay(given)).toEqual({ play: 'buffered' })
    expect(given.asked).toEqual([HEVC_MIME, AAC_MIME])
  })

  it('buffers a file with several sound tracks: the first plays, and VLC is offered for the others', () => {
    const streams = [HEVC, AAC, AAC_ITALIAN]
    expect(pagePlay(input({ ...PROOF, streams }, HEVC_MIME, AAC_MIME))).toEqual({
      play: 'buffered',
    })
  })

  it('buffers a video with no sound at all', () => {
    const given = input({ ...PROOF, streams: [HEVC] }, HEVC_MIME)
    expect(pagePlay(given)).toEqual({ play: 'buffered' })
    expect(given.asked).toEqual([HEVC_MIME])
  })

  it('trusts a stream that has no codec string, as the player checks it as it opens', () => {
    const noPicture = input({ ...PROOF, streams: [{ ...HEVC, codecString: null }, AAC] }, AAC_MIME)
    expect(pagePlay(noPicture)).toEqual({ play: 'buffered' })
    expect(noPicture.asked).toEqual([AAC_MIME])
    const noSound = input({ ...PROOF, streams: [HEVC, { ...AAC, codecString: null }] }, HEVC_MIME)
    expect(pagePlay(noSound)).toEqual({ play: 'buffered' })
    expect(noSound.asked).toEqual([HEVC_MIME])
  })

  it('buffers an HEVC and AAC file where the browser takes both', () => {
    const given = input(PROOF, HEVC_MIME, AAC_MIME)
    expect(pagePlay(given)).toEqual({ play: 'buffered' })
    expect(given.asked).toEqual([HEVC_MIME, AAC_MIME])
  })
})

describe('telling whether this browser can buffer', () => {
  /** A scope with all that buffered play needs. */
  const FULL = {
    MediaSource: () => undefined,
    AbortSignal: { any: () => undefined },
    crypto: { subtle: {} },
  }

  it('can where Media Source, AbortSignal.any and WebCrypto exist', () => {
    expect(bufferedPlayAvailable(FULL)).toBe(true)
  })

  it('cannot without Media Source', () => {
    expect(bufferedPlayAvailable({ ...FULL, MediaSource: undefined })).toBe(false)
  })

  it('cannot without AbortSignal.any', () => {
    expect(bufferedPlayAvailable({ ...FULL, AbortSignal: {} })).toBe(false)
    expect(bufferedPlayAvailable({ ...FULL, AbortSignal: undefined })).toBe(false)
  })

  it('cannot without WebCrypto, which the store encrypts with', () => {
    expect(bufferedPlayAvailable({ ...FULL, crypto: {} })).toBe(false)
    expect(bufferedPlayAvailable({ ...FULL, crypto: undefined })).toBe(false)
  })

  it('does not need Promise.withResolvers, which only the old engine used', () => {
    expect(bufferedPlayAvailable(FULL)).toBe(true)
  })
})

describe('telling by its name that a file may play through the buffer', () => {
  it('allows MP4, M4V, MOV, MKV and WebM, whatever the case', () => {
    expect(mayPlayBuffered('Clip.MKV')).toBe(true)
    expect(mayPlayBuffered('clip.webm')).toBe(true)
    expect(mayPlayBuffered('Clip.MP4')).toBe(true)
    expect(mayPlayBuffered('b.m4v')).toBe(true)
    expect(mayPlayBuffered('a.mov')).toBe(true)
    expect(mayPlayBuffered('holiday.2024.Mov')).toBe(true)
  })

  it('leaves the other containers to the element', () => {
    expect(mayPlayBuffered('old.avi')).toBe(false)
    expect(mayPlayBuffered('clip.avi')).toBe(false)
  })

  it('needs the extension to be the last part of the name', () => {
    expect(mayPlayBuffered('noext')).toBe(false)
    expect(mayPlayBuffered('x.mp4.part')).toBe(false)
    expect(mayPlayBuffered('mp4')).toBe(false)
    expect(mayPlayBuffered('movie')).toBe(false)
  })
})
