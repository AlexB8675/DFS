import { describe, expect, it } from 'vitest'
import { fileCategory } from './file-types.ts'
import { mediaInfoSchema, mediaKind } from './media.ts'

describe('mediaKind (§6.7)', () => {
  it('goes by the MIME type, else by the name', () => {
    expect(mediaKind('Film.bin', 'video/mp4')).toBe('video')
    expect(mediaKind('Song.bin', 'audio/mpeg')).toBe('audio')
    // Browsers leave MKV's out.
    expect(mediaKind('Film.MKV', null)).toBe('video')
    expect(mediaKind('Film.mkv', 'application/octet-stream')).toBe('video')
    expect(mediaKind('Book.m4b', '')).toBe('audio')
  })

  it('leaves other files alone, and .ts to its MIME type', () => {
    expect(mediaKind('Report.pdf', 'application/pdf')).toBeNull()
    expect(mediaKind('notes', null)).toBeNull()
    expect(mediaKind('app.ts', null)).toBeNull()
    expect(mediaKind('recording.ts', 'video/mp2t')).toBe('video')
  })

  it('agrees with the file categories', () => {
    expect(fileCategory('Film.m4v', null)).toBe('video')
    expect(fileCategory('Song.opus', null)).toBe('audio')
  })
})

describe('mediaInfoSchema', () => {
  it('refuses more than a file should hold', () => {
    const stream = {
      index: 0,
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
      language: null,
      title: null,
      default: true,
      forced: false,
    }
    const info = {
      kind: 'audio',
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationMs: 1000,
      bitRate: 128_000,
      streams: [stream],
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
    expect(mediaInfoSchema.safeParse(info).success).toBe(true)
    expect(mediaInfoSchema.safeParse({ ...info, streams: Array(65).fill(stream) }).success).toBe(
      false,
    )
    expect(
      mediaInfoSchema.safeParse({ ...info, tags: { ...info.tags, title: 'x'.repeat(301) } })
        .success,
    ).toBe(false)
  })
})
