import { probeResultSchema, type ProbeResult } from '@dfs/shared'
import { z } from 'zod'

// The API's side of the media service (DESIGN.md §6.7). The service parses
// what anyone uploads, so its answers are checked against bounded schemas
// before they are used or kept.

/** ffprobe gets 60 s, and may wait its turn behind another. */
const PROBE_TIMEOUT_MS = 150_000
const HEALTH_TIMEOUT_MS = 2000

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

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.url = url
    this.#fetch = fetchImpl
  }

  /** Has the service examine a version, which it reads from the API with `token`. */
  async probe(versionId: string, token: string): Promise<ProbeResult> {
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
