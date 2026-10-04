import {
  adminUserPageSchema,
  adminUserSchema,
  createUserSchema,
  resetPasswordSchema,
  updateUserSchema,
} from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import {
  createUserAsAdmin,
  listUsers,
  resetPassword,
  updateUserAsAdmin,
} from '../users/admin-users.ts'

const byId = z.object({ id: z.uuid() })

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

  done()
}
