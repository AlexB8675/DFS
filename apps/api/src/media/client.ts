import type { Metrics } from '@dfs/db'
import {
  MAX_COVER_BYTES,
  probeResultSchema,
  subtitleTracksResultSchema,
  type MetricName,
  type ProbeResult,
  type SubtitleTracksResult,
} from '@dfs/shared'
import { z } from 'zod'

// The API's side of the media service (DESIGN.md §6.7). The service parses
// what anyone uploads, so its answers are checked against bounded schemas
// before they are used or kept. They are timed for the graphs here, and the
// asks it fails counted (§16): the service has no database of its own.

/** ffprobe gets 60 s, and may wait its turn behind another. */
const PROBE_TIMEOUT_MS = 150_000
/** Extracting reads the whole file (15 minutes at most), and may wait its turn behind another. */
const SUBTITLES_TIMEOUT_MS = 40 * 60_000
const HEALTH_TIMEOUT_MS = 2000
/** A cover is read from the file's start or its index, and may wait its turn behind a probe. */
const COVER_TIMEOUT_MS = 150_000

/** The media service didn't answer, or couldn't read the file from the API: ask again later. */
export class MediaUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MediaUnavailableError'
  }
}

const healthSchema = z.object({
  status: z.literal('ok'),
  release: z.string().max(100),
  ffmpeg: z.string().max(300),
})

export class MediaClient {
  readonly url: string
  readonly #fetch: typeof fetch
  readonly #metrics: Metrics | undefined

  constructor(url: string, fetchImpl: typeof fetch = fetch, metrics?: Metrics) {
    this.url = url
    this.#fetch = fetchImpl
    this.#metrics = metrics
  }

  /** Has the service examine a version, which it reads from the API with `token`. */
  async probe(versionId: string, token: string): Promise<ProbeResult> {
    const result = await this.#timed('media.probe_ms', async () => {
      const response = await this.#ask('/probe', PROBE_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId, token }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new MediaUnavailableError(
          `The media service answered ${String(response.status)} to examining a file.`,
        )
      }
      const answer = probeResultSchema.safeParse(await response.json().catch(() => null))
      if (!answer.success) {
        throw new MediaUnavailableError('The media service gave an answer out of bounds.')
      }
      return answer.data
    })
    if (!result.ok) this.#metrics?.record('media.unreadable')
    return result
  }

  /** Has the service extract text subtitle streams as WebVTT, all in one read of the file. */
  subtitles(
    versionId: string,
    token: string,
    streams: readonly number[],
  ): Promise<SubtitleTracksResult> {
    return this.#timed('media.subtitles_ms', async () => {
      const response = await this.#ask('/subtitles', SUBTITLES_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId, token, streams }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new MediaUnavailableError(
          `The media service answered ${String(response.status)} to extracting subtitles.`,
        )
      }
      const answer = subtitleTracksResultSchema.safeParse(await response.json().catch(() => null))
      if (!answer.success) {
        throw new MediaUnavailableError('The media service gave an answer out of bounds.')
      }
      return answer.data
    })
  }

  /** Has the service copy out the picture in an audio file's tags: its bytes, or `null` without one. */
  cover(versionId: string, token: string): Promise<Buffer | null> {
    return this.#timed('media.cover_ms', async () => {
      const response = await this.#ask('/cover', COVER_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId, token }),
      })
      // No picture is an answer, not a failure.
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new MediaUnavailableError(
          `The media service answered ${String(response.status)} to a cover.`,
        )
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      return bytes.length > MAX_COVER_BYTES ? null : bytes
    })
  }

  /** `ask`'s answer, timed as `name`; one that fails counts as a failed request. */
  async #timed<T>(name: MetricName, ask: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      const answer = await ask()
      this.#metrics?.time(name, performance.now() - started)
      return answer
    } catch (error) {
      this.#metrics?.record('media.failures')
      throw error
    }
  }

  async health(): Promise<z.infer<typeof healthSchema>> {
    const response = await this.#ask('/health', HEALTH_TIMEOUT_MS)
    return healthSchema.parse(await response.json())
  }

  async #ask(path: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.#fetch(`${this.url}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new MediaUnavailableError('The media service isn’t answering.', { cause: error })
    }
  }
}
