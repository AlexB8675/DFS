import type { MediaInfo, MediaStream } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import {
  arrivalBetween,
  decodingConfiguration,
  formatBitRate,
  playbackNotices,
  waitingForData,
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

const QUIET: PlaybackSignals = {
  waitingForMs: 0,
  arrivalBitsPerSecond: null,
  waitingOn: null,
  droppedShare: null,
}

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
      'This device may not keep up with 4K · 60 fps · AV1 · HDR, which it decodes in software: it may stutter or be slow to start.',
    ])
    expect(notices({ decoding: { supported: true, smooth: false, powerEfficient: true } })).toEqual(
      [
        'This device may not keep up with 4K · 60 fps · AV1 · HDR: it may stutter or be slow to start.',
      ],
    )
  })

  it('says when the device decodes in software, in a warning that fades', () => {
    const shown = playbackNotices({
      silentCodec: null,
      decoding: { supported: true, smooth: true, powerEfficient: false },
      picture: AV1,
      bitRate: INFO.bitRate,
      signals: QUIET,
    })
    expect(shown).toEqual([
      {
        key: 'software',
        text: 'This device decodes 4K · 60 fps · AV1 · HDR in software, not in hardware: it may play less smoothly, warm up and drain its battery.',
        fades: true,
      },
    ])
    // Nothing to say of a codec it can't decode at all: the player says it can't play.
    expect(
      notices({ decoding: { supported: false, smooth: false, powerEfficient: false } }),
    ).toEqual([])
  })

  it('says when the video arrives slower than it plays, after waiting a few seconds', () => {
    const slow: PlaybackSignals = { ...QUIET, waitingForMs: 5000, arrivalBitsPerSecond: 2_700_000 }
    expect(notices({ signals: slow })).toEqual([
      'Loading slowly: the video arrives at 2.7 Mbit/s and needs 24.3 Mbit/s, so it stops to load.',
    ])
    // With the side the server waited on.
    expect(notices({ signals: { ...slow, waitingOn: 'connection' } })).toEqual([
      'Loading slowly: the video arrives at 2.7 Mbit/s and needs 24.3 Mbit/s, so it stops to load. The server has it ready and waits on this device’s connection.',
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

describe('telling a wait for data from other waits', () => {
  const HAVE_METADATA = 1
  const HAVE_ENOUGH_DATA = 4

  it('counts a video asked to play without its first frame or enough data', () => {
    expect(waitingForData({ paused: false, ended: false, readyState: HAVE_METADATA }, false)).toBe(
      true,
    )
    // A stall, or a seek, after the first frame.
    expect(waitingForData({ paused: false, ended: false, readyState: HAVE_METADATA }, true)).toBe(
      true,
    )
    expect(
      waitingForData({ paused: false, ended: false, readyState: HAVE_ENOUGH_DATA }, true),
    ).toBe(false)
  })

  it('leaves out a video paused before its first frame, which waits for its viewer', () => {
    expect(waitingForData({ paused: true, ended: false, readyState: 0 }, false)).toBe(false)
    expect(waitingForData({ paused: false, ended: true, readyState: HAVE_METADATA }, true)).toBe(
      false,
    )
  })
})

describe('what the server sent between two asks', () => {
  const totals = (bytes: number, running: number, clientMs = 0) => ({
    bytes,
    waitedForSourceMs: 0,
    waitedForClientMs: clientMs,
    running,
  })

  it('is the difference, with the waits on each side', () => {
    expect(arrivalBetween(totals(1000, 1), totals(5000, 1, 1500), 2000)).toEqual({
      ms: 2000,
      bytes: 4000,
      sourceMs: 0,
      clientMs: 1500,
    })
    // A read running that sent nothing in the time: a connection at 0.
    expect(arrivalBetween(totals(1000, 1), totals(1000, 1), 2000)?.bytes).toBe(0)
  })

  it('says nothing when no read ran, or the server forgot its totals', () => {
    expect(arrivalBetween(totals(1000, 0), totals(1000, 0), 2000)).toBeNull()
    expect(arrivalBetween(totals(9000, 1), totals(100, 1), 2000)).toBeNull()
  })
})
