import type { TimelineEventInput } from '@dfs/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Cpu,
  Download,
  ExternalLink,
  Film,
  Info,
  Play,
  RotateCcw,
  Snail,
  VolumeX,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
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
import { pauseAudio } from '@/features/audio/engine'
import type { ViewHandle } from '@/features/preview/view-handle'
import { ApiError, errorMessage } from '@/lib/api/client'
import { isEditable } from '@/lib/editable'
import type { FilePlace } from '@/lib/file-place'
import { cn } from '@/lib/utils'
import { contentUrl, mediaQuery, playbackQuery } from './api'
import { bufferedPlayAvailable, mayPlayBuffered, pagePlay, type PagePlay } from './buffered/choice'
import { useBufferedPlay } from './buffered/use-buffered-play'
import { PlayIntent } from './play-intent'
import { reportLab } from './report-lab'
import { browserCanPlayType, codecLabel, playability, playedStreams, unplayableOf } from './codecs'
import { audioTracksOf, chooseAudioTrack } from './audio-tracks'
import { Controls, type Chapter } from './controls'
import {
  decodingQuery,
  playbackNotices,
  usePlaybackStats,
  type PlaybackNotice,
} from './diagnostics'
import { currentDevice } from './external-players'
import { playerAction, stepSpeed, type PlayerAction } from './keys'
import { OpenInMenu } from './open-in-menu'
import {
  elsewhereText,
  failureProblem,
  problemKind,
  problemText,
  refusalText,
  type Problem,
} from './problems'
import { usePlayerPreferences } from './preferences'
import {
  defaultSubtitle,
  subtitleOptions,
  toggledSubtitle,
  type SubtitleOption,
} from './subtitle-options'
import { SubtitleOverlay } from './subtitle-overlay'
import { formatPlayTime } from './time'
import { clipText, type Timeline } from './timeline/recorder'
import { watchElement } from './timeline/watch-element'
import { useMediaState } from './use-media-state'
import { RESUME_FROM_MS, RESUME_NOTE_MS, RESUME_OFFER_MS } from './resume-rules'
import { useResume } from './use-resume'

// The video player (DESIGN.md §10.4, D45): the version the API names, from
// the start, offering to resume where the viewer stopped, with controls of
// its own over the picture. The media info, when it comes, says whether this
// browser decodes the picture and the sound, and brings the chapters and the
// subtitles inside the file. It also says how the video plays (`pagePlay`):
// in the page only through the app's own buffer (./buffered), which the
// element is given as a Media Source, so an MP4 or MOV waits for the info;
// on an iPhone or iPad by Safari's own player, the element given the file's
// address, at once; and otherwise not in the page at all: another player is
// offered, with Download, and no element is made. A buffer that fails before
// its first frame ends the same way. The same for a drive's file and a link's:
// its place says where to ask. The play's timeline (§16) comes from the viewer,
// who makes it before this loads: it records the answers, the decision, the
// source and the element, and names the play in the reads.

