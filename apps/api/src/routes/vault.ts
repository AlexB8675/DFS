import {
  changeVaultCodeSchema,
  createVaultSchema,
  recoveryKeySchema,
  resetVaultSchema,
  unlockVaultSchema,
  vaultCreatedSchema,
  vaultStateSchema,
} from '@dfs/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import { sessionCookieName } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { changeVaultCode, replaceRecoveryKey, requestVaultReset } from '../vault/manage.ts'
import { createVault, lockVault, unlockVault, vaultState } from '../vault/vault.ts'

/** `/api/vault…` (DESIGN.md §7.7): a full session's own vault; never a device token's. */
export function vaultRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  routes.get('/vault', { schema: { response: { 200: vaultStateSchema } } }, (request) =>
    vaultState(app, requireAuth(request.auth)),
  )

  // The recovery key is shown this once: no copy for a cache to keep.
  routes.post(
    '/vault',
    { schema: { body: createVaultSchema, response: { 201: vaultCreatedSchema } } },
    async (request, reply) => {
      const auth = requireAuth(request.auth)
      const created = await createVault(app, auth, sessionToken(app, request), request.body)
      return reply.code(201).header('cache-control', 'no-store').send(created)
    },
  )

  routes.post(
    '/vault/unlock',
    { schema: { body: unlockVaultSchema, response: { 200: vaultStateSchema } } },
    (request) =>
      unlockVault(app, requireAuth(request.auth), sessionToken(app, request), request.body),
  )

  routes.put(
    '/vault/code',
    { schema: { body: changeVaultCodeSchema, response: { 200: vaultStateSchema } } },
    (request) =>
      changeVaultCode(app, requireAuth(request.auth), sessionToken(app, request), request.body),
  )

  // Shown this once, like the first: no copy for a cache to keep.
  routes.post(
    '/vault/recovery-key',
    { schema: { response: { 200: recoveryKeySchema } } },
    async (request, reply) => {
      const created = await replaceRecoveryKey(
        app,
        requireAuth(request.auth),
        sessionToken(app, request),
      )
      return reply.header('cache-control', 'no-store').send(created)
    },
  )

  routes.post(
    '/vault/reset',
    { schema: { body: resetVaultSchema, response: { 200: vaultStateSchema } } },
    (request) => requestVaultReset(app, requireAuth(request.auth), request.body),
  )

  routes.post(
    '/vault/lock',
    { schema: { response: { 204: z.null() } } },
    async (request, reply) => {
      await lockVault(app, requireAuth(request.auth))
      return reply.code(204).send(null)
    },
  )

  done()
}

/** The session cookie's token, which the access hook already checked: the vault's session seal is made from it (§7.7). */
function sessionToken(app: FastifyInstance, request: FastifyRequest): string {
  const token = request.cookies[sessionCookieName(app.config)]
  if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.')
  return token
}
