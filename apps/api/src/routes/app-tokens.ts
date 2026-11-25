import { appTokenListSchema, madeAppTokenSchema, makeAppTokenSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { listAppTokens, makeAppToken, removeAppToken } from '../app-tokens/tokens.ts'
import { requireAuth } from '../auth/access.ts'

const byId = z.object({ id: z.uuid() })

/** `/api/app-tokens` (DESIGN.md §7.8): the signed-in user's tokens for scripts and agents. */
export function appTokensRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  routes.post(
    '/app-tokens',
    { schema: { body: makeAppTokenSchema, response: { 201: madeAppTokenSchema } } },
    async (request, reply) => {
      const made = await makeAppToken(app, requireAuth(request.auth), request.body)
      // The only time the token is shown: no copy for a cache to keep.
      return reply.code(201).header('cache-control', 'no-store').send(made)
    },
  )

  routes.get('/app-tokens', { schema: { response: { 200: appTokenListSchema } } }, (request) =>
    listAppTokens(app, requireAuth(request.auth)),
  )

  routes.delete(
    '/app-tokens/:id',
    { schema: { params: byId, response: { 204: z.null() } } },
    async (request, reply) => {
      await removeAppToken(app, requireAuth(request.auth), request.params.id)
      return reply.code(204).send(null)
    },
  )

  done()
}
