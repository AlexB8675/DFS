import { changePasswordSchema, loginSchema, sessionSchema, type Session } from '@dfs/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requireAuth } from '../auth/access.ts'
import { changePassword, signIn } from '../auth/accounts.ts'
import { clearSessionCookie, endSession, setSessionCookie, type UserRow } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { pendingPasswordChange, toUserDto } from '../users/users.ts'

/** `/api/auth/*` (DESIGN.md §7.1, §9). */
export function authRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  // Before a session there is no CSRF token, so only our own pages may call this.
  routes.post(
    '/auth/login',
    {
      config: { access: 'public' },
      schema: { body: loginSchema, response: { 200: sessionSchema } },
    },
    async (request, reply) => {
      assertOwnOrigin(app, request)
      const { user, session } = await signIn(app, request.body, request.ip)
      setSessionCookie(reply, app.config, session.token, session.expiresAt)
      return toSession(user, session.csrfToken)
    },
  )

  routes.get(
    '/auth/me',
    { config: { access: 'limited' }, schema: { response: { 200: sessionSchema } } },
    (request) => {
      const auth = requireAuth(request.auth)
      return toSession(auth.user, auth.csrfToken)
    },
  )

  routes.post(
    '/auth/password',
    {
      config: { access: 'limited' },
      schema: { body: changePasswordSchema, response: { 200: sessionSchema } },
    },
    async (request, reply) => {
      const { user, session } = await changePassword(app, requireAuth(request.auth), request.body)
      setSessionCookie(reply, app.config, session.token, session.expiresAt)
      return toSession(user, session.csrfToken)
    },
  )

  routes.post('/auth/logout', { config: { access: 'limited' } }, async (request, reply) => {
    await endSession(app.db, requireAuth(request.auth).sessionId)
    clearSessionCookie(reply, app.config)
    return reply.code(204).send()
  })

  done()
}

function toSession(user: UserRow, csrfToken: string): Session {
  return { user: toUserDto(user), csrfToken, passwordChange: pendingPasswordChange(user) }
}

/** Accepts only requests from DFS's own pages (§7.1, §7.5). */
export function assertOwnOrigin(app: FastifyInstance, request: FastifyRequest): void {
  if (request.headers.origin !== app.config.publicBaseUrl) {
    throw new ApiError(403, 'forbidden_origin', 'This request must come from DFS itself.')
  }
}
