import type { FastifyInstance } from 'fastify'
import { ApiError } from '../errors.ts'
import {
  csrfMatches,
  findSession,
  sessionCookieName,
  setSessionCookie,
  touchSession,
  type Auth,
} from './sessions.ts'

// Who may call what (DESIGN.md §7.1, §7.2). Each route says its access level
// in `config.access`; one hook loads the session and enforces it, so no
// route can forget to.

/**
 * - `public`: no session (sign-in, public share links); these check `Origin` themselves.
 * - `limited`: any session, also one that must choose a password first.
 * - `user` (the default): a full session.
 * - `admin`: a full session of an admin.
 */
export type Access = 'public' | 'limited' | 'user' | 'admin'

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access
  }
  interface FastifyRequest {
    auth: Auth | null
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function registerAccess(app: FastifyInstance): void {
  app.decorateRequest('auth', null)

  app.addHook('onRequest', async (request, reply) => {
    const access = request.is404 ? 'public' : (request.routeOptions.config.access ?? 'user')
    if (access === 'public') return

    const token = request.cookies[sessionCookieName(app.config)]
    const auth = token ? await findSession(app.db, token) : null
    if (!auth || !token) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.')
    request.auth = auth

    if (auth.limited && access !== 'limited') {
      throw new ApiError(
        403,
        'password_change_required',
        'Choose a new password before you continue.',
      )
    }
    if (access === 'admin' && auth.user.role !== 'admin') {
      throw new ApiError(403, 'forbidden', 'Admins only.')
    }
    if (
      !SAFE_METHODS.has(request.method) &&
      !csrfMatches(auth, request.headers['x-csrf-token'] as string | undefined)
    ) {
      throw new ApiError(403, 'csrf_failed', 'The request is missing a valid CSRF token.')
    }

    const extended = await touchSession(app.db, auth)
    if (extended) setSessionCookie(reply, app.config, token, extended)
  })
}

/** The signed-in user's session, on a route that requires one. */
export function requireAuth(auth: Auth | null): Auth {
  if (!auth) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.')
  return auth
}
