import {
  adminUserPageSchema,
  adminUserSchema,
  auditPageSchema,
  createChannelSchema,
  createUserSchema,
  metricSeriesSchema,
  metricsQuerySchema,
  moderationSchema,
  nodeKindSchema,
  nodePageSchema,
  nodePathSchema,
  nodeSchema,
  resetPasswordSchema,
  sortFieldSchema,
  sortOrderSchema,
  storageChannelListSchema,
  storageChannelSchema,
  systemHealthSchema,
  updateChannelSchema,
  updateUserSchema,
  userUsageSchema,
} from '@dfs/shared'
import { readMetrics } from '@dfs/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { adminNode, anyVisibleNode, moderate, userUsage } from '../admin/browse.ts'
import {
  auditLog,
  createChannel,
  listChannels,
  setChannelEnabled,
  systemHealth,
} from '../admin/system.ts'
import { requireAuth } from '../auth/access.ts'
import { ApiError } from '../errors.ts'
import { listChildren, nodePath } from '../nodes/read.ts'
import {
  createUserAsAdmin,
  listUsers,
  resetPassword,
  updateUserAsAdmin,
} from '../users/admin-users.ts'

const byId = z.object({ id: z.uuid() })
const listQuery = z.object({
  kind: nodeKindSchema.optional(),
  sort: sortFieldSchema.default('name'),
  order: sortOrderSchema.default('asc'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
const noContent = { 204: z.null() }

/** `/api/admin/*` (DESIGN.md §9): admins only. */
export function adminRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const admin = { access: 'admin' } as const

  routes.get(
    '/admin/users',
    { config: admin, schema: { response: { 200: adminUserPageSchema } } },
    async () => ({ items: await listUsers(app), nextCursor: null }),
  )

  routes.post(
    '/admin/users',
    { config: admin, schema: { body: createUserSchema, response: { 201: adminUserSchema } } },
    async (request, reply) => {
      const user = await createUserAsAdmin(app, requireAuth(request.auth), request.body)
      return reply.code(201).send(user)
    },
  )

  routes.patch(
    '/admin/users/:id',
    {
      config: admin,
      schema: { params: byId, body: updateUserSchema, response: { 200: adminUserSchema } },
    },
    (request) => updateUserAsAdmin(app, requireAuth(request.auth), request.params.id, request.body),
  )

  routes.post(
    '/admin/users/:id/password',
    {
      config: admin,
      schema: { params: byId, body: resetPasswordSchema, response: { 200: adminUserSchema } },
    },
    (request) => resetPassword(app, requireAuth(request.auth), request.params.id, request.body),
  )

  routes.get(
    '/admin/users/:id/usage',
    { config: admin, schema: { params: byId, response: { 200: userUsageSchema } } },
    (request) => userUsage(app, requireAuth(request.auth), request.params.id),
  )

  // ── The read-only metadata browser (D4): names, sizes, dates; never content ─

  routes.get(
    '/admin/nodes/:id',
    { config: admin, schema: { params: byId, response: { 200: nodeSchema } } },
    (request) => adminNode(app, request.params.id),
  )

  routes.get(
    '/admin/nodes/:id/path',
    { config: admin, schema: { params: byId, response: { 200: nodePathSchema } } },
    async (request) => {
      await anyVisibleNode(app.db, request.params.id)
      return nodePath(app.db, request.params.id)
    },
  )

  routes.get(
    '/admin/nodes/:id/children',
    {
      config: admin,
      schema: { params: byId, querystring: listQuery, response: { 200: nodePageSchema } },
    },
    async (request) => {
      const folder = await anyVisibleNode(app.db, request.params.id)
      if (folder.kind !== 'folder')
        throw new ApiError(400, 'not_a_folder', 'The target is not a folder.')
      return listChildren(app.db, folder.id, request.query)
    },
  )

  routes.delete(
    '/admin/nodes/:id',
    { config: admin, schema: { params: byId, body: moderationSchema, response: noContent } },
    async (request, reply) => {
      await moderate(app, requireAuth(request.auth), request.params.id, request.body.reason)
      return reply.code(204).send(null)
    },
  )

  // ── The system ─────────────────────────────────────────────────────────────

  routes.get(
    '/admin/health',
    { config: admin, schema: { response: { 200: systemHealthSchema } } },
    () => systemHealth(app),
  )

  routes.get(
    '/admin/metrics',
    {
      config: admin,
      schema: { querystring: metricsQuerySchema, response: { 200: metricSeriesSchema } },
    },
    (request) => readMetrics(app.db, request.query.range, request.query.series),
  )

  routes.get(
    '/admin/channels',
    { config: admin, schema: { response: { 200: storageChannelListSchema } } },
    () => listChannels(app),
  )

  routes.post(
    '/admin/channels',
    {
      config: admin,
      schema: { body: createChannelSchema, response: { 201: storageChannelSchema } },
    },
    async (request, reply) => {
      const channel = await createChannel(app, requireAuth(request.auth), request.body)
      return reply.code(201).send(channel)
    },
  )

  routes.patch(
    '/admin/channels/:id',
    {
      config: admin,
      schema: { params: byId, body: updateChannelSchema, response: { 200: storageChannelSchema } },
    },
    (request) =>
      setChannelEnabled(app, requireAuth(request.auth), request.params.id, request.body.enabled),
  )

  routes.get(
    '/admin/audit',
    {
      config: admin,
      schema: {
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: auditPageSchema },
      },
    },
    (request) => auditLog(app, request.query.cursor, request.query.limit),
  )

  done()
}
