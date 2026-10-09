import { splitExtension } from '@dfs/shared'
import { z } from 'zod'
import { queryClient } from '@/app/query-client'
import { mediaQuery, playbackQuery } from '@/features/player/api'
import { browserCanPlayType, codecLabel, playability } from '@/features/player/codecs'
import { ApiError, errorMessage } from '@/lib/api/client'
import { drivePlace, linkPlace, type FilePlace } from '@/lib/file-place'
import {
  appendTracks,
  currentTrack,
  EMPTY_QUEUE,
  jumpTo,
  moveTrack,
  removeTrack,
  shuffleQueue,
  startQueue,
  stepQueue,
  updateTrack,
  type Queue,
  type QueuedTrack,
} from './queue'
import { useAudioStore, type AudioProblem, type Repeat } from './store'

// The audio bar's engine (DESIGN.md §10.4): one `<audio>` element, made here
// rather than drawn by React, so it plays on from page to page, and so a
// click can start it at once, which a phone requires of the sound a page
// first makes. Whether it plays, its time and its length are read from the
// element itself (`useMediaState`); the store holds the queue.

/** The element; `null` where there is no page (tests). */
export const audio: HTMLAudioElement | null = typeof Audio === 'undefined' ? null : new Audio()

/** A track as it is added, before the queue gives it a key. */
export type NewTrack = Omit<QueuedTrack, 'key'>

/** The speeds the bar offers, for audiobooks and podcasts too. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

/** Past this into a track, Previous starts it again rather than going back. */
const RESTART_AFTER_S = 3
/** How often its time is written down while it plays, for a reload. */
const SAVE_EVERY_MS = 5000
const POSITION_KEY = 'dfs.audio-position'
const savedPositionSchema = z.object({ key: z.string(), seconds: z.number().min(0) })

/** Where to go once the element knows the track's length. */
let pendingSeek: number | null = null
let lastSave = 0
let unlocked = false

const store = useAudioStore

/** Where the track's file is: the drive's, or a link's. */
export function placeOf(track: Pick<QueuedTrack, 'id' | 'token'>): FilePlace {
  return track.token === null ? drivePlace(track.id) : linkPlace(track.token, track.id)
}

/**
 * The track's bytes: of its version once the queue names one, and through a
 * link as a preview, which a link's download limit doesn't count (§7.5).
 */
export function trackUrl(track: Pick<QueuedTrack, 'id' | 'token' | 'versionId'>): string {
  const query = new URLSearchParams()
  if (track.versionId) query.set('version', track.versionId)
  if (track.token !== null) query.set('preview', '1')
  const search = query.toString()
  return `/api${placeOf(track).path}/content${search ? `?${search}` : ''}`
}

/** Its cover's address, when there is one to show. */
export function coverUrl(track: QueuedTrack): string | null {
  return track.hasCover && track.versionId
    ? `/api${placeOf(track).path}/media/${track.versionId}/cover`
    : null
}

/** What the bar calls a track: its title from the tags, else its name. */
export function trackTitle(track: Pick<QueuedTrack, 'title' | 'name'>): string {
  return track.title ?? splitExtension(track.name).base
}

/** Loads `track` into the element, from `at` seconds, playing if asked. */
function load(track: QueuedTrack, play: boolean, at = 0): void {
  if (!audio) return
  store.setState({ loaded: track.key, problem: null, resume: null })
  audio.preload = 'auto'
  audio.src = trackUrl(track)
  applySpeed()
  pendingSeek = at > 0 ? at : null
  if (play) void audio.play().catch(() => undefined)
}

/** Plays `tracks` from `first` at once: called from a click. */
export function playTracks(tracks: NewTrack[], first = 0): void {
  if (tracks.length === 0) return
  const queue = startQueue(withKeys(tracks), first, store.getState().shuffle)
  setQueue(queue)
  const track = currentTrack(queue)
  if (track) load(track, true)
}

/**
 * A file opened from a list plays at once, by itself; its folder's queue,
 * once it comes, takes its place around it without starting it over.
 */
export function playOpened(track: NewTrack, folder: Promise<NewTrack[]>): void {
  playTracks([track])
  const opened = currentTrack(store.getState().queue)
  if (!opened) return
  folder
    .then((tracks) => {
      const { queue, shuffle } = store.getState()
      // Moved on meanwhile, or added to: the queue is the user's now.
      if (queue.tracks.length !== 1 || currentTrack(queue)?.key !== opened.key) return
      const first = tracks.findIndex((found) => found.id === track.id)
      if (first === -1) return
      const keyed = tracks.map((found, i) => ({
        ...found,
        key: i === first ? opened.key : crypto.randomUUID(),
      }))
      setQueue(startQueue(keyed, first, shuffle))
    })
    .catch(() => undefined)
}

/** More tracks after the queue's; into an empty queue, they start playing. */
export function addTracks(tracks: NewTrack[]): void {
  const { queue, shuffle } = store.getState()
  if (queue.tracks.length === 0) {
    playTracks(tracks)
    return
  }
  setQueue(appendTracks(queue, withKeys(tracks), shuffle))
}

