import type { MediaInfo, MediaStream } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import {
  decodingConfiguration,
  formatBitRate,
  playbackNotices,
  type PlaybackSignals,
} from './diagnostics'

/** The video that took a phone two minutes: 4K, 60 fps, 10-bit HDR AV1 at 24 Mbit/s. */
const AV1: MediaStream = {
  index: 0,
  type: 'video',
  codec: 'av1',
  codecString: 'av01.0.13M.10',
  profile: 'Main',
  width: 3840,
  height: 2160,
  frameRate: 59.94,
  bitDepth: 10,
  hdr: 'pq',
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

const INFO: MediaInfo = {
  kind: 'video',
  container: 'matroska,webm',
  durationMs: 126_561,
  bitRate: 24_282_105,
  streams: [AV1],
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

const QUIET: PlaybackSignals = { waitingForMs: 0, arrivalBitsPerSecond: null, droppedShare: null }

function notices(overrides: Partial<Parameters<typeof playbackNotices>[0]>) {
  return playbackNotices({
    silentCodec: null,
    decoding: { supported: true, smooth: true, powerEfficient: true },
    picture: AV1,
    bitRate: INFO.bitRate,
    signals: QUIET,
    ...overrides,
  }).map((notice) => notice.text)
}

describe('asking the browser about decoding a video', () => {
  it('asks with the picture’s codec, size, frame rate, bitrate and HDR', () => {
    expect(decodingConfiguration(INFO)).toEqual({
      type: 'file',
      video: {
        contentType: 'video/mp4; codecs="av01.0.13M.10"',
        width: 3840,
        height: 2160,
        bitrate: 24_282_105,
        framerate: 59.94,
        transferFunction: 'pq',
      },
    })
    expect(decodingConfiguration({ ...INFO, streams: [] })).toBeNull()
  })
})

describe('the player’s warnings', () => {
  it('says nothing of a play going well', () => {
    expect(notices({})).toEqual([])
  })

  it('warns when the browser says it may not keep up', () => {
    expect(
      notices({ decoding: { supported: true, smooth: false, powerEfficient: false } }),
    ).toEqual([
      'This device may not keep up with 4K · 60 fps · AV1 · HDR: it may stutter or be slow to start.',
    ])
  })

  it('says when the video arrives slower than it plays, after waiting a few seconds', () => {
    const slow = { waitingForMs: 5000, arrivalBitsPerSecond: 2_700_000, droppedShare: null }
    expect(notices({ signals: slow })).toEqual([
      'Loading slowly: the video arrives at 2.7 Mbit/s and needs 24.3 Mbit/s, so it stops to load.',
    ])
    // Not yet: a moment's wait is normal.
    expect(notices({ signals: { ...slow, waitingForMs: 2000 } })).toEqual([])
    // Arriving fast enough, the wait is something else.
    expect(notices({ signals: { ...slow, arrivalBitsPerSecond: 30_000_000 } })).toEqual([])
  })

  it('says when the device drops many frames', () => {
    expect(notices({ signals: { ...QUIET, droppedShare: 0.35 } })).toEqual([
      'This device is dropping 35% of the frames: it can’t keep up with this video.',
    ])
    expect(notices({ signals: { ...QUIET, droppedShare: 0.05 } })).toEqual([])
  })

  it('formats rates as people read them', () => {
    expect(formatBitRate(24_282_105)).toBe('24.3 Mbit/s')
    expect(formatBitRate(640_000)).toBe('640 kbit/s')
  })
})
