import type { MediaInfo, MediaStream } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { describeAudio, describeVideo, mimeTypeOf, playability, type CanPlayType } from './codecs'
import { playerAction, stepSpeed } from './keys'
import { positionChange } from './resume-rules'
import { formatPlayTime, loadedUntil } from './time'

const STREAM: MediaStream = {
  index: 0,
  type: 'video',
  codec: 'h264',
  codecString: 'avc1.640028',
  profile: 'High',
  width: 1920,
  height: 1080,
  frameRate: 23.976023976,
  bitDepth: 8,
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

const AC3: MediaStream = {
  ...STREAM,
  index: 1,
  type: 'audio',
  codec: 'ac3',
  codecString: 'ac-3',
  profile: null,
  width: null,
  height: null,
  frameRate: null,
  channels: 6,
  channelLayout: '5.1(side)',
  language: 'eng',
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

/** A browser that decodes H.264 and AAC only, as Chrome on Windows without extensions. */
const chrome: CanPlayType = (type) => (/avc1|mp4a\.40/.test(type) ? 'probably' : '')

describe('what this browser decodes', () => {
  it('asks about each codec under its own container, never the file’s', () => {
    expect(mimeTypeOf(STREAM)).toBe('video/mp4; codecs="avc1.640028"')
    expect(mimeTypeOf({ codec: 'hevc', codecString: 'hvc1.2.4.L153.B0' })).toBe(
      'video/mp4; codecs="hvc1.2.4.L153.B0"',
    )
    expect(mimeTypeOf(AC3)).toBe('audio/mp4; codecs="ac-3"')
    expect(mimeTypeOf({ codec: 'vp8', codecString: 'vp8' })).toBe('video/webm; codecs="vp8"')
    expect(mimeTypeOf({ codec: 'mp3', codecString: 'mp4a.6B' })).toBe('audio/mpeg')
    expect(mimeTypeOf({ codec: 'pcm_s16le', codecString: null })).toBeNull()
  })

  it('finds a video it plays without sound, and one it can’t play at all', () => {
    expect(playability(info([STREAM, AC3]), chrome)).toEqual({
      video: { stream: STREAM, decodes: true },
      audio: { stream: AC3, decodes: false },
    })
    const hevc = { ...STREAM, codec: 'hevc', codecString: 'hvc1.2.4.L153.B0' }
    expect(playability(info([hevc]), chrome)).toEqual({
      video: { stream: hevc, decodes: false },
      audio: null,
    })
  })

  it('plays the default sound, else the first', () => {
    const ac3 = { ...AC3, default: false }
    const aac = { ...AC3, index: 2, codec: 'aac', codecString: 'mp4a.40.2', default: false }
    expect(playability(info([STREAM, ac3, aac]), chrome).audio).toEqual({
      stream: ac3,
      decodes: false,
    })
    expect(playability(info([STREAM, ac3, { ...aac, default: true }]), chrome).audio).toEqual({
      stream: { ...aac, default: true },
      decodes: true,
    })
  })

  it('describes streams in a few words', () => {
    expect(describeVideo(STREAM)).toBe('H.264 High · 1920×1080 · 23.976 fps')
    expect(
      describeVideo({
        ...STREAM,
        codec: 'hevc',
        profile: 'Main 10',
        width: 3840,
        height: 2160,
        hdr: 'pq',
        rotation: 90,
      }),
    ).toBe('HEVC Main 10 · 2160×3840 · 23.976 fps · HDR10')
    expect(describeAudio(AC3).replaceAll(String.fromCharCode(0x2011), '-')).toBe(
      'Dolby Digital (AC-3) 5.1 · English',
    )
  })
})

describe('the player’s keys', () => {
  const key = (value: string, shiftKey = false) =>
    playerAction({ key: value, shiftKey, ctrlKey: false, metaKey: false, altKey: false })

  it('play, skip, change the volume and the speed, and jump', () => {
    expect(key(' ')).toEqual({ type: 'toggle' })
    expect(key('K', true)).toEqual({ type: 'toggle' })
    expect(key('j')).toEqual({ type: 'skip', seconds: -10 })
    expect(key('ArrowRight')).toEqual({ type: 'skip', seconds: 5 })
    expect(key('ArrowDown')).toEqual({ type: 'volume', by: -0.05 })
    expect(key('>', true)).toEqual({ type: 'speed', step: 1 })
    expect(key('7')).toEqual({ type: 'jump', fraction: 0.7 })
    expect(key('End')).toEqual({ type: 'jump', fraction: 1 })
  })

  it('leave Shift+← and Shift+→ to the viewer, and keys with Ctrl to the browser', () => {
    expect(key('ArrowLeft', true)).toBeNull()
    expect(key('ArrowRight', true)).toBeNull()
    expect(
      playerAction({ key: 'f', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false }),
    ).toBeNull()
  })

  it('step the speed through the list, and stop at its ends', () => {
    expect(stepSpeed(1, 1)).toBe(1.25)
    expect(stepSpeed(1, -1)).toBe(0.75)
    expect(stepSpeed(2, 1)).toBe(2)
    expect(stepSpeed(0.5, -1)).toBe(0.5)
    expect(stepSpeed(1.1, 1)).toBe(1.25)
    expect(stepSpeed(1.1, -1)).toBe(1)
  })
})

describe('play times', () => {
  it('show hours only when the video has them', () => {
    expect(formatPlayTime(7)).toBe('0:07')
    expect(formatPlayTime(754)).toBe('12:34')
    expect(formatPlayTime(3723)).toBe('1:02:03')
    expect(formatPlayTime(65, 7200)).toBe('0:01:05')
    expect(formatPlayTime(Number.NaN)).toBe('0:00')
  })
})

describe('how far it has loaded, as the seek bar shows it', () => {
  it('runs from where it plays to the end of the range it plays in', () => {
    expect(loadedUntil([[0, 42]], 10)).toBe(42)
    // After a seek: the range behind isn't drawn, and the one it plays in is.
    expect(
      loadedUntil(
        [
          [0, 30],
          [120, 150],
        ],
        125,
      ),
    ).toBe(150)
  })

  it('is the time itself where nothing is loaded yet, as just after a seek', () => {
    expect(loadedUntil([[0, 30]], 200)).toBe(200)
    expect(loadedUntil([], 0)).toBe(0)
    // A range starting a moment after the time, at a keyframe, counts.
    expect(loadedUntil([[60.3, 90]], 60)).toBe(90)
  })
})

describe('keeping where a viewer stopped', () => {
  const TEN_MINUTES = 600_000

  it('leaves the first 10 s alone, where every video starts with the offer to resume', () => {
    // Opening a video and leaving it at once keeps the offer for next time.
    expect(positionChange(0, TEN_MINUTES, false)).toBe('none')
    expect(positionChange(9_999, TEN_MINUTES, false)).toBe('none')
    expect(positionChange(9_999, Number.NaN, false)).toBe('none')
  })

  it('keeps a position past them, and clears it once the video is finished', () => {
    expect(positionChange(10_000, TEN_MINUTES, false)).toBe('keep')
    expect(positionChange(300_000, Number.NaN, false)).toBe('keep')
    expect(positionChange(0.95 * TEN_MINUTES, TEN_MINUTES, false)).toBe('clear')
    expect(positionChange(5_000, 6_000, true)).toBe('clear')
  })
})