/** Plays the queue's entry with `key`. */
export function playEntry(key: string): void {
  const queue = jumpTo(store.getState().queue, key)
  setQueue(queue)
  const track = currentTrack(queue)
  if (track) load(track, true)
}

export function next(): void {
  go(1)
}

/** Back to the track's start once 3 s in, else to the one before. */
export function previous(): void {
  if (audio && store.getState().loaded !== null && audio.currentTime > RESTART_AFTER_S) {
    audio.currentTime = 0
    return
  }
  go(-1)
}

function go(by: 1 | -1): void {
  const { queue, repeat } = store.getState()
  const stepped = stepQueue(queue, by, repeat === 'all')
  if (!stepped) {
    // The first track goes back to its start; past the last, it stays there.
    if (by < 0 && audio) audio.currentTime = 0
    return
  }
  setQueue(stepped)
  const track = currentTrack(stepped)
  if (track) load(track, true)
}

/** Plays or pauses; after a reload, the first Play loads the track, from where it was. */
export function togglePlay(): void {
  if (!audio) return
  const track = currentTrack(store.getState().queue)
  if (!track) return
  if (store.getState().loaded !== track.key) {
    load(track, true, savedPosition(track.key))
    return
  }
  if (audio.paused || audio.ended) void audio.play().catch(() => undefined)
  else audio.pause()
}

export function pauseAudio(): void {
  audio?.pause()
}

/** To `seconds` into the track; not loaded yet (after a reload), it loads there, paused. */
export function seekTo(seconds: number): void {
  if (!audio) return
  const track = currentTrack(store.getState().queue)
  if (!track) return
  if (store.getState().loaded !== track.key) load(track, false, seconds)
  else audio.currentTime = Math.max(0, seconds)
}

/** Takes up the offer to resume (§10.4): there, playing. */
export function resumeFrom(seconds: number): void {
  store.setState({ resume: null })
  seekTo(seconds)
  if (audio && (audio.paused || audio.ended)) void audio.play().catch(() => undefined)
}

/** After a read failed: the track again, from where it was. */
export function retry(): void {
  const track = currentTrack(store.getState().queue)
  if (track && audio) load(track, true, audio.currentTime)
}

export function setSpeed(speed: number): void {
  store.setState({ speed })
  applySpeed()
}

/** A new source starts at the default rate: both are set, so the speed holds from track to track. */
function applySpeed(): void {
  if (!audio) return
  const { speed } = store.getState()
  audio.defaultPlaybackRate = speed
  audio.playbackRate = speed
}

export function toggleShuffle(): void {
  const { queue, shuffle } = store.getState()
  store.setState({ shuffle: !shuffle, queue: shuffleQueue(queue, !shuffle) })
}

const REPEATS: Repeat[] = ['off', 'all', 'one']

/** Off, the queue, the track, off. */
export function cycleRepeat(): void {
  const { repeat } = store.getState()
  store.setState({ repeat: REPEATS[(REPEATS.indexOf(repeat) + 1) % REPEATS.length] ?? 'off' })
}

/** Without the entry with `key`; the one playing goes on with the next, as it was. */
export function removeEntry(key: string): void {
  const { queue, loaded } = store.getState()
  const rest = removeTrack(queue, key)
  setQueue(rest)
  if (loaded !== key) return
  const track = currentTrack(rest)
  if (!track) stop()
  else load(track, !(audio?.paused ?? true))
}

export function moveEntry(from: number, to: number): void {
  const { queue, shuffle } = store.getState()
  setQueue(moveTrack(queue, from, to, shuffle))
}

/** Stops, and empties the queue. */
export function clearQueue(): void {
  stop()
  store.setState({ queue: EMPTY_QUEUE, problem: null, resume: null, panel: null })
  try {
    localStorage.removeItem(POSITION_KEY)
  } catch {
    // Nothing kept here.
  }
}

/** What a queue entry's media info or version adds to it, once known. */
export function updateEntry(key: string, change: Partial<Omit<QueuedTrack, 'key'>>): void {
  setQueue(updateTrack(store.getState().queue, key, change))
}

/** Only links' tracks stay: one user's drive files aren't another's (§10.4). */
export function forgetDriveTracks(): void {
  const { queue } = store.getState()
  const kept = queue.tracks.filter((track) => track.token !== null)
  if (kept.length === queue.tracks.length) return
  stop()
  store.setState({
    queue: kept.length ? startQueue(kept, 0, false) : EMPTY_QUEUE,
    problem: null,
    resume: null,
  })
}

/**
 * Lets the element play once a request has come back: a phone allows sound
 * only from a click, so the click plays a moment of silence first.
 */
export function unlockAudio(): void {
  if (!audio || unlocked || store.getState().loaded !== null) return
  unlocked = true
  audio.src = '/silence.wav'
  void audio.play().catch(() => undefined)
}

function stop(): void {
  if (!audio) return
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  store.setState({ loaded: null })
}

function setQueue(queue: Queue): void {
  store.setState({ queue })
}

