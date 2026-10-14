import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useParams } from 'react-router'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { contentUrl, playbackQuery } from '@/features/player/api'
import { apiFetch, errorMessage } from '@/lib/api/client'
import { drivePlace, type FilePlace } from '@/lib/file-place'
import { playBuffered, type BufferedStats } from './buffered-player'
import {
  buildLabReport,
  downloadMbit,
  markFirstFrame,
  markPlaying,
  markWaiting,
  newTrace,
  NO_NUMBERS,
  OPENING_STATS,
  readVideo,
  stallTotals,
  type LabTrace,
  type SentReason,
  type VideoNumbers,
} from './lab-report'
import { aheadSeconds } from './tracks'

// A trial page for buffered play (DESIGN.md §10.4), reachable only by its
// address, `/lab/stream/:nodeId`: nothing links to it. It plays one of the
// user's videos through Media Source with DFS's own buffer, shows the numbers
// live, and sends them to the server log in the play report, to compare with
// the regular player on a phone that can't play the file with `<video src>`.

/** How often the video element's numbers are read. */
const NUMBERS_MS = 500

/** How long after the first frame the report goes by itself. */
const AUTO_REPORT_MS = 60_000

/**
 * Runs the trial: Start plays the version through `playBuffered`, the video's
 * events and a timer keep its numbers, and the report goes to the API on
 * `send('button')`, when the page is hidden or left, and once 60 s after the
 * first frame.
 */
function useBufferedLab(
  videoRef: RefObject<HTMLVideoElement | null>,
  place: FilePlace,
  versionId: string | null,
) {
  const playing = useRef<AbortController | null>(null)
  const trace = useRef<LabTrace>(newTrace())
  const latest = useRef<BufferedStats>(OPENING_STATS)
  const reporter = useRef<((reason: SentReason) => void) | null>(null)
  const [stats, setStats] = useState<BufferedStats | null>(null)
  const [numbers, setNumbers] = useState<VideoNumbers>(NO_NUMBERS)
  const [reports, setReports] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video || versionId === null) return
    const sent = new Set<SentReason>()
    // Each kind goes once, except the button's.
    const send = (reason: SentReason) => {
      if (trace.current.startedAt === null || (reason !== 'button' && sent.has(reason))) return
      sent.add(reason)
      const body = buildLabReport({
        versionId,
        reason,
        stats: latest.current,
        trace: trace.current,
        video: readVideo(video),
        now: performance.now(),
      })
      apiFetch(`${place.path}/playback-report`, { method: 'POST', json: body, keepalive: true })
        .then(() => {
          setReports((count) => count + 1)
        })
        .catch(() => undefined)
    }
    reporter.current = send

    let autoTimer: number | undefined
    const onFirstFrame = () => {
      markFirstFrame(trace.current, performance.now())
      autoTimer ??= window.setTimeout(() => {
        send('auto')
      }, AUTO_REPORT_MS)
    }
    const onPlaying = () => {
      markPlaying(trace.current, performance.now())
    }
    const onWaiting = () => {
      markWaiting(trace.current, performance.now(), video.paused)
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') send('hidden')
    }
    const onPageHide = () => {
      send('hidden')
    }
    const refresh = () => {
      if (trace.current.startedAt === null) return
      setNumbers({
        ...readVideo(video),
        aheadSeconds: aheadSeconds(video.buffered, video.currentTime),
        ...stallTotals(trace.current, performance.now()),
      })
    }

    video.addEventListener('loadeddata', onFirstFrame)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    const timer = window.setInterval(refresh, NUMBERS_MS)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(autoTimer)
      video.removeEventListener('loadeddata', onFirstFrame)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      reporter.current = null
    }
  }, [videoRef, place.path, versionId])

  // Leaving stops the play and lets go of the object URL `playBuffered` gave the element.
  useEffect(() => {
    const video = videoRef.current
    return () => {
      playing.current?.abort()
      if (!video) return
      if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src)
      video.removeAttribute('src')
      video.load()
    }
  }, [videoRef])

  /** Called by the Start button, whose click is the gesture autoplay needs. */
  const start = () => {
    const video = videoRef.current
    if (!video || versionId === null || playing.current) return
    const controller = new AbortController()
    playing.current = controller
    trace.current.startedAt = performance.now()
    setStats(OPENING_STATS)
    void playBuffered({
      video,
      url: contentUrl(place, versionId),
      signal: controller.signal,
      onStats: (next) => {
        latest.current = next
        setStats(next)
      },
    })
    void video.play().catch(() => undefined)
  }

  const send = (reason: SentReason) => {
    reporter.current?.(reason)
  }

  return { stats, numbers, reports, start, send }
}

/** A number to `digits` places, or a dash where there is none yet. */
function fixed(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '–'
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}:</dt>
      <dd className="font-mono break-all">{children}</dd>
    </div>
  )
}

/**
 * `/lab/stream/:nodeId`: tries buffered play on one of the user's videos
 * and shows how it goes (§10.4). A trial, reachable only by its address.
 */
export function LabStreamPage() {
  const { nodeId = '' } = useParams()
  const place = drivePlace(nodeId)
  const playback = useQuery(playbackQuery(place))
  const versionId = playback.data?.versionId ?? null
  const videoRef = useRef<HTMLVideoElement>(null)
  const lab = useBufferedLab(videoRef, place, versionId)
  const { stats, numbers } = lab
  const shown = stats ?? OPENING_STATS
  const rate = downloadMbit(shown)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>Buffered play (trial) – DFS</title>
      <PageHeader title="Buffered play (trial)" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-3 p-4 text-sm">
          <p>
            Plays this video through Media Source with DFS’s own buffer, to compare with the regular
            player.
          </p>
          {playback.isError && (
            <p role="alert" className="text-destructive">
              {errorMessage(playback.error)}
            </p>
          )}
          <video ref={videoRef} controls playsInline className="max-h-[60vh] w-full bg-black" />
          {stats === null && (
            <Button
              disabled={versionId === null}
              onClick={() => {
                lab.start()
              }}
            >
              Start
            </Button>
          )}
          <dl className="space-y-1">
            <Line label="phase">{stats === null ? 'not started' : stats.phase}</Line>
            <Line label="codecs">{shown.codecs.length > 0 ? shown.codecs.join(', ') : '–'}</Line>
            {Object.entries(shown.supported).map(([mime, supported]) => (
              <Line key={mime} label={mime}>
                {supported ? 'yes' : 'no'}
              </Line>
            ))}
            <Line label="received MB">{fixed(shown.bytesReceived / 1e6)}</Line>
            <Line label="download rate while reading, Mbit/s">
              {rate === null ? '–' : fixed(rate)}
            </Line>
            <Line label="held s">{fixed(shown.heldMs / 1000)}</Line>
            <Line label="ahead s / target s">
              {fixed(numbers.aheadSeconds)} / {fixed(shown.targetAheadSeconds)}
            </Line>
            <Line label="played s / duration s">
              {fixed(numbers.playedSeconds)} / {fixed(numbers.durationSeconds)}
            </Line>
            <Line label="stalls / stall s">
              {numbers.stalls} / {fixed(numbers.stallMs / 1000)}
            </Line>
            <Line label="frames / dropped">
              {numbers.frames} / {numbers.droppedFrames}
            </Line>
            <Line label="quota errors">{shown.quotaErrors}</Line>
            <Line label="reopens">{shown.reopens}</Line>
            <Line label="error">{shown.error ?? '–'}</Line>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={stats === null}
              onClick={() => {
                lab.send('button')
              }}
            >
              Send report
            </Button>
            <span className="text-muted-foreground">Reports sent: {lab.reports}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
