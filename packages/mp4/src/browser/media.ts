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
