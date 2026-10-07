import {
  adminSessionListSchema,
  adminShareOwnerListSchema,
  adminSharePageSchema,
  adminShareQuerySchema,
  adminUploadListSchema,
  auditQuerySchema,
  adminTaskListSchema,
  adminTaskRequestSchema,
  adminTaskSchema,
  adminUserPageSchema,
  adminUserSchema,
  auditPageSchema,
  createChannelSchema,
  createUserSchema,
  databaseStatusSchema,
  metricSeriesSchema,
  metricsQuerySchema,
  moderationResultSchema,
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
  storageStatusSchema,
  systemInfoSchema,
  systemHealthSchema,
  updateChannelSchema,
  updateUserSchema,
  userUsageSchema,
  shareCountSchema,
} from '@dfs/shared'
import { readMetrics } from '@dfs/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { adminNode, anyVisibleNode, linksToDelete, moderate, userUsage } from '../admin/browse.ts'
import {
  cancelUploadAsAdmin,
  endSessionAsAdmin,
  listSessions,
  listShares,
  shareOwners,
  listUploads,
  deleteShareAsAdmin,
  signOutUser,
} from '../admin/access.ts'
import { databaseStatus, signalSession, vacuumTable } from '../admin/database.ts'
import { clearFrameCache, systemInfo } from '../admin/system-info.ts'
import { getTask, listTasks, startTask, storageStatus } from '../admin/storage.ts'
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

  routes.get(
    '/admin/nodes/:id/links',
    { config: admin, schema: { params: byId, response: { 200: shareCountSchema } } },
    (request) => linksToDelete(app, request.params.id),
  )

  routes.delete(
    '/admin/nodes/:id',
    {
      config: admin,
      schema: { params: byId, body: moderationSchema, response: { 200: moderationResultSchema } },
    },
    (request) => moderate(app, requireAuth(request.auth), request.params.id, request.body.reason),
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

  // ── People and access ──────────────────────────────────────────────────────

  routes.get(
    '/admin/sessions',
    {
      config: admin,
      schema: {
        querystring: z.object({ userId: z.uuid().optional() }),
        response: { 200: adminSessionListSchema },
      },
    },
    (request) => listSessions(app, requireAuth(request.auth), request.query.userId),
  )

  routes.delete(
    '/admin/sessions/:key',
    {
      config: admin,
      schema: {
        params: z.object({ key: z.string().regex(/^[0-9a-f]{16}$/) }),
        response: noContent,
      },
    },
    async (request, reply) => {
      await endSessionAsAdmin(app, requireAuth(request.auth), request.params.key)
      return reply.code(204).send(null)
    },
  )

  routes.post(
    '/admin/users/:id/sign-out',
    {
      config: admin,
      schema: { params: byId, response: { 200: z.object({ ended: z.number().int().min(0) }) } },
    },
    async (request) => ({
      ended: await signOutUser(app, requireAuth(request.auth), request.params.id),
    }),
  )

  routes.get(
    '/admin/shares',
    {
      config: admin,
      schema: { querystring: adminShareQuerySchema, response: { 200: adminSharePageSchema } },
    },
    (request) =>
      listShares(app, {
        cursor: request.query.cursor,
        limit: request.query.limit,
        active: request.query.active === 'true',
        ownerId: request.query.ownerId,
        q: request.query.q,
      }),
  )

  routes.get(
    '/admin/shares/owners',
    {
      config: admin,
      schema: {
        querystring: adminShareQuerySchema.pick({ active: true, q: true }),
        response: { 200: adminShareOwnerListSchema },
      },
    },
    (request) =>
      shareOwners(app, {
        active: request.query.active === 'true',
        q: request.query.q,
      }),
  )

  routes.delete(
    '/admin/shares/:id',
    { config: admin, schema: { params: byId, response: noContent } },
    async (request, reply) => {
      await deleteShareAsAdmin(app, requireAuth(request.auth), request.params.id)
      return reply.code(204).send(null)
    },
  )

  routes.get(
    '/admin/uploads',
    { config: admin, schema: { response: { 200: adminUploadListSchema } } },
    () => listUploads(app),
  )

  routes.delete(
    '/admin/uploads/:id',
    { config: admin, schema: { params: byId, response: noContent } },
    async (request, reply) => {
      await cancelUploadAsAdmin(app, requireAuth(request.auth), request.params.id)
      return reply.code(204).send(null)
    },
  )

  // ── Storage ────────────────────────────────────────────────────────────────

  routes.get(
    '/admin/storage',
    { config: admin, schema: { response: { 200: storageStatusSchema } } },
    () => storageStatus(app),
  )

  routes.get(
    '/admin/tasks',
    { config: admin, schema: { response: { 200: adminTaskListSchema } } },
    () => listTasks(app),
  )

  routes.post(
    '/admin/tasks',
    {
      config: admin,
      schema: { body: adminTaskRequestSchema, response: { 202: adminTaskSchema } },
    },
    async (request, reply) =>
      reply.code(202).send(await startTask(app, requireAuth(request.auth), request.body)),
  )

  routes.get(
    '/admin/tasks/:id',
    { config: admin, schema: { params: byId, response: { 200: adminTaskSchema } } },
    (request) => getTask(app, request.params.id),
  )

  routes.get(
    '/admin/database',
    { config: admin, schema: { response: { 200: databaseStatusSchema } } },
    () => databaseStatus(app),
  )

  routes.post(
    '/admin/database/tables/:name/vacuum',
    {
      config: admin,
      schema: {
        params: z.object({ name: z.string().min(1).max(130) }),
        response: noContent,
      },
    },
    async (request, reply) => {
      await vacuumTable(app, requireAuth(request.auth), request.params.name)
      return reply.code(204).send(null)
    },
  )

  // ── System ─────────────────────────────────────────────────────────────────

  routes.get(
    '/admin/system',
    { config: admin, schema: { response: { 200: systemInfoSchema } } },
    () => systemInfo(app),
  )

  routes.post(
    '/admin/system/cache/clear',
    {
      config: admin,
      schema: { response: { 200: z.object({ freedBytes: z.number().min(0) }) } },
    },
    async (request) => ({ freedBytes: await clearFrameCache(app, requireAuth(request.auth)) }),
  )

  const byPid = z.object({
    pid: z.coerce
      .number()
      .int()
      .positive()
      .max(2 ** 31 - 1),
  })
  for (const how of ['cancel', 'terminate'] as const) {
    routes.post(
      `/admin/database/sessions/:pid/${how}`,
      { config: admin, schema: { params: byPid, response: noContent } },
      async (request, reply) => {
        await signalSession(app, requireAuth(request.auth), request.params.pid, how)
        return reply.code(204).send(null)
      },
    )
  }

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
      schema: { querystring: auditQuerySchema, response: { 200: auditPageSchema } },
    },
    (request) => auditLog(app, request.query),
  )

  done()
}
