import type { TimelineEventInput } from '@dfs/shared'
import { clipText } from './recorder'

// What a `<video>` does, for the play's timeline (§10.4, §16): its events with
// its time and ready state, its errors, a sample of its buffer once a second
// while it plays and rarely while it is paused, and the first picture after the
// start and after each seek where the browser can say. The page around it
// (visibility, the network, leaving) is `watchPage`'s, which starts with the
// play, before the element exists. Every number is rounded and held to the
// shared schema's bounds, so the recorder doesn't refuse an event for what a
// browser reports oddly.

/** How often a playing video is sampled. */
const SAMPLE_MS = 1000
/** How rarely a paused video is, and only when something changed. */
const PAUSED_SAMPLE_MS = 10_000
/** A paused video's buffer moving this far, in seconds, is a change. */
const AHEAD_MOVE_S = 1
/** A buffer starting this far past the playhead still holds it: ranges begin at a frame, not at the time asked. */
const RANGE_START_TOLERANCE_S = 0.05
/** The ranges one sample holds. */
const MAX_RANGES = 20
/** The schema's bound on seconds of video. */
const MAX_SECONDS = 1e7
/** The schema's bound on frame counts. */
const MAX_FRAMES = 1e9

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
    // The range holding the time can be past the first 20, which the sample leaves out. One that
    // starts a hair after the time holds it: ranges begin at a frame, and a seek lands between.
    if (start - RANGE_START_TOLERANCE_S <= time && time <= end) aheadS = seconds(end - time, 3)
    if (ranges.length < MAX_RANGES) ranges.push([seconds(start, 2), seconds(end, 2)])
  }
  return { at: seconds(time, 3), aheadS, ranges, rangeCount: buffered.length }
}

/**
 * Records what `video` does through `record`, until the function returned is
 * called, which removes every listener and the timer and cancels a frame still
 * asked for.
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
      // Not at `seeking`: the frame still on show then is from before the seek.
      if (name === 'seeked') askForPicture('seek')
    })
  }
  listen(video, 'error', () => {
    // Some engines leave `message` out, which the DOM library types as always there.
    const error: { code: number; message?: unknown } | null = video.error
    const code = error?.code ?? null
    const message =
      typeof error?.message === 'string' && error.message !== ''
        ? error.message
        : code === null
          ? 'media error'
          : `media error ${String(code)}`
    record({ type: 'error', from: 'element', code, message: clipText(message) })
  })

  // A playing video is sampled at every tick. A paused one is when it has just paused, and
  // after that only when its buffer or ready state changed since the last sample, and not
  // within PAUSED_SAMPLE_MS of a sample that was itself of a paused video.
  let last: {
    aheadS: number
    readyState: number
    rangeCount: number
    paused: boolean
    time: number
  } | null = null
  const sample = () => {
    const { at, aheadS, ranges, rangeCount } = bufferState(video)
    const readyState = video.readyState
    const time = performance.now()
    const paused = video.paused
    if (paused && last !== null) {
      const changed =
        paused !== last.paused ||
        Math.abs(aheadS - last.aheadS) >= AHEAD_MOVE_S ||
        readyState !== last.readyState ||
        rangeCount !== last.rangeCount
      if (!changed || (last.paused && time - last.time < PAUSED_SAMPLE_MS)) return
    }
    last = { aheadS, readyState, rangeCount, paused, time }
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
