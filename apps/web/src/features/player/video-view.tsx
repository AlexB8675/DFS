import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, Download, Film, Play, RotateCcw, Snail, VolumeX, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import type { ViewHandle } from '@/features/preview/view-handle'
import { errorMessage } from '@/lib/api/client'
import { isEditable } from '@/lib/editable'
import { cn } from '@/lib/utils'
import { contentUrl, mediaQuery, playbackQuery } from './api'
import { browserCanPlayType, codecLabel, playability, playedStreams } from './codecs'
import { chooseAudioTrack } from './audio-tracks'
import { Controls, type Chapter } from './controls'
import {
  decodingQuery,
  playbackNotices,
  usePlaybackStats,
  type PlaybackNotice,
} from './diagnostics'
import { playerAction, stepSpeed, type PlayerAction } from './keys'
import { usePlayerPreferences } from './preferences'
import {
  defaultSubtitle,
  subtitleOptions,
  toggledSubtitle,
  type SubtitleOption,
} from './subtitle-options'
import { SubtitleOverlay } from './subtitle-overlay'
import { formatPlayTime } from './time'
import { useMediaState } from './use-media-state'
import { RESUME_FROM_MS, useResume } from './use-resume'

// The video player (DESIGN.md §10.4): direct play of the version the API
// names, from where the user stopped, with controls of its own over the
// picture. It starts at once, without waiting for the media info, which,
// when it comes, says whether this browser decodes the picture and the
// sound, and brings the chapters and the subtitles inside the file.

interface VideoViewProps {
  name: string
  /** Where the file's bytes are, as an API path (`/files/:id/content`). */
  contentPath: string
  /** `false` while the viewer closes: it stops at once. */
  active: boolean
  ref?: Ref<ViewHandle>
  onDownload: () => void
  /** A swipe on a touch screen: 1 for the next file, -1 for the previous. */
  onSwipe: (direction: 1 | -1) => void
}

/** What stands in the way of playing. */
type Problem =
  /** The browser can't decode the picture (from the media info). */
  | { kind: 'codec'; codec: string }
  /** The browser couldn't open the file, or decode it. */
  | { kind: 'unsupported' | 'decode'; detail: string }
  /** A read of the file failed while it played. */
  | { kind: 'network' }
  /** The file has another version since it started. */
  | { kind: 'replaced'; versionId: string }

/** What the element plays: a version, from a time, and how many times it was started. */
interface Source {
  versionId: string
  startAt: number
  attempt: number
}

/** While it plays untouched, the controls hide after this long. */
const HIDE_AFTER_MS = 2500
/** A second tap within this long, on the same side, skips. */
const DOUBLE_TAP_MS = 300
const SKIP_TAP_SECONDS = 10
/** A swipe is this many pixels across, and more across than down. */
const SWIPE_PX = 60
/** How long “Resumed at …” stays. */
const RESUMED_NOTE_MS = 8000
/** Each warning's icon. */
const NOTICE_ICONS: Record<PlaybackNotice['key'], ReactNode> = {
  sound: <VolumeX />,
  decoding: <Cpu />,
  slow: <Snail />,
  dropping: <Film />,
}

interface Gesture {
  start: { x: number; y: number; type: string } | null
  /** The last pointer's type: a double-click goes full screen only with a mouse. */
  lastType: string
  lastTap: { at: number; side: -1 | 0 | 1 } | null
  tapTimer: number
}

