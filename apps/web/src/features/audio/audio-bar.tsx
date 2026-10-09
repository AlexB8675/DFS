import {
  ChevronDown,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { usePlayerPreferences } from '@/features/player/preferences'
import { Slider } from '@/features/player/slider'
import { formatPlayTime } from '@/features/player/time'
import { useMediaState } from '@/features/player/use-media-state'
import { errorMessage } from '@/lib/api/client'
import { downloadFromApi } from '@/lib/download'
import { cn } from '@/lib/utils'
import { Cover } from './cover'
import {
  audio,
  clearQueue,
  cycleRepeat,
  next,
  placeOf,
  previous,
  resumeFrom,
  retry,
  savedPosition,
  seekTo,
  setSpeed,
  SPEEDS,
  togglePlay,
  toggleShuffle,
  trackTitle,
} from './engine'
import { currentTrack, type QueuedTrack } from './queue'
import { QueueList } from './queue-list'
import { useAudioStore } from './store'

// The audio bar (DESIGN.md §10.4), under the page: on a computer, one bar
// with every control and the queue in a side panel; on a phone, a slim bar
// (cover, title, play, next) that opens a full view with the rest (the
// user's decision, 2026-10-09). It shows while the queue has a track.

export function AudioBar() {
  const track = useAudioStore((state) => currentTrack(state.queue))
  const bar = useRef<HTMLDivElement>(null)
  const showing = track !== null

  // Its height, for what floats at the bottom (toasts, the uploads) to stay above it.
  useLayoutEffect(() => {
    const element = bar.current
    if (!showing || !element) return
    const root = document.documentElement
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--audio-bar', `${String(element.offsetHeight)}px`)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--audio-bar')
    }
  }, [showing])

  if (!track) return null
  return (
    <div ref={bar} className="shrink-0 border-t bg-background">
      <WideBar track={track} />
      <SlimBar track={track} />
      <QueuePanel />
      <FullView track={track} />
    </div>
  )
}

/** The track's time and length, whether it plays: from the element once it holds the track. */
function usePlayState(track: QueuedTrack) {
  const loaded = useAudioStore((state) => state.loaded === track.key)
  const stopped = useAudioStore((state) => state.problem?.key === track.key)
  const state = useMediaState(loaded ? audio : null)
  const known = loaded && Number.isFinite(state.duration) && state.duration > 0
  return {
    // Before the first Play after a reload, where it was.
    time: loaded ? state.currentTime : savedPosition(track.key),
    duration: known ? state.duration : (track.durationMs ?? 0) / 1000,
    playing: loaded && !stopped && !state.paused && !state.ended,
    waiting: loaded && !stopped && state.waiting && !state.paused,
  }
}

