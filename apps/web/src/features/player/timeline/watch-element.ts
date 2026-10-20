import type { TimelineConnection, TimelineEventInput } from '@dfs/shared'
import { clipText } from './recorder'

// What a `<video>` and the page around it do, for the play's timeline (§10.4,
// §16): the element's events with its time and ready state, a sample of its
// buffer once a second while it plays and rarely while it is paused, the first
// picture after the start and after each seek where the browser can say, and
// the page going online or offline, hiding or showing, and its connection
// changing. Every number is rounded and held to the shared schema's bounds, so
// the recorder doesn't refuse an event for what a browser reports oddly.

/** How often a playing video is sampled. */
const SAMPLE_MS = 1000
/** How rarely a paused video is, and only when something changed. */
const PAUSED_SAMPLE_MS = 10_000
/** A paused video's buffer moving this far, in seconds, is a change. */
const AHEAD_MOVE_S = 1
/** The ranges one sample holds. */
const MAX_RANGES = 20
/** The schema's bound on seconds of video. */
const MAX_SECONDS = 1e7
/** The schema's bound on frame counts. */
const MAX_FRAMES = 1e9
/** The schema's bound on a connection's figures. */
const MAX_CONNECTION = 1e6

type ElementName = Extract<TimelineEventInput, { type: 'element' }>['name']

const ELEMENT_EVENTS: readonly ElementName[] = [
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'seeking',
  'seeked',
  'ended',
  'emptied',
]

/** What `navigator.connection` has, which TypeScript's DOM library leaves out. */
interface ConnectionLike extends EventTarget {
  effectiveType?: unknown
  downlink?: unknown
  rtt?: unknown
  saveData?: unknown
}

/** What a browser may leave out of an element, which the DOM library types as always there. */
type OptionalVideo = Partial<
  Pick<
    HTMLVideoElement,
    'getVideoPlaybackQuality' | 'requestVideoFrameCallback' | 'cancelVideoFrameCallback'
  >
>

/** `value` in seconds rounded to `digits` decimals and held to the schema's range; 0 for what isn't a number. */
function seconds(value: number, digits: 2 | 3): number {
  if (!Number.isFinite(value)) return 0
  const scale = 10 ** digits
  return Math.min(MAX_SECONDS, Math.max(0, Math.round(value * scale) / scale))
}

/** A frame count held to the schema's range; 0 when the browser gave none. */
function frames(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(MAX_FRAMES, Math.max(0, Math.trunc(value)))
}

/** A figure of the connection when it is a number from 0 up, held to the schema's range; else `null`. */
function figure(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(MAX_CONNECTION, value)
}

function connectionObject(): ConnectionLike | null {
  if (!('connection' in navigator)) return null
  const connection: unknown = navigator.connection
  return typeof connection === 'object' && connection !== null
    ? (connection as ConnectionLike)
    : null
}

function describeConnection(connection: ConnectionLike): TimelineConnection {
  const type =
    typeof connection.effectiveType === 'string' ? clipText(connection.effectiveType, 10) : ''
  return {
    effectiveType: type === '' ? null : type,
    downlinkMbps: figure(connection.downlink),
    rttMs: figure(connection.rtt),
    saveData: typeof connection.saveData === 'boolean' ? connection.saveData : null,
  }
}

/** What `navigator.connection` says now, or `null` where the browser has no such thing. */
export function connectionNow(): TimelineConnection | null {
  const connection = connectionObject()
  return connection === null ? null : describeConnection(connection)
}

/** The buffer as a sample holds it. */
function bufferState(video: HTMLVideoElement) {
  const time = Number.isFinite(video.currentTime) ? video.currentTime : 0
  const buffered = video.buffered
  const ranges: [number, number][] = []
  let aheadS = 0
  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index)
    const end = buffered.end(index)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    // The range holding the time can be past the first 20, which the sample leaves out.
    if (start <= time && time <= end) aheadS = seconds(end - time, 3)
    if (ranges.length < MAX_RANGES) ranges.push([seconds(start, 2), seconds(end, 2)])
  }
  return { at: seconds(time, 3), aheadS, ranges, rangeCount: buffered.length }
}

/**
 * Records what `video` and the page do through `record`, until the function
 * returned is called, which removes every listener and the timer and cancels
 * a frame still asked for.
 */
export function watchElement(
  video: HTMLVideoElement,
  record: (event: TimelineEventInput) => void,
): () => void {
  const optional: OptionalVideo = video
  const cleanups: (() => void)[] = []
  let stopped = false

  const listen = (target: EventTarget, type: string, handler: () => void) => {
    target.addEventListener(type, handler)
    cleanups.push(() => {
      target.removeEventListener(type, handler)
    })
  }

  // The first picture after the start or a seek, where the browser can say.
  let frame: number | null = null
  const askForPicture = (after: 'start' | 'seek') => {
    if (optional.requestVideoFrameCallback === undefined) return
    if (frame !== null) optional.cancelVideoFrameCallback?.(frame)
    frame = optional.requestVideoFrameCallback((_now, metadata) => {
      frame = null
      if (!stopped) record({ type: 'picture', at: seconds(metadata.mediaTime, 3), after })
    })
  }

  for (const name of ELEMENT_EVENTS) {
    listen(video, name, () => {
      record({
        type: 'element',
        name,
        at: seconds(video.currentTime, 3),
        readyState: video.readyState,
      })
      if (name === 'seeking') askForPicture('seek')
    })
  }
  listen(video, 'error', () => {
    const error = video.error
    const code = error?.code ?? null
    const message =
      error !== null && error.message !== ''
        ? error.message
        : code === null
          ? 'media error'
          : `media error ${code}`
    record({ type: 'error', from: 'element', code, message: clipText(message) })
  })

  // A playing video is sampled at every tick; a paused one only when its buffer
  // or ready state changed since the last sample, and not within PAUSED_SAMPLE_MS of it.
  let last: { aheadS: number; readyState: number; rangeCount: number; time: number } | null = null
  const sample = () => {
    const { at, aheadS, ranges, rangeCount } = bufferState(video)
    const readyState = video.readyState
    const time = performance.now()
    const paused = video.paused
    if (paused && last !== null) {
      const changed =
        Math.abs(aheadS - last.aheadS) >= AHEAD_MOVE_S ||
        readyState !== last.readyState ||
        rangeCount !== last.rangeCount
      if (!changed || time - last.time < PAUSED_SAMPLE_MS) return
    }
    last = { aheadS, readyState, rangeCount, time }
    const quality = optional.getVideoPlaybackQuality?.()
    record({
      type: 'sample',
      at,
      aheadS,
      ranges,
      readyState,
      paused,
      frames: frames(quality?.totalVideoFrames),
      dropped: frames(quality?.droppedVideoFrames),
    })
  }
  const timer = setInterval(sample, SAMPLE_MS)

  // The page's own state.
  listen(window, 'online', () => {
    record({ type: 'network', online: true })
  })
  listen(window, 'offline', () => {
    record({ type: 'network', online: false })
  })
  listen(document, 'visibilitychange', () => {
    record({ type: 'visibility', hidden: document.visibilityState === 'hidden' })
  })
  const connection = connectionObject()
  if (connection !== null) {
    listen(connection, 'change', () => {
      record({ type: 'connection', connection: describeConnection(connection) })
    })
  }

  askForPicture('start')

  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    for (const cleanup of cleanups) cleanup()
    if (frame !== null) optional.cancelVideoFrameCallback?.(frame)
    frame = null
  }
}