interface VideoViewProps {
  name: string
  /** Where the file is: the drive's, or a link's. */
  place: FilePlace
  /** `false` while the viewer closes: it stops at once. */
  active: boolean
  /** The play's timeline (§16), from when the viewer began showing the file; null until it exists. */
  timeline: Timeline | null
  ref?: Ref<ViewHandle>
  onDownload: () => void
  /** A swipe on a touch screen: 1 for the next file, -1 for the previous. */
  onSwipe: (direction: 1 | -1) => void
}

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
/** A warning that fades goes this long after the video starts playing. */
const NOTICE_FADE_MS = 10_000
/** Each warning's icon. */
const NOTICE_ICONS: Record<PlaybackNotice['key'], ReactNode> = {
  sound: <VolumeX />,
  limits: <Info />,
  decoding: <Cpu />,
  software: <Cpu />,
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
  place,
  active,
  timeline,
  ref,
  onDownload,
  onSwipe,
}: VideoViewProps) {
  const base = place.path
  const queryClient = useQueryClient()
  const playback = useQuery(playbackQuery(place))
  const media = useQuery(mediaQuery(place))
  const setVolumePreference = usePlayerPreferences((state) => state.setVolume)
  const subtitlePreference = usePlayerPreferences((state) => state.subtitles)
  const setSubtitlePreference = usePlayerPreferences((state) => state.setSubtitles)

  // The version /playback named, from the start, played until the viewer moves on.
  const [source, setSource] = useState<Source | null>(null)
  /** Where the viewer stopped, in seconds, offered until they resume or play on past it. */
  const [resumeAt, setResumeAt] = useState<number | null>(null)
  /** The offer on screen, fading, or gone while what it offers is still kept. */
  const [offer, setOffer] = useState<'shown' | 'fading' | 'gone'>('shown')
  if (source === null && playback.data) {
    const { versionId, positionMs } = playback.data
    setSource({ versionId, startAt: 0, attempt: 0 })
    if (positionMs !== null && positionMs >= RESUME_FROM_MS) setResumeAt(positionMs / 1000)
  }
  const [problem, setProblem] = useState<Problem | null>(null)
  /** The element showed no picture: Chrome plays the sound of a video it can't decode. */
  const [blank, setBlank] = useState(false)
  /** Warnings dismissed in this video, and those fading out. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [fading, setFading] = useState<ReadonlySet<string>>(new Set())
  /** Asked to play, and not playing yet nor refused: a spinner, not a play button. */
  const [starting, setStarting] = useState(true)
  /** How the start with this key plays, once decided (§10.4): in the page, natively, or elsewhere. */
  const [mode, setMode] = useState<{ key: string; play: PagePlay } | null>(null)

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
      // It plays once it has a source: see `native`, and `onCanPlay` for the own buffer.
      setStarting(true)
    }
  }, [])

  const state = useMediaState(video)
  // Played on past the offer's time, or to the end: what plays is where the viewer is.
  if (resumeAt !== null && (state.ended || state.currentTime * 1000 >= RESUME_OFFER_MS)) {
    setResumeAt(null)
  }
  const [awake, setAwake] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const hideTimer = useRef(0)
  const [fullscreen, setFullscreen] = useState(false)
  const gesture = useRef<Gesture>({ start: null, lastType: '', lastTap: null, tapTimer: 0 })
  const [ripple, setRipple] = useState<{ side: -1 | 1; at: number } | null>(null)

  // What the media info says of this browser, once it comes, for the version playing.
  const info = source && media.data?.versionId === source.versionId ? media.data.info : null

  // How a start plays (`pagePlay`, §10.4, D45) is decided once, and kept while its element
  // lives: a refetch of the info must not change a video that plays. An iPhone or iPad, and a
  // name that can't be an MP4 or MOV, decide at once; one that can waits for the media info to
  // come or fail (then it is `null`), with no element until then. A new start (a retry, a new
  // file) decides again.
  const device = currentDevice()
  const sourceKey = source ? `${source.versionId}:${String(source.attempt)}` : ''
  const mayBuffer = mayPlayBuffered(name)
  if (
    source &&
    mode?.key !== sourceKey &&
    (device === 'ios' || !mayBuffer || info !== null || !media.isFetching)
  ) {
    setMode({
      key: sourceKey,
      play: pagePlay({
        name,
        info,
        device,
        canBuffer: bufferedPlayAvailable(),
        supports: (mime) => MediaSource.isTypeSupported(mime),
      }),
    })
  }
  const decided = mode?.key === sourceKey ? mode : null
  const how = decided?.play ?? null
  /** The page plays it through the own buffer. */
  const buffered = how?.play === 'buffered'
  /** An iPhone or iPad plays it, in Safari's own player, by the file's address. */
  const native = how?.play === 'native'
  // What the viewer means the play to do (§10.4): the engine pauses the element while it holds,
  // so the element's `paused` can't say it. A new start wants a play again. `wanted` mirrors the
  // intent for what renders.
  const intent = useRef(new PlayIntent())
  const [wanted, setWanted] = useState(true)
  const [wantedKey, setWantedKey] = useState(sourceKey)
  if (wantedKey !== sourceKey) {
    setWantedKey(sourceKey)
    setWanted(true)
  }
  // A slide left is a play not wanted: the mirror follows the intent (set below, in an effect).
  if (!active && wanted) setWanted(false)
  useEffect(() => {
    intent.current.restart()
  }, [sourceKey])
  // The engine plays by this, each time it would start or resume: read when it asks, so `active`
  // is the latest (a ref, as an Effect Event can't be passed to the hook).
  const activeNow = useRef(active)
  useEffect(() => {
    activeNow.current = active
  })
  const wantsPlay = useCallback(() => activeNow.current && intent.current.wanted, [])
  const { stats: bufferedStats } = useBufferedPlay({
    video,
    url: source ? contentUrl(place, source.versionId, 0, timeline?.playId) : '',
    playId: timeline?.playId ?? null,
    // Not once a problem is shown: a play that failed is over, and `startAt` moves with it.
    enabled: buffered && problem === null,
    startAt: source?.startAt ?? 0,
    autoplay: wantsPlay,
    // Before its first frame: another player is offered, not another way in the page. A read the
    // server refused for good is for `handleError` to settle (the file replaced, gone), which the
    // failed phase of the stats runs.
    onFailed: (failure) => {
      if (failure.read) return
      setProblem({ kind: 'unsupported', detail: failure.message, reason: failure.reason })
    },
    // What the engine does goes to the play's timeline (§16).
    onEvent: (event) => {
      timeline?.record(event)
    },
  })

  // Asked to play, without a click first (an address opened or reloaded) the browser may refuse.
  useEffect(() => {
    if (!video || !native) return
    let current = true
    video
      .play()
      .catch(() => undefined)
      .finally(() => {
        if (current) setStarting(false)
      })
    return () => {
      current = false
    }
  }, [video, native])

  // After its first frame, a failed own-buffer play leaves the element as it is, with no error of
  // its own: a read that broke off, the file replaced. It is a failed play all the same.
  const playFailed = bufferedStats?.phase === 'failed'
  const surfaceFailure = useEffectEvent(() => {
    void handleError()
  })
  useEffect(() => {
    if (playFailed) surfaceFailure()
  }, [playFailed])

  const verdict = info ? playability(info, browserCanPlayType) : null
  const picture = verdict?.video
  // The element's own check of the picture, for Safari's player alone: on the buffered path
  // `pagePlay` and the engine check the codecs, and elsewhere there is no element.
  const pictureFails =
    native && picture && (picture.decodes === false || (blank && picture.decodes !== true))
      ? codecLabel(picture.stream.codec)
      : null
  // What it plays without: its sound, picture subtitles, other sound tracks, which VLC plays.
  // Only Safari's own player (`native`) switches sound tracks itself; through the buffer the
  // element holds the first one alone, so the list desktop Safari gives it can't reach the
  // others and VLC is offered for them. And a sound the browser can't play stops a buffered
  // play before it starts (`pagePlay`, the engine), so it never plays without it.
  const unplayableHere =
    info && verdict && video
      ? unplayableOf(info, verdict, native && audioTracksOf(video) !== null)
      : null
  const unplayable =
    unplayableHere && buffered ? { ...unplayableHere, sound: null } : unplayableHere
  // The page doesn't play it: derived from the decision, like `pictureFails`, and not stored.
  const elsewhereProblem: Problem | null =
    how?.play === 'elsewhere' ? { kind: 'elsewhere', reason: how.reason, codec: how.codec } : null
  const shown: Problem | null =
    problem ?? elsewhereProblem ?? (pictureFails ? { kind: 'codec', codec: pictureFails } : null)
  const stopped = shown !== null
  // A wanted play that the engine holds shows as playing, though the element is paused.
  const heldPlay = bufferedStats?.holding === true && wanted
  const shownPaused = state.paused && !heldPlay
  const visible = awake || state.paused || menuOpen

  // How it played, for the play's report (§10.4): read when the report goes, so kept in a ref.
  const played = useRef({ player: how?.play ?? null, stats: bufferedStats })
  useEffect(() => {
    played.current = { player: how?.play ?? null, stats: bufferedStats }
  })
  const howItPlayed = useCallback(() => {
    const { player, stats } = played.current
    if (player === 'native') return '{"player":"native"}'
    // Elsewhere nothing plays, and no element follows it: nothing to say.
    if (player !== 'buffered') return undefined
    return reportLab(stats)
  }, [])

  // The play's timeline (§16). What happened before it existed is recorded when it does: each of
  // these once for each timeline (a refetch of a query records nothing again, a new timeline
  // records it all), kept by the timeline object.
  const recorded = useRef<{ timeline: Timeline; keys: Set<string> } | null>(null)
  const recordOnce = useEffectEvent((key: string, event: TimelineEventInput) => {
    if (!timeline) return
    if (recorded.current?.timeline !== timeline) {
      recorded.current = { timeline, keys: new Set() }
    }
    if (recorded.current.keys.has(key)) return
    recorded.current.keys.add(key)
    timeline.record(event)
  })
  // The first answers, whether they came or failed.
  useEffect(() => {
    if (playback.status !== 'pending') {
      recordOnce('answered:playback', answeredEvent('playback', playback.error))
    }
    if (media.status !== 'pending') {
      recordOnce('answered:media', answeredEvent('media', media.error))
    }
  }, [timeline, playback.status, playback.error, media.status, media.error])
  // Its batches name the version once the page knows it.
  const playedVersion = source?.versionId
  useEffect(() => {
    if (timeline && playedVersion) timeline.setVersion(playedVersion)
  }, [timeline, playedVersion])
  // Where it plays, once for each start.
  useEffect(() => {
    if (!how) return
    recordOnce(`decided:${sourceKey}`, {
      type: 'decided',
      play: how.play,
      reason: how.play === 'elsewhere' ? how.reason : null,
      codec: how.play === 'elsewhere' && how.codec !== null ? clipText(how.codec, 40) : null,
    })
  }, [timeline, how, sourceKey])
  // Its source, once for each start: the element given the file's address, or the engine started.
  const player =
    video !== null && problem === null && (how?.play === 'native' || how?.play === 'buffered')
      ? how.play
      : null
  useEffect(() => {
    if (player === null || !source) return
    recordOnce(`source:${sourceKey}`, {
      type: 'source',
      versionId: source.versionId,
      startAt: source.startAt,
      attempt: source.attempt,
      player,
    })
  }, [timeline, player, source, sourceKey])
  // The element's own events, samples and pictures, on the same clock.
  useEffect(
    () =>
      video && timeline
        ? watchElement(video, (event) => {
            timeline.record(event)
          })
        : undefined,
    [video, timeline],
  )

  // Why it may be slow, as far as the player can tell, and the play's report when it ends.
  const decoding = useQuery(decodingQuery(base, source?.versionId ?? null, info)).data ?? null
  const signals = usePlaybackStats(
    video,
    base,
    source?.versionId ?? null,
    {
      bitRate: info?.bitRate ?? null,
      decoding,
      problem: shown && { text: problemText(shown), kind: problemKind(shown) },
      playId: timeline?.playId ?? null,
    },
    active,
    howItPlayed,
  )
  const notices = playbackNotices({
    unplayable,
    playerName: 'VLC',
    decoding,
    picture: info ? playedStreams(info).video : null,
    bitRate: info?.bitRate ?? null,
    signals,
    engine:
      buffered && bufferedStats ? { slow: bufferedStats.slow, rate: bufferedStats.rate } : null,
  })
  const shownNotices = stopped ? [] : notices.filter((notice) => !dismissed.has(notice.key))
  // Those that fade go a while after it plays: a video held for Play keeps them until then.
  const toFade = shownNotices
    .filter((notice) => notice.fades && !fading.has(notice.key))
    .map((notice) => notice.key)
    .join(' ')
  useEffect(() => {
    if (!toFade || state.paused) return
    const timer = window.setTimeout(() => {
      setFading((before) => new Set([...before, ...toFade.split(' ')]))
    }, NOTICE_FADE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [toFade, state.paused])

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
    () => (source ? subtitleOptions(place.path, source.versionId, subtitleFiles ?? [], info) : []),
    // The prop's, not `base`: the compiler takes a string it made for one it might change.
    [info, place.path, subtitleFiles, source],
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

  // The offer fades a while after it starts playing: a video held for Play keeps it until then.
  useEffect(() => {
    if (resumeAt === null || offer !== 'shown' || state.paused) return
    const timer = window.setTimeout(() => {
      setOffer('fading')
    }, RESUME_NOTE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [offer, resumeAt, state.paused])

  useResume({
    place,
    video,
    versionId: source?.versionId ?? null,
    savedMs: playback.data?.positionMs ?? null,
    offering: resumeAt !== null,
  })

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

  // A video opened pauses the audio bar (§10.4).
  useEffect(() => {
    pauseAudio()
  }, [])

  const seek = useCallback((seconds: number) => {
    const element = videoRef.current
    if (!element) return
    const end = Number.isFinite(element.duration) ? element.duration : seconds
    element.currentTime = Math.min(Math.max(0, seconds), end)
  }, [])

  const holdingNow = useCallback(() => played.current.stats?.holding === true, [])

  /** The viewer plays: not into a hold, which plays when it ends, as the play is wanted. */
  const playByViewer = useCallback(() => {
    const element = videoRef.current
    const act = intent.current.play(holdingNow())
    setWanted(intent.current.wanted)
    if (element && act === 'play') void element.play().catch(() => undefined)
  }, [holdingNow])

  /** The viewer pauses: a hold that ends does not play. */
  const pauseByViewer = useCallback(() => {
    intent.current.pause()
    setWanted(false)
    videoRef.current?.pause()
  }, [])

  // Leaving the slide is a pause (§10.4).
  useEffect(() => {
    if (active) return
    intent.current.pause()
    videoRef.current?.pause()
  }, [active])

  // During a hold the engine has the element paused, so the toggle reads the intent (§10.4).
  const togglePlay = useCallback(() => {
    const element = videoRef.current
    if (!element) return
    const act = intent.current.toggle(holdingNow(), element.paused || element.ended)
    setWanted(intent.current.wanted)
    if (act === 'play') void element.play().catch(() => undefined)
    else if (act === 'pause') element.pause()
  }, [holdingNow])

  // A play from outside the page's controls (Picture-in-Picture's button, a browser's own) is a
  // play the viewer wants. A pause event is not synced: the engine pauses it for holds and reopens.
  useEffect(() => {
    if (!video) return
    const onPlay = () => {
      intent.current.played()
      setWanted(true)
    }
    video.addEventListener('play', onPlay)
    return () => {
      video.removeEventListener('play', onPlay)
    }
  }, [video])

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
      pause: pauseByViewer,
    }),
    [run, stopped, pauseByViewer],
  )

  // Media keys and the system's controls (the lock screen, notifications).
  useEffect(() => {
    const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession
    if (!session || !video) return
    session.metadata = new MediaMetadata({ title: name })
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', playByViewer],
      ['pause', pauseByViewer],
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
  }, [name, seek, video, playByViewer, pauseByViewer])

  /**
   * A failed play: the file replaced meanwhile (the element can't tell a
   * 412), gone (trashed, or its link ended), or why not.
   */
  async function handleError() {
    const element = videoRef.current
    const error = element?.error ?? null
    const playing = source
    if (!playing) return
    const startAt = element?.currentTime ?? playing.startAt
    const stats = played.current.stats
    const fresh = await queryClient
      .query({ ...playbackQuery(place), staleTime: 0 })
      .catch((reason: unknown) => (reason instanceof ApiError ? reason : null))
    // The element is gone by now: an own-buffer play that failed before its first frame has its
    // panel already.
    if (videoRef.current !== element) return
    // Gone, or its link ended: /playback's answer says so, in place of the player.
    if (fresh instanceof ApiError && fresh.status < 500) return
    if (fresh && !(fresh instanceof ApiError) && fresh.versionId !== playing.versionId) {
      setSource({ ...playing, startAt })
      setProblem({ kind: 'replaced', versionId: fresh.versionId })
      return
    }
    setSource({ ...playing, startAt })
    // The element's own error when it has one, else the engine's: a read the server refused for
    // good is the network panel, and any other failure is the stopped one (§4.8).
    setProblem(
      failureProblem({
        elementError: error && { code: error.code, message: error.message },
        engine: stats && { failedOn: stats.failedOn, error: stats.error },
      }),
    )
  }

  /** Open in…, over the player: the players that play it on this device (§6.7). */
  function openIn(button: ReactNode) {
    return (
      <OpenInMenu place={place} name={name} kind="video" container={root} onChosen={pauseByViewer}>
        {button}
      </OpenInMenu>
    )
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
        onDownload={isGone(playback.error) ? undefined : onDownload}
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
          openIn={openIn(
            <Button>
              <ExternalLink /> Open in…
            </Button>,
          )}
          onRetry={() => {
            if (source) restart(source.versionId)
          }}
          onPlayNew={(versionId) => {
            void queryClient.invalidateQueries({ queryKey: mediaQuery(place).queryKey })
            restart(versionId)
          }}
        />
      ) : (
        // No element until the start is decided: one made for a video that then plays elsewhere
        // would be followed, and reported, for nothing. Nor before the timeline exists, so that
        // every read of the play is named by it (§16). The timeline is always made (`newPlayId`
        // can't fail), so this waits a render at most.
        source &&
        decided !== null &&
        timeline !== null && (
          <>
            <video
              key={sourceKey}
              ref={attachVideo}
              // The own buffer sets a source of its own; Safari's player is given the file's address.
              src={
                native
                  ? contentUrl(place, source.versionId, source.startAt, timeline.playId)
                  : undefined
              }
              className="size-full object-contain"
              playsInline
              preload="auto"
              // The controls hide a while after it starts, as after a move.
              onPlaying={wake}
              // The own buffer plays from its metadata, where a refusal isn't seen: it ends here.
              onCanPlay={() => {
                setStarting(false)
              }}
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
          loading={decided === null || starting || state.waiting || bufferedStats?.holding === true}
          paused={shownPaused && decided !== null && !starting}
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
      {resumeAt !== null && offer !== 'gone' && !shown && decided !== null && (
        <div
          className={cn(
            'absolute bottom-24 left-3 sm:left-4',
            offer === 'fading' &&
              'pointer-events-none animate-out duration-500 fade-out-0 fill-mode-forwards',
          )}
          onAnimationEnd={() => {
            if (offer === 'fading') setOffer('gone')
          }}
        >
          <div
            role="status"
            className="flex items-center gap-1 rounded-lg bg-black/75 py-1 pr-1 pl-3 text-sm text-white shadow-lg"
          >
            <span>Stopped at {formatPlayTime(resumeAt)}</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={() => {
                seek(resumeAt)
                setResumeAt(null)
                playByViewer()
                wake()
              }}
            >
              <Play className="fill-current" /> Resume
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
              className={cn(
                'flex max-w-md items-center gap-2 rounded-lg bg-black/75 py-1.5 pr-1.5 pl-3 text-sm text-white shadow-lg [&>svg]:size-4 [&>svg]:shrink-0',
                fading.has(notice.key) &&
                  'pointer-events-none animate-out duration-500 fade-out-0 fill-mode-forwards',
              )}
              onAnimationEnd={() => {
                if (fading.has(notice.key)) setDismissed(new Set([...dismissed, notice.key]))
              }}
            >
              {NOTICE_ICONS[notice.key]}
              <span>{notice.text}</span>
              {notice.external &&
                openIn(
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-white hover:bg-white/15 hover:text-white"
                  >
                    <ExternalLink /> Open in…
                  </Button>,
                )}
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
          heldPlay={heldPlay}
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

/** The timeline's note that a first query settled: whether it came, and the status of its refusal. */
function answeredEvent(what: 'playback' | 'media', error: Error | null): TimelineEventInput {
  return {
    type: 'answered',
    what,
    ok: error === null,
    status: error instanceof ApiError ? error.status : null,
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
  openIn,
  onRetry,
  onPlayNew,
}: {
  problem: Problem
  onDownload: () => void
  /** Open in… another player (this device's, VLC), which may play what this browser can't. */
  openIn: ReactNode
  onRetry: () => void
  onPlayNew: (versionId: string) => void
}) {
  const external = openIn
  switch (problem.kind) {
    case 'codec':
      return (
        <Trouble
          title="This video can’t play here"
          description={`This browser can’t play ${problem.codec} video. Open it in another player, VLC say, or download it.`}
          onDownload={onDownload}
        >
          {external}
        </Trouble>
      )
    case 'elsewhere': {
      const { title, description } = elsewhereText(problem)
      return (
        <Trouble title={title} description={description} onDownload={onDownload}>
          {external}
        </Trouble>
      )
    }
    case 'unsupported': {
      const { title, description } = refusalText(problem.reason)
      return (
        <Trouble
          title={title}
          description={description}
          detail={problem.detail}
          onDownload={onDownload}
        >
          {external}
        </Trouble>
      )
    }
    case 'stopped':
      return (
        <Trouble
          title="This video stopped playing"
          description="It can’t go on in this browser. Try again, open it in another player, or download it."
          detail={problem.detail}
          onDownload={onDownload}
        >
          <Button onClick={onRetry}>
            <RotateCcw /> Try again
          </Button>
          {external}
        </Trouble>
      )
    case 'decode':
      return (
        <Trouble
          title="This video couldn’t be decoded"
          description="It may be damaged, or in a form this browser can’t play. Try it in another player, or download it."
          detail={problem.detail}
          onDownload={onDownload}
        >
          {external}
        </Trouble>
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
          description="Another file was uploaded in its place while it played."
          onDownload={onDownload}
        >
          <Button
            onClick={() => {
              onPlayNew(problem.versionId)
            }}
          >
            <Play /> Play the new file
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
  /** Absent when there is nothing to download any more. */
  onDownload?: () => void
  children?: ReactNode
}) {
  return (
    <Empty className="size-full text-white">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
        {detail && <p className="font-mono text-xs text-muted-foreground">{detail}</p>}
      </EmptyHeader>
      {(children ?? onDownload) && (
        <EmptyContent className="flex-row flex-wrap justify-center">
          {children}
          {onDownload && (
            <Button variant={children ? 'outline' : 'default'} onClick={onDownload}>
              <Download /> Download
            </Button>
          )}
        </EmptyContent>
      )}
    </Empty>
  )
}

/** The file can't be had any more: trashed or deleted, or its link ended or locked meanwhile. */
function isGone(error: Error): boolean {
  return error instanceof ApiError && [403, 404, 410].includes(error.status)
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
