import type { FastifyInstance, FastifyRequest } from 'fastify'
import { auditAlone } from '../audit.ts'
import {
  DEVICE_TOKEN_PATTERN,
  findDevice,
  tooManyDeviceTries,
  touchDevice,
  type DeviceAuth,
} from '../devices/devices.ts'
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
 * - `device`: a device token (§7.6), and nothing else: no cookie, no CSRF token.
 */
export type Access = 'public' | 'limited' | 'user' | 'admin' | 'device'

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access
  }
  interface FastifyRequest {
    auth: Auth | null
    device: DeviceAuth | null
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function registerAccess(app: FastifyInstance): void {
  app.decorateRequest('auth', null)
  app.decorateRequest('device', null)

  app.addHook('onRequest', async (request, reply) => {
    const access = request.is404 ? 'public' : (request.routeOptions.config.access ?? 'user')
    if (access === 'public') return
    // A device token and a session never stand in for each other: this reads
    // the header and never the cookie, and the routes below never the header.
    if (access === 'device') {
      request.device = await authenticateDevice(app, request)
      return
    }

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

/** The device token's device, on a route that requires one. */
export function requireDevice(device: DeviceAuth | null): DeviceAuth {
  if (!device) throw new ApiError(401, 'unauthenticated', 'This needs a device token.')
  return device
}

/**
 * Who a `Bearer` token signs in (§7.6). Every failure after the header is
 * well-formed counts against the address, as a wrong password does (§7.1), so
 * a token can't be guessed; a missing header costs nothing, as a visitor
 * without one is no guesser.
 */
async function authenticateDevice(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<DeviceAuth> {
  const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
  if (!token) throw new ApiError(401, 'unauthenticated', 'This needs a device token.')

  const wait = app.limits.deviceTokens.waitMs(request.ip)
  if (wait > 0) throw tooManyDeviceTries(wait)

  const device = await findDevice(app.db, token)
  if (!device) {
    app.limits.deviceTokens.hit(request.ip)
    if (!DEVICE_TOKEN_PATTERN.test(token)) {
      throw new ApiError(401, 'unauthenticated', 'This needs a device token.')
    }
    await auditAlone(app.db, {
      actorId: null,
      action: 'auth.device_failed',
      target: 'a device token',
      details: request.ip,
    })
    throw new ApiError(401, 'invalid_token', 'This device’s token isn’t valid. Pair it again.')
  }
  await touchDevice(app.db, device, {
    ip: request.ip,
    agent: request.headers['user-agent'] ?? null,
  })
  return device
}
