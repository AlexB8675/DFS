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

/** `/api/v1` (DESIGN.md §7.8): what an app token may do, in its one folder. */
export function appApiRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  // An agent's `fetch` wrapper often sends `Content-Type: application/json`
  // on a DELETE with no body, which Fastify's own parser refuses.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, next) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    if (text.trim() === '') {
      next(null, undefined)
      return
    }
    try {
      next(null, JSON.parse(text))
    } catch (error) {
      const failure = error as Error & { statusCode?: number }
      failure.statusCode = 400
      next(failure, undefined)
    }
  })

  app.decorateRequest('appFolder', null)
  // Every v1 request starts with the folder: before validation, so a token
  // whose folder is gone hears that first.
  app.addHook('preValidation', async (request) => {
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