function WideBar({ track }: { track: QueuedTrack }) {
  return (
    <div className="hidden h-16 items-center gap-4 px-3 md:flex">
      <div className="flex w-64 min-w-0 shrink-0 items-center gap-3 lg:w-80">
        <Cover track={track} className="size-11" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={track.name}>
            {trackTitle(track)}
          </p>
          <Subline track={track} actions className="text-xs" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-center">
        <Transport track={track} />
        <Seek track={track} className="w-full max-w-2xl" />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Speed />
        <Volume />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Queue"
          onClick={() => {
            useAudioStore.setState({ panel: 'queue' })
          }}
        >
          <ListMusic />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Stop and clear the queue"
          onClick={clearQueue}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}

function SlimBar({ track }: { track: QueuedTrack }) {
  const { time, duration } = usePlayState(track)
  return (
    <div className="relative md:hidden">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-foreground/10" aria-hidden>
        <div
          className="h-full bg-foreground"
          style={{ width: `${String(duration > 0 ? (time / duration) * 100 : 0)}%` }}
        />
      </div>
      <div className="flex h-14 items-center gap-1 px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-label="Open the player"
          onClick={() => {
            useAudioStore.setState({ panel: 'full' })
          }}
        >
          <Cover track={track} className="size-10" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{trackTitle(track)}</span>
            <Subline track={track} className="block text-xs" />
          </span>
        </button>
        <PlayButton track={track} />
        <Button variant="ghost" size="icon" aria-label="Next" onClick={next}>
          <SkipForward />
        </Button>
      </div>
    </div>
  )
}

/** On a phone, everything: the cover large, the controls, and the queue below. */
function FullView({ track }: { track: QueuedTrack }) {
  const open = useAudioStore((state) => state.panel === 'full')
  const count = useAudioStore((state) => state.queue.tracks.length)
  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen) => {
        useAudioStore.setState({ panel: isOpen ? 'full' : null })
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 p-0 data-[side=bottom]:h-dvh md:hidden"
      >
        <SheetTitle className="sr-only">Now playing</SheetTitle>
        <SheetDescription className="sr-only">
          The track playing, its controls and the queue
        </SheetDescription>
        <div className="flex h-12 shrink-0 items-center justify-between px-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close the player"
            onClick={() => {
              useAudioStore.setState({ panel: null })
            }}
          >
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="sm" onClick={clearQueue}>
            <X /> Stop
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
          <Cover track={track} className="mx-auto mt-2 aspect-square w-full max-w-72" />
          <div className="mt-6 min-w-0">
            <h2 className="truncate text-lg font-semibold" title={track.name}>
              {trackTitle(track)}
            </h2>
            <Subline track={track} actions className="text-sm" />
          </div>
          <Seek track={track} className="mt-4" />
          <Transport track={track} large className="mt-2 justify-center" />
          <div className="mt-2 flex justify-center">
            <Speed />
          </div>
          <h3 className="mt-6 mb-2 text-sm font-medium text-muted-foreground">
            Queue · {count === 1 ? '1 track' : `${String(count)} tracks`}
          </h3>
          <QueueList />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** On a computer, the queue beside the page. */
function QueuePanel() {
  const open = useAudioStore((state) => state.panel === 'queue')
  const count = useAudioStore((state) => state.queue.tracks.length)
  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen) => {
        useAudioStore.setState({ panel: isOpen ? 'queue' : null })
      }}
    >
      <SheetContent side="right" className="w-96 gap-0 p-0 sm:max-w-96">
        <div className="flex items-center gap-2 border-b px-4 py-3 pr-12">
          <SheetTitle className="flex-1">Queue</SheetTitle>
          <SheetDescription className="text-xs tabular-nums">
            {count === 1 ? '1 track' : `${String(count)} tracks`}
          </SheetDescription>
          <Button variant="ghost" size="sm" onClick={clearQueue}>
            Clear
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <QueueList />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Under the title: why it stopped, the offer to resume it, or its artist and album. */
function Subline({
  track,
  actions = false,
  className,
}: {
  track: QueuedTrack
  /** Its buttons too; the slim bar, a button itself, has none. */
  actions?: boolean
  className?: string
}) {
  const problem = useAudioStore((state) =>
    state.problem?.key === track.key ? state.problem : null,
  )
  const resume = useAudioStore((state) => (state.resume?.key === track.key ? state.resume : null))
  if (problem) {
    return (
      <span className={cn('flex min-w-0 items-center gap-2 text-destructive', className)}>
        <span className="truncate">{problem.message}</span>
        {actions && problem.offer === 'download' && (
          <TextButton
            onClick={() => {
              downloadFromApi(`${placeOf(track).path}/content`, track.name).catch(
                (reason: unknown) => {
                  toast.error('Couldn’t download', { description: errorMessage(reason) })
                },
              )
            }}
          >
            Download
          </TextButton>
        )}
        {actions && problem.offer === 'retry' && <TextButton onClick={retry}>Try again</TextButton>}
      </span>
    )
  }
  if (resume) {
    const text = `Stopped at ${formatPlayTime(resume.seconds)}`
    return actions ? (
      <span className={cn('flex min-w-0 items-center gap-2 text-muted-foreground', className)}>
        <span className="truncate">{text}</span>
        <TextButton
          onClick={() => {
            resumeFrom(resume.seconds)
          }}
        >
          Resume
        </TextButton>
      </span>
    ) : (
      <span className={cn('truncate text-muted-foreground', className)}>{text}</span>
    )
  }
  const said = [track.artist, track.album].filter(Boolean).join(' — ')
  return (
    <span className={cn('block truncate text-muted-foreground', className)}>
      {said || track.name}
    </span>
  )
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function PlayButton({ track, large = false }: { track: QueuedTrack; large?: boolean }) {
  const { playing, waiting } = usePlayState(track)
  return (
    <Button
      size={large ? 'icon-lg' : 'icon'}
      className={cn('rounded-full', large && 'size-14 [&_svg:not([class*=size-])]:size-6')}
      aria-label={playing ? 'Pause' : 'Play'}
      onClick={togglePlay}
    >
      {waiting ? (
        <Spinner />
      ) : playing ? (
        <Pause className="fill-current" />
      ) : (
        <Play className="translate-x-px fill-current" />
      )}
    </Button>
  )
}

/** Shuffle, previous, play, next and repeat. */
function Transport({
  track,
  large = false,
  className,
}: {
  track: QueuedTrack
  large?: boolean
  className?: string
}) {
  const shuffle = useAudioStore((state) => state.shuffle)
  const repeat = useAudioStore((state) => state.repeat)
  const size = large ? 'icon-lg' : 'icon-sm'
  return (
    <div className={cn('flex items-center gap-1', large && 'gap-4', className)}>
      <Button
        variant="ghost"
        size={size}
        aria-label="Shuffle"
        aria-pressed={shuffle}
        className={cn(shuffle && 'text-primary')}
        onClick={toggleShuffle}
      >
        <Shuffle />
      </Button>
      <Button variant="ghost" size={size} aria-label="Previous" onClick={previous}>
        <SkipBack className="fill-current" />
      </Button>
      <PlayButton track={track} large={large} />
      <Button variant="ghost" size={size} aria-label="Next" onClick={next}>
        <SkipForward className="fill-current" />
      </Button>
      <Button
        variant="ghost"
        size={size}
        aria-label={
          repeat === 'off'
            ? 'Repeat: off'
            : repeat === 'all'
              ? 'Repeat: the queue'
              : 'Repeat: this track'
        }
        className={cn(repeat !== 'off' && 'text-primary')}
        onClick={cycleRepeat}
      >
        {repeat === 'one' ? <Repeat1 /> : <Repeat />}
      </Button>
    </div>
  )
}

/** The seek bar, with the time and the length on either side. */
function Seek({ track, className }: { track: QueuedTrack; className?: string }) {
  const { time, duration } = usePlayState(track)
  /** Where a drag would go, shown while it lasts. */
  const [dragTo, setDragTo] = useState<number | null>(null)
  const shown = dragTo ?? time
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-xs text-muted-foreground tabular-nums',
        className,
      )}
    >
      <span className="w-12 text-right">{formatPlayTime(shown, duration)}</span>
      <Slider
        tone="theme"
        label="Seek"
        className="flex-1"
        value={duration > 0 ? Math.min(1, shown / duration) : 0}
        step={duration > 0 ? 5 / duration : 0.01}
        valueText={`${formatPlayTime(shown, duration)} of ${formatPlayTime(duration)}`}
        onChange={(value) => {
          setDragTo(value * duration)
        }}
        onCommit={(value) => {
          setDragTo(null)
          if (duration > 0) seekTo(value * duration)
        }}
      />
      <span className="w-12">{duration > 0 ? formatPlayTime(duration) : '–:––'}</span>
    </div>
  )
}

