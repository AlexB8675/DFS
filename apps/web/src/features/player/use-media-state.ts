import { useMemo, useSyncExternalStore } from 'react'

// A media element's state, for the controls: from its events, and while it
// plays, from each frame the screen draws, so the seek bar moves smoothly
// (`timeupdate` comes only a few times a second).

export interface MediaState {
  paused: boolean
  ended: boolean
  /** Waiting for data to go on. */
  waiting: boolean
  currentTime: number
  /** `NaN` until it is known. */
  duration: number
  /** What has loaded, as `[start, end]` in seconds. */
  buffered: [number, number][]
  volume: number
  muted: boolean
  rate: number
  pictureInPicture: boolean
}

const EVENTS = [
  'play',
  'pause',
  'playing',
  'waiting',
  'canplay',
  'seeking',
  'seeked',
  'timeupdate',
  'durationchange',
  'loadedmetadata',
  'progress',
  'volumechange',
  'ratechange',
  'ended',
  'emptied',
  'enterpictureinpicture',
  'leavepictureinpicture',
] as const

/** Events after which the element has what it needs to go on. */
const GOING_ON = new Set(['playing', 'canplay', 'seeked', 'pause', 'emptied'])

const IDLE: MediaState = {
  paused: true,
  ended: false,
  waiting: false,
  currentTime: 0,
  duration: Number.NaN,
  buffered: [],
  volume: 1,
  muted: false,
  rate: 1,
  pictureInPicture: false,
}

function read(media: HTMLVideoElement, waiting: boolean): MediaState {
  const buffered: [number, number][] = []
  for (let i = 0; i < media.buffered.length; i += 1) {
    buffered.push([media.buffered.start(i), media.buffered.end(i)])
  }
  return {
    paused: media.paused,
    ended: media.ended,
    waiting,
    currentTime: media.currentTime,
    duration: media.duration,
    buffered,
    volume: media.volume,
    muted: media.muted,
    rate: media.playbackRate,
    pictureInPicture: document.pictureInPictureElement === media,
  }
}

interface Store {
  subscribe: (onChange: () => void) => () => void
  get: () => MediaState
}

function storeOf(media: HTMLVideoElement, smooth: boolean): Store {
  let waiting = false
  let state: MediaState | null = null
  return {
    get: () => (state ??= read(media, waiting)),
    subscribe: (onChange) => {
      let frame = 0
      const update = (event?: Event) => {
        if (event?.type === 'waiting') waiting = true
        else if (event && GOING_ON.has(event.type)) waiting = false
        state = read(media, waiting)
        onChange()
        cancelAnimationFrame(frame)
        if (smooth && !media.paused) {
          frame = requestAnimationFrame(() => {
            update()
          })
        }
      }
      for (const name of EVENTS) media.addEventListener(name, update)
      update()
      return () => {
        cancelAnimationFrame(frame)
        for (const name of EVENTS) media.removeEventListener(name, update)
      }
    },
  }
}

const idle: Store = { subscribe: () => () => undefined, get: () => IDLE }

/** The element's state; `smooth` follows its time on every frame while it plays. */
export function useMediaState(media: HTMLVideoElement | null, smooth = false): MediaState {
  const store = useMemo(() => (media ? storeOf(media, smooth) : idle), [media, smooth])
  return useSyncExternalStore(store.subscribe, store.get)
}
