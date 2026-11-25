import type { FastifyInstance } from 'fastify'

// CORS for `/api/v1` and nothing else (DESIGN.md §7.8): a token is sent in a
// header, never a cookie, so any origin may call, and credentials never ride.

/** `/api/v1`, or a path below it, or its query. */
export function isAppApiPath(url: string): boolean {
  return url === '/api/v1' || url.startsWith('/api/v1/') || url.startsWith('/api/v1?')
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
    if (request.method !== 'OPTIONS' || !isAppApiPath(request.url)) return
    return reply
      .code(204)
      .headers({ ...APP_CORS_HEADERS, ...APP_PREFLIGHT_HEADERS })
      .send()
  })
  app.addHook('onSend', async (request, reply) => {
    if (isAppApiPath(request.url)) reply.headers(APP_CORS_HEADERS)
  })
}
