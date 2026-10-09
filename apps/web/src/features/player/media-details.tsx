import { isTextSubtitles, type MediaStream } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { FilePlace } from '@/lib/file-place'
import { connectionTestPath, mediaQuery } from './api'
import { ConnectionTest } from './connection-test'
import { decodingQuery, type Decoding } from './diagnostics'
import {
  browserCanPlayType,
  codecLabel,
  describeAudio,
  describeVideo,
  languageName,
  playability,
} from './codecs'
import { formatPlayTime } from './time'

// A video's Details (DESIGN.md §10.4): its formats from the media info, and
// how it plays in this browser, or why it can't.

/** Rows for the viewer's Details, in its grid: of a drive's file or a link's. */
export function MediaDetails({ place }: { place: FilePlace }) {
  const media = useQuery(mediaQuery(place))
  const decoding = useQuery(
    decodingQuery(place.path, media.data?.versionId ?? null, media.data?.info ?? null),
  ).data
  if (media.isPending) return <Row label="Formats">Reading…</Row>
  if (media.error) return <Row label="Formats">Can’t be read just now</Row>
  const { info, problem } = media.data
  if (!info) return <Row label="Formats">{problem ?? 'Unknown'}</Row>

  const { video, audio } = playability(info, browserCanPlayType)
  const sounds = info.streams.filter((stream) => stream.type === 'audio')
  const subtitles = info.streams.filter((stream) => stream.type === 'subtitle')
  return (
    <>
      {info.durationMs !== null && (
        <Row label="Length">{formatPlayTime(info.durationMs / 1000)}</Row>
      )}
      {video && <Row label="Video">{describeVideo(video.stream)}</Row>}
      {sounds.length > 0 && (
        <Row label="Sound">
          {sounds.map((stream) => (
            <span key={stream.index} className="block">
              {describeAudio(stream)}
              {sounds.length > 1 && stream === audio?.stream && ' (plays)'}
            </span>
          ))}
        </Row>
      )}
      {subtitles.length > 0 && (
        <Row label="Subtitles">
          {subtitles.map((stream) => (
            <span key={stream.index} className="block">
              {describeSubtitles(stream)}
            </span>
          ))}
        </Row>
      )}
      {info.chapters.length > 0 && <Row label="Chapters">{info.chapters.length}</Row>}
      {decoding && <Row label="Decoding">{describeDecoding(decoding)}</Row>}
      <Row label="Connection">
        <ConnectionTest path={connectionTestPath(place)} />
      </Row>
      <Row label="Plays here">
        {video?.decodes === false
          ? `No: this browser can’t play ${codecLabel(video.stream.codec)} video`
          : audio?.decodes === false
            ? `Without sound: this browser can’t play ${codecLabel(audio.stream.codec)}`
            : video?.decodes === true || (!video && audio?.decodes === true)
              ? 'Directly'
              : 'If this browser can open it'}
      </Row>
    </>
  )
}

/** What the browser said of decoding it (Media Capabilities). */
function describeDecoding(decoding: Decoding): string {
  if (!decoding.supported) return 'Not supported here'
  const where = decoding.powerEfficient ? 'in hardware' : 'in software'
  return decoding.smooth ? `Smooth, ${where}` : `May not keep up, ${where}`
}

function describeSubtitles(stream: MediaStream): string {
  const said = [languageName(stream.language), stream.title, codecLabel(stream.codec)]
  if (stream.forced) said.push('forced')
  if (!isTextSubtitles(stream)) said.push('pictures, not shown')
  return said.filter(Boolean).join(' · ')
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}
