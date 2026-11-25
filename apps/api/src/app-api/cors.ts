import type { FastifyInstance, FastifyRequest } from 'fastify'

// CORS for `/api/v1` and nothing else (DESIGN.md §7.8): a token is sent in a
// header, never a cookie, so any origin may call, and credentials never ride.

/** `/api/v1`, or a path below it, or its query. */
export function isAppApiPath(url: string): boolean {
  return url === '/api/v1' || url.startsWith('/api/v1/') || url.startsWith('/api/v1?')
}

/**
 * Whether a request is a v1 request: its matched route says so (the router
 * decodes `%76%31` to `v1`, the raw URL doesn't); with no route, a 404 or a
 * preflight, the raw URL does.
 */
export function isAppApiRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url
  if (route !== undefined && !request.is404) {
    return route === '/api/v1' || route.startsWith('/api/v1/')
  }
  return isAppApiPath(request.url)
}

/** On every answer from a v1 path, errors included. */
export const APP_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers':
    'Content-Range, Content-Length, Accept-Ranges, ETag, Retry-After',
}

/** Added to a preflight's answer. */
export const APP_PREFLIGHT_HEADERS = {
  'access-control-allow-methods': 'GET, PUT, POST, DELETE',
  'access-control-allow-headers':
    'Authorization, Content-Type, Range, If-Range, If-None-Match, If-Match',
  'access-control-max-age': '600',
}

/**
 * Registers before the access hook, so a preflight, which carries no token, is
 * answered before authentication. One `onSend` covers every other answer, the
 * 404 and the errors too. Fastify's answer to a URL it can't decode runs no
 * hook: `frameworkErrors` adds these headers there.
 */
export function registerAppCors(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'OPTIONS' || !isAppApiRequest(request)) return
    return reply
      .code(204)
      .headers({ ...APP_CORS_HEADERS, ...APP_PREFLIGHT_HEADERS })
      .send()
  })
  app.addHook('onSend', async (request, reply) => {
    if (isAppApiRequest(request)) reply.headers(APP_CORS_HEADERS)
  })
}
