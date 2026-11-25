import { appMeSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requireAppToken } from '../auth/access.ts'
import { folderLocations, type NodeRow } from '../nodes/read.ts'
import { appFolder } from './folder.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** The token's folder, checked before the request's own validation; set on `access: 'app'` routes. */
    appFolder: NodeRow | null
  }
}

/**
 * An empty body is no body: an agent's `fetch` wrapper often sends
 * `Content-Type: application/json` on a DELETE with nothing in it, which
 * Fastify's own parser refuses. Anything else is Fastify's default parser,
 * with its protection against `__proto__` and `constructor`.
 */
export function useAppJsonParser(app: FastifyInstance): void {
  const parse = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (String(body).trim() === '') {
      done(null, undefined)
      return
    }
    void parse(request, body as string, done)
  })
}

/** `/api/v1` (DESIGN.md §7.8): what an app token may do, in its one folder. */
export function appApiRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  useAppJsonParser(app)

  app.decorateRequest('appFolder', null)
  // Every v1 request starts with the folder, before any body is read: the
  // access hook ran first. Routes that aren't `app` (the guide) skip it.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.access !== 'app') return
    request.appFolder = await appFolder(app.db, requireAppToken(request.appToken))
  })

  routes.get(
    '/v1/me',
    { config: { access: 'app' }, schema: { response: { 200: appMeSchema } } },
    async (request) => {
      const token = requireAppToken(request.appToken)
      const folder = request.appFolder ?? (await appFolder(app.db, token))
      const paths = await folderLocations(app.db, [folder.id])
      return {
        token: {
          name: token.tokenName,
          folder: { name: folder.name, path: paths.get(folder.id) ?? folder.name },
          canWrite: token.canWrite,
        },
        user: { displayName: token.user.displayName },
      }
    },
  )

  done()
}
