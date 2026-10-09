import {
  Captions,
  ListVideo,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { audioTracksOf, type AudioTrack } from './audio-tracks'
import { SPEEDS } from './keys'
import { Slider } from './slider'
import type { SubtitleOption } from './subtitle-options'
import { formatPlayTime } from './time'
import { useMediaState } from './use-media-state'

// The video player's controls (DESIGN.md §10.4): the seek bar over a row of
// buttons, at the bottom of the picture.

export interface Chapter {
  /** In seconds. */
  start: number
  title: string
}

/** The subtitles offered, the one shown, and how loading it went. */
export interface SubtitleChoice {
  options: readonly SubtitleOption[]
  chosen: string | null
  /** The chosen track's loading, from its `<track>`. */
  status: 'loading' | 'ready' | 'failed' | null
  onChoose: (key: string | null) => void
}

interface ControlsProps {
  video: HTMLVideoElement
  /** Where the menus open: inside the player, so they show in full screen. */
  container: HTMLElement | null
  visible: boolean
  /** The video's length before the element knows it, from its media info. */
  durationHint: number | null
  fullscreen: boolean
  canFullscreen: boolean
  canPictureInPicture: boolean
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  onVolume: (volume: number, muted: boolean) => void
  onRate: (rate: number) => void
  /** Plays the browser's audio track with this ID. */
  onAudioTrack: (id: string) => void
  onToggleFullscreen: () => void
  onTogglePictureInPicture: () => void
  /** A menu opened or closed: the controls stay while one is open. */
  onMenu: (open: boolean) => void
  chapters: readonly Chapter[]
  subtitles: SubtitleChoice
}

/** Buttons keep the focus where it was, so the player's keys go on working after a click. */
function keepFocus(event: MouseEvent) {
  event.preventDefault()
}

export function Controls({
  video,
  container,
  visible,
  durationHint,
  fullscreen,
  canFullscreen,
  canPictureInPicture,
  onTogglePlay,
  onSeek,
  onVolume,
  onRate,
  onAudioTrack,
  onToggleFullscreen,
  onTogglePictureInPicture,
  onMenu,
  chapters,
  subtitles,
}: ControlsProps) {
  const state = useMediaState(video, visible)
  /** Where the seek bar is dragged to, ahead of the video. */
  const [dragTo, setDragTo] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const duration = Number.isFinite(state.duration) ? state.duration : (durationHint ?? 0)
  const time = dragTo ?? state.currentTime
  const fraction = duration > 0 ? Math.min(1, time / duration) : 0
  const tracks = audioTracksOf(video)
  const quiet = state.muted || state.volume === 0
  const VolumeIcon = quiet ? VolumeX : state.volume < 0.5 ? Volume1 : Volume2
  const chapterAt = (seconds: number) => chapters.findLast((chapter) => chapter.start <= seconds)
  const current = chapterAt(time)
  const menu = (props: {
    label: string
    icon: ReactNode
    pressed?: boolean
    children: ReactNode
  }) => (
    <DropdownMenu modal={false} onOpenChange={onMenu}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={props.label.replace(/ \(.\)$/, '')}
          title={props.label}
          aria-pressed={props.pressed}
          className={cn(
            'text-white hover:bg-white/15 hover:text-white',
            props.pressed && 'bg-white/15',
          )}
          onMouseDown={keepFocus}
        >
          {props.icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={container}
        side="top"
        align="end"
        className="max-h-80 w-56"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div
      className={cn(
        'absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/40 to-transparent px-3 pt-10 pb-2 text-white transition-opacity duration-200 sm:px-4',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      // A click here isn't a click on the picture.
      onClick={(event) => {
        event.stopPropagation()
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
      }}
    >
      <div className="relative">
        {hover !== null && duration > 0 && (
          <div
            className="pointer-events-none absolute bottom-6 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-xs tabular-nums"
            style={{ left: `clamp(1.5rem, ${String(hover * 100)}%, calc(100% - 1.5rem))` }}
          >
            {chapterAt(hover * duration)?.title && (
              <span className="mr-1.5 font-medium">{chapterAt(hover * duration)?.title}</span>
            )}
            {formatPlayTime(hover * duration, duration)}
          </div>
        )}
        <Slider
          label="Seek"
          value={fraction}
          step={duration > 0 ? 5 / duration : 0.01}
          valueText={`${formatPlayTime(time, duration)} of ${formatPlayTime(duration)}`}
          onChange={(value) => {
            setDragTo(value * duration)
          }}
          onCommit={(value) => {
            setDragTo(null)
            onSeek(value * duration)
          }}
          onHover={setHover}
          marks={
            duration > 0
              ? chapters
                  .filter((chapter) => chapter.start > 0 && chapter.start < duration)
                  .map((chapter) => chapter.start / duration)
              : []
          }
          under={
            duration > 0 &&
            state.buffered.map(([start, end]) => (
              <div
                key={start}
                className="absolute inset-y-0 bg-white/35"
                style={{
                  left: `${String((start / duration) * 100)}%`,
                  width: `${String(((end - start) / duration) * 100)}%`,
                }}
              />
            ))
          }
        />
      </div>
      <div className="flex items-center gap-0.5 sm:gap-1">
        <ControlButton label={state.paused ? 'Play (k)' : 'Pause (k)'} onClick={onTogglePlay}>
          {state.paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
        </ControlButton>
        <ControlButton
          label={quiet ? 'Unmute (m)' : 'Mute (m)'}
          onClick={() => {
            if (quiet) onVolume(state.volume === 0 ? 0.5 : state.volume, false)
            else onVolume(state.volume, true)
          }}
        >
          <VolumeIcon />
        </ControlButton>
        {/* A page can't set a phone's volume (iOS): its buttons do. */}
        <Slider
          label="Volume"
          value={quiet ? 0 : state.volume}
          step={0.05}
          valueText={`${String(Math.round((quiet ? 0 : state.volume) * 100))}%`}
          onChange={(value) => {
            onVolume(value, value === 0)
          }}
          className="w-16 pointer-coarse:hidden sm:w-20"
        />
        <span className="ml-2 text-xs whitespace-nowrap tabular-nums sm:text-sm">
          {formatPlayTime(time, duration)} / {formatPlayTime(duration)}
        </span>
        {current?.title && (
          <span className="ml-2 min-w-0 truncate text-sm text-white/80 max-sm:hidden">
            · {current.title}
          </span>
        )}
        <div className="min-w-0 flex-1" />
        {chapters.length > 0 &&
          menu({
            label: 'Chapters',
            icon: <ListVideo />,
            children: (
              <>
                <DropdownMenuLabel>Chapters</DropdownMenuLabel>
                {chapters.map((chapter) => (
                  <DropdownMenuItem
                    key={chapter.start}
                    className={cn(chapter === current && 'font-medium')}
                    onSelect={() => {
                      onSeek(chapter.start)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatPlayTime(chapter.start, duration)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            ),
          })}
        {subtitles.options.length > 0 &&
          menu({
            label: 'Subtitles (c)',
            icon: <Captions />,
            pressed: subtitles.chosen !== null,
            children: (
              <>
                <DropdownMenuLabel>Subtitles</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={subtitles.chosen ?? ''}
                  onValueChange={(key) => {
                    subtitles.onChoose(key || null)
                  }}
                >
                  <DropdownMenuRadioItem value="">Off</DropdownMenuRadioItem>
                  {subtitles.options.map((option) => (
                    <DropdownMenuRadioItem key={option.key} value={option.key}>
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.key === subtitles.chosen && subtitles.status === 'loading' && (
                        <span className="text-xs text-muted-foreground">Loading…</span>
                      )}
                      {option.key === subtitles.chosen && subtitles.status === 'failed' && (
                        <span className="text-xs text-destructive">Can’t be read</span>
                      )}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            ),
          })}
        {menu({
          label: 'Settings',
          icon: <Settings />,
          children: (
            <>
              <DropdownMenuLabel>Speed</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={String(state.rate)}
                onValueChange={(value) => {
                  onRate(Number(value))
                }}
              >
                {SPEEDS.map((speed) => (
                  <DropdownMenuRadioItem key={speed} value={String(speed)}>
                    {speed === 1 ? 'Normal' : `${String(speed)}×`}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {tracks && tracks.length > 1 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Sound</DropdownMenuLabel>
                  <AudioTracks tracks={tracks} onChoose={onAudioTrack} />
                </>
              )}
            </>
          ),
        })}
        {canPictureInPicture && (
          <ControlButton
            label={state.pictureInPicture ? 'Leave picture-in-picture' : 'Picture-in-picture'}
            onClick={onTogglePictureInPicture}
          >
            <PictureInPicture2 />
          </ControlButton>
        )}
        {canFullscreen && (
          <ControlButton
            label={fullscreen ? 'Leave full screen (f)' : 'Full screen (f)'}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize /> : <Maximize />}
          </ControlButton>
        )}
      </div>
    </div>
  )
}

export function ControlButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label.replace(/ \(.\)$/, '')}
      aria-pressed={pressed}
      title={label}
      className="text-white hover:bg-white/15 hover:text-white"
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/** The browser's audio tracks, one of which plays. */
function AudioTracks({
  tracks,
  onChoose,
}: {
  tracks: AudioTrack[]
  onChoose: (id: string) => void
}) {
  const enabled = tracks.find((track) => track.enabled)
  return (
    <DropdownMenuRadioGroup value={enabled?.id ?? ''} onValueChange={onChoose}>
      {tracks.map((track, i) => (
        <DropdownMenuRadioItem key={track.id} value={track.id}>
          {track.label || track.language || `Track ${String(i + 1)}`}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}
