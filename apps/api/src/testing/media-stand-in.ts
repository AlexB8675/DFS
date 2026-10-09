import type { MediaInfo, ProbeResult, SubtitleTracksResult } from '@dfs/shared'

// A stand-in for the media service (DESIGN.md §6.7), for tests that need one
// without ffmpeg: every file it is asked about is a short H.264 and AAC video
// with Italian subtitles inside.

/** What the stand-in finds in every file. */
export const STAND_IN_VIDEO: MediaInfo = {
  kind: 'video',
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs: 10_000,
  bitRate: 2_500_000,
  streams: [
    {
      index: 0,
      type: 'video',
      codec: 'h264',
      codecString: 'avc1.640028',
      profile: 'High',
      width: 1920,
      height: 1080,
      frameRate: 30,
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
    },
    {
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
    },
    {
      index: 2,
      type: 'subtitle',
      codec: 'subrip',
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
      language: 'ita',
      title: null,
      default: false,
      forced: false,
    },
  ],
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

/** What the stand-in makes of a subtitle stream. */
export const STAND_IN_SUBTITLES = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCiao\n'

/** The media service's HTTP, for `buildApp`'s `mediaFetch`. */
export const standInMediaFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  if (url.pathname === '/health') {
    return Promise.resolve(
      Response.json({ status: 'ok', release: 'test', ffmpeg: 'ffprobe version 7.1' }),
    )
  }
  if (url.pathname === '/probe') {
    const result: ProbeResult = { ok: true, info: STAND_IN_VIDEO }
    return Promise.resolve(Response.json(result))
  }
  if (url.pathname === '/subtitles') {
    const { streams } = JSON.parse(init?.body as string) as { streams: number[] }
    const result: SubtitleTracksResult = {
      ok: true,
      tracks: streams.map((index) => ({ index, vtt: STAND_IN_SUBTITLES, problem: null })),
    }
    return Promise.resolve(Response.json(result))
  }
  return Promise.resolve(new Response(null, { status: 404 }))
}
