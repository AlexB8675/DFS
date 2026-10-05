import {
  createFolderSchema,
  ensureFoldersResultSchema,
  ensureFoldersSchema,
  lookupNodesSchema,
  moveNodesSchema,
  nodeIdsSchema,
  nodeKindSchema,
  nodeListSchema,
  nodePageSchema,
  nodePathSchema,
  nodeSchema,
  searchPageSchema,
  sortFieldSchema,
  sortOrderSchema,
  trashPageSchema,
  updateNodeSchema,
} from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import {
  listChildren,
  lookupNodes,
  nodePath,
  toDriveNode,
  visibleFolder,
  visibleNode,
} from '../nodes/read.ts'
import { searchNodes } from '../nodes/search.ts'
import { deleteForever, emptyTrash, listTrash } from '../nodes/trash.ts'
import {
  createFolder,
  ensureFolders,
  moveNodes,
  restoreNode,
  trashNodes,
  updateNode,
} from '../nodes/write.ts'

const byId = z.object({ id: z.uuid() })
const limit = (fallback: number) => z.coerce.number().int().min(1).max(500).default(fallback)
const listQuery = z.object({
  kind: nodeKindSchema.optional(),
  sort: sortFieldSchema.default('name'),
  order: sortOrderSchema.default('asc'),
  cursor: z.string().optional(),
  limit: limit(100),
})
const pageQuery = z.object({
  q: z.string().default(''),
  cursor: z.string().optional(),
  limit: limit(100),
})
const noContent = { 204: z.null() }

/** Browsing and changing the tree, the trash and search (DESIGN.md §9). */
export function nodeRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const ownerOf = (auth: Parameters<typeof requireAuth>[0]) => requireAuth(auth).user.id

  routes.get(
    '/nodes/:id',
    { schema: { params: byId, response: { 200: nodeSchema } } },
    async (request) =>
      toDriveNode(await visibleNode(app.db, ownerOf(request.auth), request.params.id)),
  )

  routes.post(
    '/nodes/lookup',
    { schema: { body: lookupNodesSchema, response: { 200: nodeListSchema } } },
    async (request) => {
      const rows = await lookupNodes(app.db, ownerOf(request.auth), request.body.ids)
      return { items: rows.map(toDriveNode) }
    },
  )

  routes.get(
    '/nodes/:id/path',
    { schema: { params: byId, response: { 200: nodePathSchema } } },
    async (request) => {
      await visibleNode(app.db, ownerOf(request.auth), request.params.id)
      return nodePath(app.db, request.params.id)
    },
  )

  routes.get(
    '/nodes/:id/children',
    { schema: { params: byId, querystring: listQuery, response: { 200: nodePageSchema } } },
    async (request) => {
      await visibleFolder(app.db, ownerOf(request.auth), request.params.id)
      return listChildren(app.db, request.params.id, request.query)
    },
  )

  routes.post(
    '/folders',
    { schema: { body: createFolderSchema, response: { 201: nodeSchema } } },
    async (request, reply) => {
      const { parentId, name } = request.body
      const folder = await createFolder(app, requireAuth(request.auth), parentId, name)
      return reply.code(201).send(folder)
    },
  )

  routes.post(
    '/folders/ensure',
    { schema: { body: ensureFoldersSchema, response: { 200: ensureFoldersResultSchema } } },
    (request) =>
      ensureFolders(app, requireAuth(request.auth), request.body.parentId, request.body.paths),
  )

  routes.patch(
    '/nodes/:id',
    { schema: { params: byId, body: updateNodeSchema, response: { 200: nodeSchema } } },
    (request) => updateNode(app, requireAuth(request.auth), request.params.id, request.body),
  )

  routes.post(
    '/nodes/move',
    { schema: { body: moveNodesSchema, response: noContent } },
    async (request, reply) => {
      await moveNodes(app, requireAuth(request.auth), request.body.ids, request.body.parentId)
      return reply.code(204).send(null)
    },
  )

  routes.post(
    '/nodes/trash',
    { schema: { body: nodeIdsSchema, response: noContent } },
    async (request, reply) => {
      await trashNodes(app, requireAuth(request.auth), request.body.ids)
      return reply.code(204).send(null)
    },
  )

  routes.delete(
    '/nodes/:id',
    { schema: { params: byId, response: noContent } },
    async (request, reply) => {
      await trashNodes(app, requireAuth(request.auth), [request.params.id])
      return reply.code(204).send(null)
    },
  )

  routes.post(
    '/nodes/:id/restore',
    { schema: { params: byId, response: { 200: nodeSchema } } },
    (request) => restoreNode(app, requireAuth(request.auth), request.params.id),
  )

  routes.get(
    '/trash',
    { schema: { querystring: pageQuery, response: { 200: trashPageSchema } } },
    (request) =>
      listTrash(app.db, requireAuth(request.auth), request.query.cursor, request.query.limit),
  )

  routes.delete(
    '/trash/:id',
    { schema: { params: byId, response: noContent } },
    async (request, reply) => {
      await deleteForever(app, requireAuth(request.auth), request.params.id)
      return reply.code(204).send(null)
    },
  )

  routes.delete('/trash', { schema: { response: noContent } }, async (request, reply) => {
    await emptyTrash(app, requireAuth(request.auth))
    return reply.code(204).send(null)
  })

  routes.get(
    '/search',
    { schema: { querystring: pageQuery, response: { 200: searchPageSchema } } },
    (request) =>
      searchNodes(
        app.db,
        requireAuth(request.auth),
        request.query.q,
        request.query.cursor,
        request.query.limit,
      ),
  )

  done()
}
