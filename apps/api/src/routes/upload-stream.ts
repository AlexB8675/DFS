import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import { ApiError } from '../errors.ts'
import { streamBody } from '../uploads/stream-body.ts'
import { streamStart } from '../uploads/uploads.ts'

// A file streamed in one request (DESIGN.md §6.1): `PUT /uploads/:id/content`
// carries every part from `from` to the end. The API cuts the body into parts
// as it arrives and stores each as `PUT /uploads/:id/parts/:index` would,
// one part at a time while the next arrives (`streamBody`). Whatever was
// stored when the stream breaks stays, and `GET /uploads/:id` says where to
// start again.

const params = z.object({ id: z.uuid() })
const query = z.object({ from: z.coerce.number().int().min(0).default(0) })

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
        await streamBody(app, request, reply, auth, uploadId, from, start, {
          completeAlone: true,
        })
        return reply.code(204).send(null)
      },
    )
  done()
}
