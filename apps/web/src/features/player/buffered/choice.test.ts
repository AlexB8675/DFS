import type { MediaInfo, MediaStream } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { playsBuffered } from './choice'

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

describe('choosing a video’s own buffer', () => {
  it('plays an MP4 with a picture and one sound track through the buffer', () => {
    expect(playsBuffered(PROOF, true)).toBe(true)
  })

  it('plays a video with no sound at all through the buffer', () => {
    expect(playsBuffered({ ...PROOF, streams: [HEVC] }, true)).toBe(true)
  })

  it('leaves it to the element when the browser has no Media Source', () => {
    expect(playsBuffered(PROOF, false)).toBe(false)
  })

  it('leaves Matroska and WebM to the element', () => {
    expect(playsBuffered({ ...PROOF, container: 'matroska,webm' }, true)).toBe(false)
  })

  it('leaves a video with two sound tracks to the element', () => {
    expect(playsBuffered({ ...PROOF, streams: [HEVC, AAC, AAC_ITALIAN] }, true)).toBe(false)
  })

  it('leaves audio files to the audio bar, even one whose cover is a picture stream', () => {
    expect(playsBuffered({ ...PROOF, kind: 'audio' }, true)).toBe(false)
  })

  it('leaves a file with no picture to the element', () => {
    expect(playsBuffered({ ...PROOF, streams: [AAC] }, true)).toBe(false)
  })
})
