import { readFileSync } from 'node:fs'
import type { MediaInfo, ProbeResult } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { toMediaInfo } from './media-info.ts'

// ffprobe's answers for the files testing/make-fixtures.sh makes, kept as
// ffprobe 7.1 in the media image gave them, so reading them is tested
// without ffmpeg. service.test.ts asks the real one.

function answer(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`testing/ffprobe/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>
}

function info(result: ProbeResult): MediaInfo {
  if (!result.ok) throw new Error(`Not media: ${result.reason}`)
  return result.info
}

describe('toMediaInfo (§6.7)', () => {
  it('reads a film: HEVC in HDR, AC-3 in 5.1, a forced subtitle and chapters', () => {
    const film = info(toMediaInfo(answer('film.mkv')))
    expect(film).toMatchObject({ kind: 'video', container: 'matroska,webm', hasCover: false })
    const [video, audio, subtitle] = film.streams
    expect(video).toMatchObject({
      type: 'video',
      codec: 'hevc',
      codecString: 'hvc1.2.4.L60.B0',
      profile: 'Main 10',
      width: 320,
      height: 240,
      frameRate: 24,
      bitDepth: 10,
      hdr: 'pq',
      dolbyVision: null,
      rotation: null,
    })
    expect(audio).toMatchObject({
      type: 'audio',
      codec: 'ac3',
      codecString: 'ac-3',
      channels: 6,
      channelLayout: '5.1(side)',
      sampleRate: 48_000,
      language: 'eng',
    })
    expect(subtitle).toMatchObject({
      type: 'subtitle',
      codec: 'subrip',
      codecString: null,
      language: 'ita',
      title: 'Italiano',
      forced: true,
    })
    expect(film.chapters).toEqual([
      { startMs: 0, endMs: 1000, title: 'Opening' },
      { startMs: 1000, endMs: 2000, title: 'Ending' },
    ])
  })

  it('reads a phone’s video, and which way to turn it', () => {
    const phone = info(toMediaInfo(answer('phone.mp4')))
    expect(phone.kind).toBe('video')
    expect(phone.streams.map((stream) => stream.codecString)).toEqual(['avc1.42400D', 'mp4a.40.2'])
    expect(phone.streams[0]?.rotation).toBe(90)
    expect(phone.durationMs).toBeGreaterThan(1900)
  })

  it('reads an old AVI, whose codecs browsers don’t play, as it is', () => {
    const old = info(toMediaInfo(answer('old.avi')))
    expect(old.container).toBe('avi')
    expect(old.streams.map((stream) => [stream.codec, stream.codecString])).toEqual([
      ['mpeg4', 'mp4v.20.9'],
      ['mp3', 'mp4a.6B'],
    ])
  })

  it('reads music’s tags, and its cover as a cover rather than a video', () => {
    const song = info(toMediaInfo(answer('song.mp3')))
    expect(song.kind).toBe('audio')
    expect(song.hasCover).toBe(true)
    expect(song.streams.map((stream) => stream.type)).toEqual(['audio'])
    expect(song.tags).toEqual({
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      albumArtist: 'Various',
      genre: 'Rock',
      track: 3,
      disc: 1,
      year: 2019,
    })
    const track = info(toMediaInfo(answer('track.flac')))
    expect(track.streams[0]?.codecString).toBe('flac')
    expect(track.tags).toMatchObject({ title: 'Track', artist: 'Band', track: 5, year: 2001 })
  })

  it('says a file without audio or video isn’t media', () => {
    expect(toMediaInfo({ format: { format_name: 'mp3' }, streams: [] })).toEqual({
      ok: false,
      reason: 'It holds no audio or video.',
    })
    expect(toMediaInfo({ streams: 'many' }).ok).toBe(false)
    expect(toMediaInfo(null).ok).toBe(false)
  })

  it('reads Dolby Vision and HLG, and keeps nothing out of bounds', () => {
    const film = answer('film.mkv') as { streams: Record<string, unknown>[] }
    const [video] = film.streams
    if (!video) throw new Error('No video in the film.')
    const dolby = info(
      toMediaInfo({
        ...film,
        streams: [
          {
            ...video,
            side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 8 }],
          },
        ],
      }),
    )
    expect(dolby.streams[0]?.dolbyVision).toBe(8)
    const hlg = info(
      toMediaInfo({ ...film, streams: [{ ...video, color_transfer: 'arib-std-b67' }] }),
    )
    expect(hlg.streams[0]?.hdr).toBe('hlg')

    const crafted = info(
      toMediaInfo({
        ...film,
        streams: Array.from({ length: 100 }, () => ({
          ...video,
          width: 10_000_000,
          tags: { title: 'x'.repeat(10_000), language: 'und' },
        })),
      }),
    )
    expect(crafted.streams).toHaveLength(64)
    expect(crafted.streams[0]).toMatchObject({ width: null, language: null })
    expect(crafted.streams[0]?.title).toHaveLength(300)
  })
})
