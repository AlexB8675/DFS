import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import { ApiError } from '../errors.ts'
import { receiveStreamedPart, stagingFull, streamStart } from '../uploads/uploads.ts'

// A file streamed in one request (DESIGN.md §6.1): `PUT /uploads/:id/content`
// carries every part from `from` to the end. The API cuts the body into parts
// as it arrives and stores each as `PUT /uploads/:id/parts/:index` would,
// one part at a time while the next arrives. Whatever was stored when the
// stream breaks stays, and `GET /uploads/:id` says where to start again.

const params = z.object({ id: z.uuid() })
const query = z.object({ from: z.coerce.number().int().min(0).default(0) })

/**
 * While staging is full, a stream waits this long for room before giving up
 * with a 503 the client waits out: less than the minute Caddy lets an upload
 * stall (`read_body_idle`) before it cuts the connection.
 */
const STAGING_WAIT_MS = 45_000
const STAGING_POLL_MS = 2_000

/** Its own plugin, so its body stays a stream: the other upload routes read theirs whole. */
export function uploadStreamRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  app.addContentTypeParser('application/octet-stream', (_request, _payload, parsed) => {
    parsed(null)
  })

  app
    .withTypeProvider<ZodTypeProvider>()
    .put(
      '/uploads/:id/content',
      { schema: { params, querystring: query, response: { 204: z.null() } } },
      async (request, reply) => {
        // A refusal before reading lets Node read the body to its end and
        // discard it, so a client sending over HTTP/1.1 sees the answer
        // rather than a reset connection.
        const auth = requireAuth(request.auth)
        const uploadId = request.params.id
        const { from } = request.query
        const start = await streamStart(app, auth, uploadId, from)
        const declared = request.headers['content-length']
        if (declared !== undefined && Number(declared) !== start.bytes) {
          throw new ApiError(400, 'invalid_part', 'The stream has the wrong length.')
        }

        const body = request.raw
        const gone = new AbortController()
        body.once('close', () => {
          if (!body.complete) gone.abort()
        })
        const chunks = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>
        const read = async () => {
          try {
            return await chunks.next()
          } catch {
            throw interrupted()
          }
        }

        const partSize = (index: number) =>
          index === start.chunkCount - 1
            ? start.bytes - (index - from) * start.chunkSize
            : start.chunkSize
        let index = from
        let part = Buffer.allocUnsafe(partSize(index))
        let filled = 0
        // The part being stored while the next one arrives.
        let storing: Promise<void> | null = null
        try {
          if (!start.completed) await roomInStaging(app, gone.signal)
          for (let next = await read(); !next.done; next = await read()) {
            const data = next.value
            for (let offset = 0; offset < data.length;) {
              if (index >= start.chunkCount) {
                throw new ApiError(400, 'invalid_part', 'The stream is longer than the file.')
              }
              const taken = data.copy(part, filled, offset)
              filled += taken
              offset += taken
              if (filled < part.length) continue
              await storing
              if (!start.completed) await roomInStaging(app, gone.signal)
              storing = store(app, auth, uploadId, index, part)
              index += 1
              if (index < start.chunkCount) {
                part = Buffer.allocUnsafe(partSize(index))
                filled = 0
              }
            }
          }
          await storing
        } catch (error) {
          // Its staged file is cleaned up, or kept, before the answer.
          await storing?.catch(() => undefined)
          // The rest of the body isn't wanted: the connection goes with the answer.
          if (!body.complete) reply.header('connection', 'close')
          throw gone.signal.aborted ? interrupted() : error
        }
        if (index < start.chunkCount) {
          throw new ApiError(400, 'invalid_part', 'The stream ended before the file did.')
        }
        return reply.code(204).send(null)
      },
    )
  done()
}

/** Stores a part, counted as received; a failure surfaces when it is awaited. */
function store(
  app: FastifyInstance,
  auth: Parameters<typeof receiveStreamedPart>[1],
  uploadId: string,
  index: number,
  part: Buffer,
): Promise<void> {
  const stored = receiveStreamedPart(app, auth, uploadId, index, part).then(() => {
    app.metrics.record('uploads.bytes', part.length)
  })
  stored.catch(() => undefined)
  return stored
}

/** Holds the stream, unread, until staging has room (§6.1): the browser's sending pauses with it. */
async function roomInStaging(app: FastifyInstance, signal: AbortSignal): Promise<void> {
  const giveUpAt = Date.now() + STAGING_WAIT_MS
  while (await app.stagingLimit.isFull()) {
    if (Date.now() >= giveUpAt) throw stagingFull()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STAGING_POLL_MS)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    if (signal.aborted) throw interrupted()
  }
}

/** The browser stopped sending: paused, cancelled or cut off. Not the server's failure. */
function interrupted(): ApiError {
  return new ApiError(400, 'upload_interrupted', 'The upload stopped before the end of the file.')
}