function Speed() {
  const speed = useAudioStore((state) => state.speed)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="tabular-nums"
          aria-label={`Speed: ${String(speed)}×`}
        >
          {speed}×
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuRadioGroup
          value={String(speed)}
          onValueChange={(value) => {
            setSpeed(Number(value))
          }}
        >
          {SPEEDS.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={String(choice)}>
              {choice}×{choice === 1 && ' (normal)'}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The players' volume, the video player's too. */
function Volume() {
  const volume = usePlayerPreferences((state) => state.volume)
  const muted = usePlayerPreferences((state) => state.muted)
  const setVolume = usePlayerPreferences((state) => state.setVolume)
  const quiet = muted || volume === 0
  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="icon"
        aria-label={quiet ? 'Unmute' : 'Mute'}
        onClick={() => {
          setVolume(volume === 0 ? 1 : volume, !muted && volume !== 0)
        }}
      >
        {quiet ? <VolumeX /> : <Volume2 />}
      </Button>
      <Slider
        tone="theme"
        label="Volume"
        className="w-24"
        value={quiet ? 0 : volume}
        step={0.05}
        valueText={`${String(Math.round((quiet ? 0 : volume) * 100))}%`}
        onChange={(value) => {
          setVolume(value, value === 0)
        }}
      />
    </div>
  )
}
