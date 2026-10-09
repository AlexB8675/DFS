import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { mediaQuery, playbackQuery } from '@/features/player/api'
import { usePlayerPreferences } from '@/features/player/preferences'
import { RESUME_FROM_MS, RESUME_OFFER_MS } from '@/features/player/resume-rules'
import { useMediaState } from '@/features/player/use-media-state'
import { useResume } from '@/features/player/use-resume'
import { audio, placeOf, updateEntry } from './engine'
import { currentTrack, type QueuedTrack } from './queue'
import { useAudioStore } from './store'

// The audio bar's work that needs React (DESIGN.md §10.4), drawing nothing,
// in `App`, so it goes on from page to page: the volume, the players' one;
// what a track's media info adds to it; and, for files over 20 minutes,
// where the listener stopped, offered when it starts again.

/** Audio this long has where it stopped kept, and offered. */
const LONG_AUDIO_MS = 20 * 60_000

export function AudioEngine() {
  const track = useAudioStore((state) => currentTrack(state.queue))

  // A change of volume in the video player reaches the bar too.
  useEffect(() => {
    if (!audio) return
    const element = audio
    const apply = ({ volume, muted }: { volume: number; muted: boolean }) => {
      element.volume = volume
      element.muted = muted
    }
    apply(usePlayerPreferences.getState())
    return usePlayerPreferences.subscribe(apply)
  }, [])

  return track ? <TrackEffects key={track.key} track={track} /> : null
}

/** For the track playing: what its media info says, and where it stopped. */
function TrackEffects({ track }: { track: QueuedTrack }) {
  const place = placeOf(track)
  const loaded = useAudioStore((state) => state.loaded === track.key)
  const offering = useAudioStore((state) => state.resume?.key === track.key)
  const state = useMediaState(loaded ? audio : null)

  // A file started at a click, or through a file link, comes with its name alone.
  const media = useQuery({ ...mediaQuery(place), enabled: loaded }).data
  useEffect(() => {
    if (!media) return
    const change: Partial<Omit<QueuedTrack, 'key'>> = {}
    if (track.versionId === null) change.versionId = media.versionId
    const info = media.info
    if (info) {
      if (track.durationMs === null && info.durationMs !== null) change.durationMs = info.durationMs
      if (track.title === null && info.tags.title) change.title = info.tags.title
      if (track.artist === null && info.tags.artist) change.artist = info.tags.artist
      if (track.album === null && info.tags.album) change.album = info.tags.album
      if (!track.hasCover && info.hasCover) change.hasCover = true
    }
    if (Object.keys(change).length > 0) updateEntry(track.key, change)
  }, [media, track])

  // Where it stopped, for a file long enough to come back to.
  const long = (track.durationMs ?? 0) > LONG_AUDIO_MS
  const playback = useQuery({ ...playbackQuery(place), enabled: long && loaded }).data
  const offered = useRef(false)
  useEffect(() => {
    const positionMs = playback?.positionMs
    if (offered.current || positionMs === undefined || positionMs === null || !audio) return
    offered.current = true
    if (positionMs >= RESUME_FROM_MS && audio.currentTime * 1000 < RESUME_OFFER_MS) {
      useAudioStore.setState({ resume: { key: track.key, seconds: positionMs / 1000 } })
    }
  }, [playback, track.key])
  // Played on past the offer's time, or to the end: what plays is where the listener is.
  useEffect(() => {
    if (offering && (state.ended || state.currentTime * 1000 >= RESUME_OFFER_MS)) {
      useAudioStore.setState({ resume: null })
    }
  }, [offering, state.ended, state.currentTime])
  useResume({
    place,
    // Once /playback has said where it was, so finishing it clears that.
    video: long && loaded && playback && track.versionId ? audio : null,
    versionId: track.versionId,
    savedMs: playback?.positionMs ?? null,
    offering,
  })
  return null
}
