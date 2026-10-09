import { MAX_SUBTITLE_STREAMS, type ProbeResult, type SubtitleTracksResult } from '@dfs/shared'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { z } from 'zod'
import type { MediaConfig } from './config.ts'
import { extractCover } from './cover.ts'
import { ffmpegVersion, ProbeError, runProbe } from './ffprobe.ts'
import { toMediaInfo } from './media-info.ts'
import { extractSubtitles } from './subtitles.ts'

// The media service's routes (DESIGN.md §6.7). The API is its only client,
// on the internal network. It holds no secret to check callers with, and
// needs none: it reads a file only with the API's token for that file, and
// the API it reads from is its own setting, never the caller's.

/** ffprobes at once: the service has one CPU, shared with remuxes. */
const PROBES_AT_ONCE = 2
/** Extractions read whole files: one at a time. */
const EXTRACTIONS_AT_ONCE = 1

const probeBody = z.object({
  versionId: z.uuid(),
  /**
   * The API's token for this version alone (`/internal/media/:versionId`),
   * in its exact form (`<expiry>.<HMAC>`): it goes into ffmpeg's request
   * headers, so nothing else may.
   */
  token: z.string().regex(/^\d{1,16}\.[\w-]{43}$/),
})

const subtitlesBody = probeBody.extend({
  /** The text subtitle streams to extract, by ffmpeg's numbers. */
  streams: z.array(z.number().int().min(0).max(10_000)).min(1).max(MAX_SUBTITLE_STREAMS),
})

export interface MediaServerOptions {
  config: MediaConfig
  logger?: FastifyServerOptions['logger']
  /** The ffprobe and ffmpeg to run: the image's, or a test's. */
  ffprobe?: string
  ffmpeg?: string
}

export function buildMediaServer({
  config,
  logger,
  ffprobe = 'ffprobe',
  ffmpeg = 'ffmpeg',
}: MediaServerOptions): FastifyInstance {
  const app = Fastify({ logger: logger ?? loggerOptions(config) })
  const version = ffmpegVersion(ffprobe).catch(() => 'unknown')
  const probes = new Limit(PROBES_AT_ONCE)
  const extractions = new Limit(EXTRACTIONS_AT_ONCE)

  app.get('/health', async () => ({
    status: 'ok',
    release: config.release,
    ffmpeg: await version,
  }))

  app.post('/probe', async (request, reply) => {
    const body = probeBody.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'A version and a token, please.' } })
    }
    const { versionId, token } = body.data
    const url = `${config.apiUrl}/internal/media/${versionId}`
    try {
      const output = await probes.run(() => runProbe(url, token, { command: ffprobe }))
      return toMediaInfo(output)
    } catch (error) {
      if (error instanceof ProbeError && !error.sourceFailed) {
        return { ok: false, reason: error.message } satisfies ProbeResult
      }
      request.log.warn({ err: error, versionId }, 'could not read a file to examine it')
      return reply.code(502).send(SOURCE_UNAVAILABLE)
    }
  })

  // An audio file's cover, copied out as it is (§6.7): its bytes, or a 404 without one.
  app.post('/cover', async (request, reply) => {
    const body = probeBody.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'A version and a token, please.' } })
    }
    const { versionId, token } = body.data
    const url = `${config.apiUrl}/internal/media/${versionId}`
    let cover: Buffer | null
    try {
      cover = await probes.run(() => extractCover(url, token, { command: ffmpeg }))
    } catch (error) {
      if (error instanceof ProbeError && !error.sourceFailed) return reply.code(404).send(NO_COVER)
      request.log.warn({ err: error, versionId }, 'could not read a file for its cover')
      return reply.code(502).send(SOURCE_UNAVAILABLE)
    }
    if (!cover) return reply.code(404).send(NO_COVER)
    return reply.type('application/octet-stream').send(cover)
  })

  // Text subtitles inside a file, as WebVTT, all of them in one pass (§6.7).
  app.post('/subtitles', async (request, reply) => {
    const body = subtitlesBody.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'A version, a token and streams, please.' },
      })
    }
    const { versionId, token, streams } = body.data
    const url = `${config.apiUrl}/internal/media/${versionId}`
    try {
      const tracks = await extractions.run(() =>
        extractSubtitles(url, token, [...new Set(streams)], { command: ffmpeg }),
      )
      return { ok: true, tracks } satisfies SubtitlesResultOk
    } catch (error) {
      if (error instanceof ProbeError && !error.sourceFailed) {
        return { ok: false, reason: error.message } satisfies SubtitleTracksResult
      }
      request.log.warn({ err: error, versionId }, 'could not read a file for its subtitles')
      return reply.code(502).send(SOURCE_UNAVAILABLE)
    }
  })

  return app
}

type SubtitlesResultOk = Extract<SubtitleTracksResult, { ok: true }>

const NO_COVER = {
  error: { code: 'no_cover', message: 'This file has no cover that can be read.' },
}

const SOURCE_UNAVAILABLE = {
  error: {
    code: 'source_unavailable',
    message: 'The file couldn’t be read from the API. Try again later.',
  },
}

/** Runs at most `size` tasks at once; the others wait their turn. */
class Limit {
  readonly #size: number
  #running = 0
  readonly #waiting: (() => void)[] = []

  constructor(size: number) {
    this.#size = size
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#size) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve))
    }
    this.#running += 1
    try {
      return await task()
    } finally {
      this.#running -= 1
      this.#waiting.shift()?.()
    }
  }
}

function loggerOptions(config: MediaConfig): FastifyServerOptions['logger'] {
  return { level: config.logLevel }
}