export default function VideoView({
  name,
  contentPath,
  active,
  ref,
  onDownload,
  onSwipe,
}: VideoViewProps) {
  const base = baseOf(contentPath)
  const queryClient = useQueryClient()
  const playback = useQuery(playbackQuery(base))
  const media = useQuery(mediaQuery(base))
  const setVolumePreference = usePlayerPreferences((state) => state.setVolume)
  const subtitlePreference = usePlayerPreferences((state) => state.subtitles)
  const setSubtitlePreference = usePlayerPreferences((state) => state.setSubtitles)

  // The version /playback named, from where the user stopped, played until the viewer moves on.
  const [source, setSource] = useState<Source | null>(null)
  /** Where it picked up, for “Resumed at …”, until that goes. */
  const [resumedAt, setResumedAt] = useState<number | null>(null)
  if (source === null && playback.data) {
    const { versionId, positionMs } = playback.data
    const startAt = positionMs !== null && positionMs >= RESUME_FROM_MS ? positionMs / 1000 : 0
    setSource({ versionId, startAt, attempt: 0 })
    if (startAt > 0) setResumedAt(startAt)
  }
  const [problem, setProblem] = useState<Problem | null>(null)
  /** The element showed no picture: Chrome plays the sound of a video it can't decode. */
  const [blank, setBlank] = useState(false)
  /** Warnings dismissed in this video. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  /** Asked to play, and not playing yet nor refused: a spinner, not a play button. */
  const [starting, setStarting] = useState(true)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const attachRoot = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element
    setRoot(element)
  }, [])
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element
    setVideo(element)
    if (element) {
      // The volume chosen last, for every video.
      const { volume, muted } = usePlayerPreferences.getState()
      element.volume = volume
      element.muted = muted
      // Without a click first (an address opened or reloaded), the browser may refuse.
      setStarting(true)
      element
        .play()
        .catch(() => undefined)
        .finally(() => {
          setStarting(false)
        })
    }
  }, [])

  const state = useMediaState(video)
  const [awake, setAwake] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const hideTimer = useRef(0)
  const [fullscreen, setFullscreen] = useState(false)
  const gesture = useRef<Gesture>({ start: null, lastType: '', lastTap: null, tapTimer: 0 })
  const [ripple, setRipple] = useState<{ side: -1 | 1; at: number } | null>(null)

  // What the media info says of this browser, once it comes, for the version playing.
  const info = source && media.data?.versionId === source.versionId ? media.data.info : null
  const verdict = info ? playability(info, browserCanPlayType) : null
  const picture = verdict?.video
  const pictureFails =
    picture && (picture.decodes === false || (blank && picture.decodes !== true))
      ? codecLabel(picture.stream.codec)
      : null
  const silentCodec =
    verdict?.audio?.decodes === false ? codecLabel(verdict.audio.stream.codec) : null
  const shown: Problem | null =
    problem ?? (pictureFails ? { kind: 'codec', codec: pictureFails } : null)
  const stopped = shown !== null
  const visible = awake || state.paused || menuOpen

  // Why it may be slow, as far as the player can tell, and the play's report when it ends.
  const decoding = useQuery(decodingQuery(base, source?.versionId ?? null, info)).data ?? null
  const signals = usePlaybackStats(
    video,
    base,
    source?.versionId ?? null,
    {
      bitRate: info?.bitRate ?? null,
      decoding,
      problem: shown && problemText(shown),
    },
    active,
  )
  const notices = playbackNotices({
    silentCodec,
    decoding,
    picture: info ? playedStreams(info).video : null,
    bitRate: info?.bitRate ?? null,
    signals,
  })
  const shownNotices = stopped ? [] : notices.filter((notice) => !dismissed.has(notice.key))

  const chapters = useMemo<Chapter[]>(
    () =>
      info?.chapters.map((chapter, i) => ({
        start: chapter.startMs / 1000,
        title: chapter.title ?? `Chapter ${String(i + 1)}`,
      })) ?? [],
    [info],
  )

  // Subtitles: beside the file at once, inside it once the media info comes.
  const subtitleFiles = playback.data?.subtitleFiles
  const options = useMemo<SubtitleOption[]>(
    () =>
      source
        ? subtitleOptions(baseOf(contentPath), source.versionId, subtitleFiles ?? [], info)
        : [],
    // The prop, not `base`: the compiler takes a string it made for one it might change.
    [contentPath, info, subtitleFiles, source],
  )
  /** The viewer's own choice in this video; until then, the default. */
  const [choice, setChoice] = useState<{ key: string | null } | null>(null)
  const chosen = choice ? choice.key : defaultSubtitle(options, subtitlePreference)
  const tracks = useRef(new Map<string, HTMLTrackElement>())
  const [track, setTrack] = useState<{
    key: string
    text: TextTrack
    status: 'loading' | 'ready' | 'failed'
  } | null>(null)

  const chooseSubtitles = useCallback(
    (key: string | null) => {
      setChoice({ key })
      const option = options.find((found) => found.key === key)
      if (!option) setSubtitlePreference({ ...subtitlePreference, on: false })
      else if (!option.forced) setSubtitlePreference({ on: true, language: option.language })
    },
    [options, setSubtitlePreference, subtitlePreference],
  )

  // The chosen track loads, hidden, for the player to draw; the others stay off.
  useEffect(() => {
    if (!video) return
    let element: HTMLTrackElement | null = null
    for (const [key, candidate] of tracks.current) {
      candidate.track.mode = key === chosen ? 'hidden' : 'disabled'
      if (key === chosen) element = candidate
    }
    // None: what was drawn is another key's, and goes.
    if (!element || chosen === null) return
    const shown = element
    const statusOf = () =>
      shown.readyState === HTMLTrackElement.LOADED
        ? 'ready'
        : shown.readyState === HTMLTrackElement.ERROR
          ? 'failed'
          : 'loading'
    const update = () => {
      setTrack({ key: chosen, text: shown.track, status: statusOf() })
    }
    // An iPhone's own full screen draws subtitles itself.
    const native = (showing: boolean) => () => {
      shown.track.mode = showing ? 'showing' : 'hidden'
    }
    const begin = native(true)
    const end = native(false)
    shown.addEventListener('load', update)
    shown.addEventListener('error', update)
    video.addEventListener('webkitbeginfullscreen', begin)
    video.addEventListener('webkitendfullscreen', end)
    update()
    return () => {
      shown.removeEventListener('load', update)
      shown.removeEventListener('error', update)
      video.removeEventListener('webkitbeginfullscreen', begin)
      video.removeEventListener('webkitendfullscreen', end)
    }
  }, [chosen, options, video])

  const resume = useResume({
    base,
    video,
    versionId: source?.versionId ?? null,
    savedMs: playback.data?.positionMs ?? null,
  })
  useEffect(() => {
    if (resumedAt === null) return
    const timer = window.setTimeout(() => {
      setResumedAt(null)
    }, RESUMED_NOTE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [resumedAt])

  const wake = useCallback(() => {
    setAwake(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      setAwake(false)
    }, HIDE_AFTER_MS)
  }, [setAwake])

  useEffect(() => {
    const onChange = () => {
      setFullscreen(
        document.fullscreenElement !== null && document.fullscreenElement === rootRef.current,
      )
    }
    document.addEventListener('fullscreenchange', onChange)
    const timers = { hide: hideTimer, gesture: gesture.current }
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      window.clearTimeout(timers.hide.current)
      window.clearTimeout(timers.gesture.tapTimer)
    }
  }, [])

  useEffect(() => {
    if (!active) videoRef.current?.pause()
  }, [active])

  const seek = useCallback((seconds: number) => {
    const element = videoRef.current
    if (!element) return
    const end = Number.isFinite(element.duration) ? element.duration : seconds
    element.currentTime = Math.min(Math.max(0, seconds), end)
  }, [])

  const togglePlay = useCallback(() => {
    const element = videoRef.current
    if (!element) return
    if (element.paused || element.ended) void element.play().catch(() => undefined)
    else element.pause()
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    const element = videoRef.current
    const container = rootRef.current
    if (container && document.fullscreenEnabled) {
      container
        .requestFullscreen()
        .then(() => {
          lockOrientation(element)
        })
        .catch(() => undefined)
    } else if (element && hasNativeFullscreen(element)) {
      // An iPhone has full screen for videos alone: its own player.
      element.webkitEnterFullscreen()
    }
  }, [])

  const togglePictureInPicture = useCallback(() => {
    const element = videoRef.current
    if (document.pictureInPictureElement)
      void document.exitPictureInPicture().catch(() => undefined)
    else if (element) void element.requestPictureInPicture().catch(() => undefined)
  }, [])

  const setVolume = useCallback((volume: number, muted: boolean) => {
    const element = videoRef.current
    if (!element) return
    element.volume = Math.min(1, Math.max(0, volume))
    element.muted = muted
  }, [])

  const run = useCallback(
    (action: PlayerAction) => {
      const element = videoRef.current
      if (!element) return
      switch (action.type) {
        case 'toggle':
          togglePlay()
          break
        case 'skip':
          seek(element.currentTime + action.seconds)
          break
        case 'volume':
          setVolume(element.volume + action.by, false)
          break
        case 'mute':
          setVolume(element.volume, !element.muted)
          break
        case 'fullscreen':
          toggleFullscreen()
          break
        case 'subtitles':
          chooseSubtitles(toggledSubtitle(options, chosen, subtitlePreference))
          break
        case 'speed':
          element.playbackRate = stepSpeed(element.playbackRate, action.step)
          break
        case 'jump':
          if (Number.isFinite(element.duration)) seek(action.fraction * element.duration)
          break
      }
      wake()
    },
    [
      chooseSubtitles,
      chosen,
      options,
      seek,
      setVolume,
      subtitlePreference,
      toggleFullscreen,
      togglePlay,
      wake,
    ],
  )

  useImperativeHandle(
    ref,
    () => ({
      handleKey: (event) => {
        if (stopped || isEditable(event.target)) return false
        // Space and Enter on a focused button or menu are theirs.
        const target = event.target instanceof Element ? event.target : null
        if (
          (event.key === ' ' || event.key === 'Enter') &&
          target?.closest('button, a, [role^="menuitem"]')
        ) {
          return false
        }
        const action = playerAction(event)
        if (!action) return false
        run(action)
        return true
      },
    }),
    [run, stopped],
  )

  // Media keys and the system's controls (the lock screen, notifications).
  useEffect(() => {
    const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession
    if (!session || !video) return
    session.metadata = new MediaMetadata({ title: name })
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void videoRef.current?.play().catch(() => undefined)],
      ['pause', () => videoRef.current?.pause()],
      [
        'seekbackward',
        (details) => {
          seek((videoRef.current?.currentTime ?? 0) - (details.seekOffset ?? SKIP_TAP_SECONDS))
        },
      ],
      [
        'seekforward',
        (details) => {
          seek((videoRef.current?.currentTime ?? 0) + (details.seekOffset ?? SKIP_TAP_SECONDS))
        },
      ],
      [
        'seekto',
        (details) => {
          if (details.seekTime !== undefined) seek(details.seekTime)
        },
      ],
    ]
    for (const [action, handler] of handlers) setActionHandler(session, action, handler)
    return () => {
      session.metadata = null
      for (const [action] of handlers) setActionHandler(session, action, null)
    }
  }, [name, seek, video])

  /** A failed play: the file replaced meanwhile (the element can't tell a 412), or why not. */
  async function handleError() {
    const element = videoRef.current
    const error = element?.error ?? null
    const playing = source
    if (!playing) return
    const startAt = element?.currentTime ?? playing.startAt
    const fresh = await queryClient
      .query({ ...playbackQuery(base), staleTime: 0 })
      .catch(() => null)
    if (fresh && fresh.versionId !== playing.versionId) {
      setSource({ ...playing, startAt })
      setProblem({ kind: 'replaced', versionId: fresh.versionId })
      return
    }
    setSource({ ...playing, startAt })
    const detail = error?.message ?? ''
    if (error?.code === MediaError.MEDIA_ERR_NETWORK) setProblem({ kind: 'network' })
    else if (error?.code === MediaError.MEDIA_ERR_DECODE) setProblem({ kind: 'decode', detail })
    else setProblem({ kind: 'unsupported', detail })
  }

  function restart(versionId: string) {
    setProblem(null)
    setBlank(false)
    setSource(
      (current) => current && { versionId, startAt: current.startAt, attempt: current.attempt + 1 },
    )
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    gesture.current.start = { x: event.clientX, y: event.clientY, type: event.pointerType }
    gesture.current.lastType = event.pointerType
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const { start } = gesture.current
    gesture.current.start = null
    if (!start || event.button !== 0) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (start.type === 'mouse') {
      if (Math.abs(dx) + Math.abs(dy) < 6) togglePlay()
      wake()
      return
    }
    if (!fullscreen && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      onSwipe(dx < 0 ? 1 : -1)
      return
    }
    if (Math.abs(dx) + Math.abs(dy) > 12) return
    // A tap shows or hides the controls; two on either side skip.
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const side = x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0
    const { lastTap } = gesture.current
    window.clearTimeout(gesture.current.tapTimer)
    if (
      lastTap &&
      event.timeStamp - lastTap.at < DOUBLE_TAP_MS &&
      side !== 0 &&
      side === lastTap.side
    ) {
      seek((videoRef.current?.currentTime ?? 0) + side * SKIP_TAP_SECONDS)
      setRipple({ side, at: event.timeStamp })
      gesture.current.lastTap = { at: event.timeStamp, side }
      return
    }
    gesture.current.lastTap = { at: event.timeStamp, side }
    const wasVisible = visible
    gesture.current.tapTimer = window.setTimeout(() => {
      if (wasVisible && !state.paused) setAwake(false)
      else wake()
    }, DOUBLE_TAP_MS)
  }

  useEffect(() => {
    if (!ripple) return
    const timer = window.setTimeout(() => {
      setRipple(null)
    }, 600)
    return () => {
      window.clearTimeout(timer)
    }
  }, [ripple])

  if (playback.error) {
    return (
      <Trouble
        title="This video can’t be played"
        description={errorMessage(playback.error)}
        onDownload={onDownload}
      />
    )
  }

  return (
    <div
      ref={attachRoot}
      className={cn(
        '@container relative size-full overflow-hidden bg-black select-none',
        !visible && !shown && 'cursor-none',
      )}
      onPointerMove={(event) => {
        if (event.pointerType === 'mouse') wake()
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse' && !state.paused) setAwake(false)
      }}
    >
      {shown ? (
        <ProblemPanel
          problem={shown}
          onDownload={onDownload}
          onRetry={() => {
            if (source) restart(source.versionId)
          }}
          onPlayNew={(versionId) => {
            void queryClient.invalidateQueries({ queryKey: mediaQuery(base).queryKey })
            restart(versionId)
          }}
        />
      ) : (
        source && (
          <>
            <video
              key={`${source.versionId}:${String(source.attempt)}`}
              ref={attachVideo}
              src={contentUrl(base, source.versionId, source.startAt)}
              className="size-full object-contain"
              playsInline
              preload="auto"
              // The controls hide a while after it starts, as after a move.
              onPlaying={wake}
              onLoadedMetadata={(event) => {
                setBlank(event.currentTarget.videoWidth === 0)
              }}
              onVolumeChange={(event) => {
                setVolumePreference(event.currentTarget.volume, event.currentTarget.muted)
              }}
              onError={() => {
                void handleError()
              }}
            >
              {options.map((option) => (
                <track
                  key={option.key}
                  ref={(element) => {
                    if (!element) return
                    tracks.current.set(option.key, element)
                    return () => {
                      tracks.current.delete(option.key)
                    }
                  }}
                  kind="subtitles"
                  src={option.src}
                  label={option.label}
                  srcLang={option.language ?? undefined}
                />
              ))}
            </video>
            <SubtitleOverlay track={track?.key === chosen ? track.text : null} raised={visible} />
            <div
              className="absolute inset-0 touch-pan-y"
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              onDoubleClick={() => {
                if (gesture.current.lastType === 'mouse') toggleFullscreen()
              }}
            />
          </>
        )
      )}
      {!shown && (
        <Center
          loading={!source || starting || state.waiting}
          paused={state.paused && source !== null && !starting}
          ended={state.ended}
          onPlay={togglePlay}
        />
      )}
      {ripple && (
        <div
          key={ripple.at}
          className={cn(
            'pointer-events-none absolute top-1/2 -translate-y-1/2 animate-out rounded-full bg-black/50 px-4 py-2 text-sm font-medium text-white fade-out-0 duration-500 fill-mode-forwards',
            ripple.side < 0 ? 'left-[12%]' : 'right-[12%]',
          )}
        >
          {ripple.side < 0 ? '−' : '+'}
          {SKIP_TAP_SECONDS} s
        </div>
      )}
      {resumedAt !== null && !shown && (
        <div className="absolute bottom-24 left-3 sm:left-4">
          <div
            role="status"
            className="flex items-center gap-1 rounded-lg bg-black/75 py-1 pr-1 pl-3 text-sm text-white shadow-lg"
          >
            <span>Resumed at {formatPlayTime(resumedAt)}</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={() => {
                seek(0)
                resume.startOver()
                setResumedAt(null)
              }}
            >
              <RotateCcw /> Start over
            </Button>
          </div>
        </div>
      )}
      {shownNotices.length > 0 && (
        <div className="absolute inset-x-0 top-3 flex flex-col items-center gap-2 px-3">
          {shownNotices.map((notice) => (
            <div
              key={notice.key}
              role="status"
              className="flex max-w-md items-center gap-2 rounded-lg bg-black/75 py-1.5 pr-1.5 pl-3 text-sm text-white shadow-lg [&>svg]:size-4 [&>svg]:shrink-0"
            >
              {NOTICE_ICONS[notice.key]}
              <span>{notice.text}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss"
                className="shrink-0 text-white hover:bg-white/15 hover:text-white"
                onClick={() => {
                  setDismissed(new Set([...dismissed, notice.key]))
                }}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      {video && !shown && (
        <Controls
          video={video}
          container={root}
          visible={visible}
          durationHint={info?.durationMs ? info.durationMs / 1000 : null}
          fullscreen={fullscreen}
          canFullscreen={document.fullscreenEnabled || hasNativeFullscreen(video)}
          canPictureInPicture={document.pictureInPictureEnabled}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onVolume={setVolume}
          onRate={(rate) => {
            if (videoRef.current) videoRef.current.playbackRate = rate
          }}
          onAudioTrack={(id) => {
            if (videoRef.current) chooseAudioTrack(videoRef.current, id)
          }}
          onToggleFullscreen={toggleFullscreen}
          onTogglePictureInPicture={togglePictureInPicture}
          onMenu={(open) => {
            setMenuOpen(open)
            if (!open) wake()
          }}
          chapters={chapters}
          subtitles={{
            options,
            chosen,
            status: track?.key === chosen ? track.status : chosen === null ? null : 'loading',
            onChoose: chooseSubtitles,
          }}
        />
      )}
    </div>
  )
}

/** Why it doesn't play, in a few words, for the play's report. */
function problemText(problem: Problem): string {
  switch (problem.kind) {
    case 'codec':
      return `can’t decode ${problem.codec} video`
    case 'unsupported':
    case 'decode':
      return `${problem.kind}: ${problem.detail}`
    case 'network':
      return 'a read failed while playing'
    case 'replaced':
      return 'replaced while playing'
  }
}

/** In the middle: the spinner while it waits, a play button while it is paused. */
function Center({
  loading,
  paused,
  ended,
  onPlay,
}: {
  loading: boolean
  paused: boolean
  ended: boolean
  onPlay: () => void
}) {
  if (loading && !paused) {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-white">
        <Spinner className="size-10" />
      </div>
    )
  }
  if (!paused) return null
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <Button
        variant="secondary"
        aria-label={ended ? 'Play again' : 'Play'}
        className="pointer-events-auto size-16 rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm hover:bg-black/75 [&_svg:not([class*='size-'])]:size-7"
        onClick={onPlay}
      >
        {ended ? <RotateCcw /> : <Play className="translate-x-0.5 fill-current" />}
      </Button>
    </div>
  )
}

function ProblemPanel({
  problem,
  onDownload,
  onRetry,
  onPlayNew,
}: {
  problem: Problem
  onDownload: () => void
  onRetry: () => void
  onPlayNew: (versionId: string) => void
}) {
  switch (problem.kind) {
    case 'codec':
      return (
        <Trouble
          title="This video can’t play here"
          description={`This browser can’t play ${problem.codec} video. Download it to watch it in another app.`}
          onDownload={onDownload}
        />
      )
    case 'unsupported':
      return (
        <Trouble
          title="This video can’t play here"
          description="This browser can’t open this file. Download it to watch it in another app."
          detail={problem.detail}
          onDownload={onDownload}
        />
      )
    case 'decode':
      return (
        <Trouble
          title="This video couldn’t be decoded"
          description="It may be damaged, or in a form this browser can’t play."
          detail={problem.detail}
          onDownload={onDownload}
        />
      )
    case 'network':
      return (
        <Trouble
          title="The video stopped loading"
          description="Its file couldn’t be read just now. Try again in a moment."
          onDownload={onDownload}
        >
          <Button onClick={onRetry}>
            <RotateCcw /> Try again
          </Button>
        </Trouble>
      )
    case 'replaced':
      return (
        <Trouble
          title="This file was replaced"
          description="A new version was uploaded while it played."
          onDownload={onDownload}
        >
          <Button
            onClick={() => {
              onPlayNew(problem.versionId)
            }}
          >
            <Play /> Play the new version
          </Button>
        </Trouble>
      )
  }
}

function Trouble({
  title,
  description,
  detail,
  onDownload,
  children,
}: {
  title: string
  description: string
  /** The browser's own words, for those who want them. */
  detail?: string
  onDownload: () => void
  children?: ReactNode
}) {
  return (
    <Empty className="size-full text-white">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
        {detail && <p className="font-mono text-xs text-muted-foreground">{detail}</p>}
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        {children}
        <Button variant={children ? 'outline' : 'default'} onClick={onDownload}>
          <Download /> Download
        </Button>
      </EmptyContent>
    </Empty>
  )
}

/** An iPhone's full screen, for a video element alone. */
function hasNativeFullscreen(
  video: HTMLVideoElement,
): video is HTMLVideoElement & { webkitEnterFullscreen: () => void } {
  return typeof (video as { webkitEnterFullscreen?: unknown }).webkitEnterFullscreen === 'function'
}

/** On a phone in full screen, the video's way round, where the browser allows it (Android). */
function lockOrientation(video: HTMLVideoElement | null) {
  if (!video || !matchMedia('(pointer: coarse)').matches) return
  const way = video.videoWidth >= video.videoHeight ? 'landscape' : 'portrait'
  try {
    screen.orientation.lock(way).catch(() => {
      // Not allowed here.
    })
  } catch {
    // No such thing here (Safari).
  }
}

/** Some browsers throw for an action they don't know. */
function setActionHandler(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  try {
    session.setActionHandler(action, handler)
  } catch {
    // Not supported here.
  }
}

/** A file's path from its content's: `/files/:id/content` → `/files/:id`. */
function baseOf(contentPath: string): string {
  return contentPath.replace(/\/content$/, '')
}
