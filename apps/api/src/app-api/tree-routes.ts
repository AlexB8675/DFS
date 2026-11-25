import { appItemSchema, appMoveSchema } from '@dfs/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAppToken, requireWrite } from '../auth/access.ts'
import { bodySegments, urlSegments } from './paths.ts'
import { makeFolders, moveItem, trashItem } from './tree.ts'

/** A write route's token must be able to write: checked before the body is read. */
function needsWrite(request: FastifyRequest, _reply: FastifyReply, done: HookDone): void {
  try {
    requireWrite(requireAppToken(request.appToken))
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)))
    return
  }
  done()
}

type HookDone = (error?: Error) => void

/** `POST /v1/folders`, `POST /v1/move` and `DELETE /v1/files` (DESIGN.md §7.8). */
export function treeRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  const mkdir = async (request: FastifyRequest, reply: FastifyReply) => {
    const { item, created } = await makeFolders(
      app,
      requireAppToken(request.appToken),
      urlSegments(request.url, '/api/v1/folders'),
    )
    reply.code(created ? 201 : 200)
    return item
  }
  const folderOptions = {
    config: { access: 'app' as const },
    onRequest: needsWrite,
    schema: { response: { 200: appItemSchema, 201: appItemSchema } },
  }
  routes.post('/v1/folders', folderOptions, mkdir)
  routes.post('/v1/folders/*', folderOptions, mkdir)

  routes.post(
    '/v1/move',
    {
      config: { access: 'app' },
      onRequest: needsWrite,
      schema: { body: appMoveSchema, response: { 200: appItemSchema } },
    },
    (request) =>
      moveItem(
        app,
        requireAppToken(request.appToken),
        bodySegments(request.body.from),
        bodySegments(request.body.to),
      ),
  )

  const trash = async (request: FastifyRequest, reply: FastifyReply) => {
    await trashItem(
      app,
      requireAppToken(request.appToken),
      urlSegments(request.url, '/api/v1/files'),
    )
    return reply.code(204).send(null)
  }
  const trashOptions = {
    config: { access: 'app' as const },
    onRequest: needsWrite,
    schema: { response: { 204: z.null() } },
  }
  routes.delete('/v1/files', trashOptions, trash)
  routes.delete('/v1/files/*', trashOptions, trash)
}
