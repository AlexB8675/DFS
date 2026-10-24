// What the browser suites do with a browser's own media stack (DESIGN.md §10.4,
// D45): fetch a range of a corpus file, append segments to a SourceBuffer, and
// see whether a video plays. Browser code: DOM APIs only, no Node.

/**
 * The bytes `start` to `end` (inclusive, as in a `Range` header) of the file at
 * `url`, fewer where the file ends first. Throws unless the server answers 206.
 */
export async function fetchRange(url: string, start: number, end: number): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  if (response.status !== 206) {
    await response.body?.cancel()
    throw new Error(`Asked ${url} for bytes ${start}-${end} and got ${response.status}, not 206.`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Appends the segments to the buffer one after another, each once the one
 * before it has been taken in (`updateend`), as a SourceBuffer takes one append
 * at a time. Rejects when the buffer reports an `error` (a segment it can't
 * decode or doesn't fit) or when `appendBuffer` throws.
 */
export async function appendAll(
  buffer: SourceBuffer,
  segments: readonly Uint8Array[],
): Promise<void> {
  for (const segment of segments) {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        buffer.removeEventListener('updateend', onEnd)
        buffer.removeEventListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onEnd = (): void => {
        finish()
      }
      const onError = (): void => {
        finish(new Error('The SourceBuffer reported an error appending a segment.'))
      }
      buffer.addEventListener('updateend', onEnd)
      buffer.addEventListener('error', onError)
      try {
        // A buffer that SharedArrayBuffer backs can't be appended, and the type says so.
        buffer.appendBuffer(
          segment.buffer instanceof ArrayBuffer
            ? (segment as Uint8Array<ArrayBuffer>)
            : segment.slice(),
        )
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

/** How far the clock must move for the video to count as playing: more than a seek to its first frame. */
const PLAYING_SECONDS = 0.1

/** The video's `MediaError` as an Error that says its code and message, or null while it has none. */
export function mediaErrorOf(video: HTMLVideoElement): Error | null {
  const { error } = video
  if (!error) return null
  return new Error(
    `The video reported a MediaError ${error.code}: ${error.message || 'no message'}`,
  )
}

/**
 * Whether the video's `currentTime` advances (by {@link PLAYING_SECONDS}) within
 * `ms` milliseconds of the call: true as soon as it has, false if it hasn't by
 * then. Starting the video is for the caller, which knows whether it is muted.
 * A video that has a `MediaError` is not one that simply hasn't started: it
 * throws that error at once (see {@link mediaErrorOf}), not at the end of the wait.
 */
export async function startsPlaying(video: HTMLVideoElement, ms: number): Promise<boolean> {
  const from = video.currentTime
  const until = performance.now() + ms
  for (;;) {
    const error = mediaErrorOf(video)
    if (error) throw error
    if (video.currentTime - from >= PLAYING_SECONDS) return true
    if (performance.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Resolves once the media source has opened, or rejects with the video's
 * `MediaError` if the video reports one first (see {@link mediaErrorOf}), so that
 * a failure doesn't wait out the test's timeout. Called before the video is given
 * the source's URL, as the event comes after it.
 */
export function mediaSourceOpened(
  video: HTMLVideoElement,
  mediaSource: MediaSource,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      mediaSource.removeEventListener('sourceopen', onOpen)
      video.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onOpen = (): void => {
      finish()
    }
    const onError = (): void => {
      finish(mediaErrorOf(video) ?? new Error('The video reported an error.'))
    }
    mediaSource.addEventListener('sourceopen', onOpen)
    video.addEventListener('error', onError)
  })
}

/**
 * How far `video.currentTime` gets, polled every 25 ms for up to `ms`
 * milliseconds from the call or until it reaches `seconds`: whether it did, and
 * the highest it was seen to be (a video that never started stays near where it
 * was). Starting the video is for the caller. Like {@link startsPlaying}, it throws
 * the video's `MediaError` at once if it has one.
 */
export async function playsUntil(
  video: HTMLVideoElement,
  seconds: number,
  ms: number,
): Promise<{ reached: boolean; highest: number }> {
  const until = performance.now() + ms
  let highest = video.currentTime
  for (;;) {
    const error = mediaErrorOf(video)
    if (error) throw error
    highest = Math.max(highest, video.currentTime)
    if (highest >= seconds) return { reached: true, highest }
    if (performance.now() >= until) return { reached: false, highest }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Resolves at the next event of the type on the target, or rejects with a sentence if none comes within `ms` milliseconds. */
export function waitFor(target: EventTarget, type: string, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, onEvent)
      reject(new Error(`No '${type}' event came within ${ms} ms.`))
    }, ms)
    const onEvent = (): void => {
      clearTimeout(timer)
      resolve()
    }
    target.addEventListener(type, onEvent, { once: true })
  })
}

/** Whether `test` becomes true, polled every 10 ms, within `ms` milliseconds of the call. */
export async function waitUntil(test: () => boolean, ms: number): Promise<boolean> {
  const until = performance.now() + ms
  while (!test()) {
    if (performance.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

/** The pictures a video has shown since `watchFrames`, as `mediaTime`s (the presentation time of each, in seconds), in the order they were shown. */
export interface FrameWatch {
  shown: number[]
  stop: () => void
}

/**
 * Records the `mediaTime` of each picture that the video presents from now on
 * (`requestVideoFrameCallback`, which fires for a picture shown after a seek on
 * a paused video as well as for those of a video that plays), until `stop`.
 */
export function watchFrames(video: HTMLVideoElement): FrameWatch {
  const watch: FrameWatch = {
    shown: [],
    stop: () => {
      stopped = true
    },
  }
  let stopped = false
  const arm = (): void => {
    video.requestVideoFrameCallback((_now, metadata) => {
      if (stopped) return
      watch.shown.push(metadata.mediaTime)
      arm()
    })
  }
  arm()
  return watch
}