function withKeys(tracks: NewTrack[]): QueuedTrack[] {
  return tracks.map((track) => ({ ...track, key: crypto.randomUUID() }))
}

/** Where the entry with `key` was, after a reload; 0 for another. */
export function savedPosition(key: string): number {
  try {
    const kept = savedPositionSchema.safeParse(
      JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null'),
    )
    return kept.success && kept.data.key === key ? kept.data.seconds : 0
  } catch {
    return 0
  }
}

function savePosition(now: boolean): void {
  const key = store.getState().loaded
  if (!audio || key === null) return
  if (!now && Date.now() - lastSave < SAVE_EVERY_MS) return
  lastSave = Date.now()
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify({ key, seconds: audio.currentTime }))
  } catch {
    // Nothing is kept here: after a reload, it starts at the beginning.
  }
}

/** Says why the track playing stopped, as far as the API and the media info tell. */
async function explainError(): Promise<void> {
  const code = audio?.error?.code
  const track = currentTrack(store.getState().queue)
  if (!audio || code === undefined || track === null) return
  // An error of a track it has since moved on from says nothing now.
  if (store.getState().loaded !== track.key) return
  const place = placeOf(track)
  const fresh = await queryClient
    .query({ ...playbackQuery(place), staleTime: 0 })
    .catch((reason: unknown) => (reason instanceof ApiError ? reason : null))
  // Gone, or its link ended: the API says why.
  if (fresh instanceof ApiError && fresh.status < 500) {
    report({ key: track.key, message: errorMessage(fresh), offer: 'none' })
    return
  }
  // Replaced since it was queued: the new version, from where it was.
  if (
    fresh &&
    !(fresh instanceof ApiError) &&
    track.versionId &&
    fresh.versionId !== track.versionId
  ) {
    updateEntry(track.key, { versionId: fresh.versionId })
    const updated = currentTrack(store.getState().queue)
    if (updated) load(updated, true, audio.currentTime)
    return
  }
  if (code === MediaError.MEDIA_ERR_NETWORK) {
    report({ key: track.key, message: 'It stopped loading.', offer: 'retry' })
    return
  }
  const media = await queryClient.query(mediaQuery(place)).catch(() => null)
  // It failed to play: unless the browser says it decodes the sound, the codec is why.
  const sound = media?.info ? playability(media.info, browserCanPlayType).audio : null
  report({
    key: track.key,
    message:
      sound && sound.decodes !== true
        ? `This browser can’t play ${codecLabel(sound.stream.codec)}.`
        : 'This browser can’t play this file.',
    offer: 'download',
  })
}

/** Stops the bar on the track with why: Next goes on (the user's decision, 2026-10-09). */
function report(problem: AudioProblem): void {
  if (currentTrack(store.getState().queue)?.key === problem.key) store.setState({ problem })
}

/** The lock screen, notifications and media keys (Media Session). */
function announce(): void {
  const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession
  const track = currentTrack(store.getState().queue)
  if (!session || !track) return
  const cover = coverUrl(track)
  session.metadata = new MediaMetadata({
    title: trackTitle(track),
    artist: track.artist ?? '',
    album: track.album ?? '',
    artwork: cover ? [{ src: new URL(cover, window.location.href).href }] : [],
  })
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void audio?.play().catch(() => undefined)],
    ['pause', pauseAudio],
    ['previoustrack', previous],
    ['nexttrack', next],
    [
      'seekto',
      (details) => {
        if (details.seekTime !== undefined) seekTo(details.seekTime)
      },
    ],
    [
      'seekbackward',
      (details) => {
        seekTo((audio?.currentTime ?? 0) - (details.seekOffset ?? 10))
      },
    ],
    [
      'seekforward',
      (details) => {
        seekTo((audio?.currentTime ?? 0) + (details.seekOffset ?? 10))
      },
    ],
  ]
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler)
    } catch {
      // Not supported here.
    }
  }
}

if (audio) {
  audio.preload = 'none'
  audio.addEventListener('ended', () => {
    // The moment of silence that unlocked it isn't a track.
    if (store.getState().loaded === null) return
    if (store.getState().repeat === 'one') {
      audio.currentTime = 0
      void audio.play().catch(() => undefined)
    } else {
      go(1)
    }
  })
  audio.addEventListener('loadedmetadata', () => {
    applySpeed()
    if (pendingSeek !== null) audio.currentTime = pendingSeek
    pendingSeek = null
  })
  audio.addEventListener('error', () => {
    // The moment of silence that unlocked it isn't a track.
    if (store.getState().loaded !== null) void explainError()
  })
  // The video player took the lock screen meanwhile, and gave it back empty.
  audio.addEventListener('play', announce)
  audio.addEventListener('timeupdate', () => {
    savePosition(false)
  })
  audio.addEventListener('pause', () => {
    savePosition(true)
  })
  window.addEventListener('pagehide', () => {
    savePosition(true)
  })
}

// Vite's hot reload makes a new element: the old one stops.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    audio?.pause()
  })
}
