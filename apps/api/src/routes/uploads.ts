import {
  aliveUploadsSchema,
  completeUploadSchema,
  createUploadBatchSchema,
  createUploadSchema,
  uploadBatchResultSchema,
  uploadSessionSchema,
  uploadStatusSchema,
} from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import {
  cancelUpload,
  completeUpload,
  keepUploadsAlive,
  createUpload,
  createUploads,
  receivePart,
  uploadStatus,
} from '../uploads/uploads.ts'

const byId = z.object({ id: z.uuid() })
const byPart = z.object({ id: z.uuid(), index: z.coerce.number().int().min(0) })
const noContent = { 204: z.null() }

/** Multipart uploads (DESIGN.md §6.1, §9). */
export function uploadRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  // Parts arrive as raw bytes, one chunk each: a little over CHUNK_SIZE at most.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: app.config.sizes.chunkSize + 1024 * 1024 },
    (_request, body, parsed) => {
      parsed(null, body)
    },
  )

  routes.post(
    '/uploads/batch',
    { schema: { body: createUploadBatchSchema, response: { 201: uploadBatchResultSchema } } },
    async (request, reply) => {
      const results = await createUploads(app, requireAuth(request.auth), request.body.uploads)
      return reply.code(201).send({ results })
    },
  )

  routes.post(
    '/uploads',
    { schema: { body: createUploadSchema, response: { 201: uploadSessionSchema } } },
    async (request, reply) => {
      const session = await createUpload(app, requireAuth(request.auth), request.body)
      return reply.code(201).send(session)
    },
  )

  routes.post(
    '/uploads/alive',
    { schema: { body: aliveUploadsSchema, response: noContent } },
    async (request, reply) => {
      await keepUploadsAlive(app, requireAuth(request.auth), request.body.ids)
      return reply.code(204).send(null)
    },
  )

  routes.get(
    '/uploads/:id',
    { schema: { params: byId, response: { 200: uploadStatusSchema } } },
    (request) => uploadStatus(app, requireAuth(request.auth), request.params.id),
  )

  routes.put(
    '/uploads/:id/parts/:index',
    {
      bodyLimit: app.config.sizes.chunkSize + 1024 * 1024,
      schema: { params: byPart, response: noContent },
    },
    async (request, reply) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const hash = request.headers['x-part-sha256']
      await receivePart(
        app,
        requireAuth(request.auth),
        request.params.id,
        request.params.index,
        body,
        typeof hash === 'string' ? hash : undefined,
      )
      app.metrics.record('uploads.bytes', body.length)
      return reply.code(204).send(null)
    },
  )

  routes.post(
    '/uploads/:id/complete',
    {
      // A hash per part: 12 MiB holds about 180,000 of them, a file of almost 2 TB.
      bodyLimit: 12 * 1024 * 1024,
      // Without a body, Fastify hands over `null`.
      schema: { params: byId, body: completeUploadSchema.nullish(), response: noContent },
    },
    async (request, reply) => {
      await completeUpload(
        app,
        requireAuth(request.auth),
        request.params.id,
        request.body?.partSha256,
      )
      return reply.code(204).send(null)
    },
  )

  routes.delete(
    '/uploads/:id',
    { schema: { params: byId, response: noContent } },
    async (request, reply) => {
      await cancelUpload(app, requireAuth(request.auth), request.params.id)
      return reply.code(204).send(null)
    },
  )

  done()
}
