import { appItemSchema, appListSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAppToken } from '../auth/access.ts'
import { sendFile } from '../content/send.ts'
import { ApiError } from '../errors.ts'
import { listChildRows } from '../nodes/read.ts'
import { downloadableFile } from '../routes/content.ts'
import { appFolder } from './folder.ts'
import { toAppItem } from './items.ts'
import { joinPath, resolvePath, urlSegments } from './paths.ts'
import { searchFolder } from './search.ts'

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
})
const searchQuery = listQuery.extend({ q: z.string().min(1).max(200) })

/** The v1 reads (DESIGN.md §7.8): list, stat, files and search, all inside the token's folder. */
export function readRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const config = { access: 'app' } as const

  // Every path route has its bare form too, for the token's folder itself.
  for (const url of ['/v1/list', '/v1/list/*']) {
    routes.get(
      url,
      { config, schema: { querystring: listQuery, response: { 200: appListSchema } } },
      async (request) => {
        const token = requireAppToken(request.appToken)
        const { node, path } = await resolvePath(
          app.db,
          token,
          urlSegments(request.url, '/api/v1/list'),
        )
        if (node.kind !== 'folder') {
          throw new ApiError(404, 'not_found', 'Nothing is at this path.')
        }
        const { rows, nextCursor } = await listChildRows(app.db, node.id, {
          sort: 'name',
          order: 'asc',
          completedOnly: true,
          driveOnly: true,
          cursor: request.query.cursor,
          limit: request.query.limit,
        })
        return { items: rows.map((row) => toAppItem(row, joinPath(path, row.name))), nextCursor }
      },
    )
  }

  for (const url of ['/v1/stat', '/v1/stat/*']) {
    routes.get(url, { config, schema: { response: { 200: appItemSchema } } }, async (request) => {
      const token = requireAppToken(request.appToken)
      const { node, path } = await resolvePath(
        app.db,
        token,
        urlSegments(request.url, '/api/v1/stat'),
      )
      return toAppItem(node, path)
    })
  }

  // Fastify adds the HEAD route; sendFile answers Range, If-Range and If-None-Match.
  for (const url of ['/v1/files', '/v1/files/*']) {
    routes.get(url, { config }, async (request, reply) => {
      const token = requireAppToken(request.appToken)
      const { node } = await resolvePath(app.db, token, urlSegments(request.url, '/api/v1/files'))
      if (node.kind !== 'file') {
        throw new ApiError(400, 'not_a_file', 'This path is a folder: use list for folders.')
      }
      const file = await downloadableFile(app.db, node.id)
      return sendFile(app, request, reply, file, { readerId: token.user.id })
    })
  }

  routes.get(
    '/v1/search',
    { config, schema: { querystring: searchQuery, response: { 200: appListSchema } } },
    async (request) => {
      const token = requireAppToken(request.appToken)
      const folder = request.appFolder ?? (await appFolder(app.db, token))
      const { q, cursor, limit } = request.query
      return searchFolder(app.db, folder, q, cursor, limit)
    },
  )
}
