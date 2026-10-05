import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../auth/access.ts'

/** Clients reconnect if they hear nothing for 60 s, so ping well within that (§6.1). */
const PING_EVERY_MS = 25_000
/**
 * A client is dropped once this much is waiting for it: it has stopped
 * reading, and reconnecting refetches what it missed. Bursts, such as the
 * sync events of a big upload on a slow link, stay well below it.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024

/**
 * `GET /api/events`: the signed-in user's live events as Server-Sent Events.
 * The SSE `event` field is the type and `data` the JSON payload (§6.1).
 */
export function eventRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  app.get('/events', (request, reply) => {
    const auth = requireAuth(request.auth)
    reply.hijack()
    const stream = reply.raw
    stream.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells proxies such as Caddy and nginx not to buffer the stream.
      'x-accel-buffering': 'no',
      'x-request-id': request.id,
    })
    const send = (type: string, payload: unknown) => {
      if (stream.destroyed || stream.writableEnded) return
      stream.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
      if (stream.writableLength > MAX_BUFFERED_BYTES) stream.destroy()
    }
    stream.write('retry: 3000\n\n')

    const unsubscribe = app.events.subscribe(
      auth.user.id,
      (event) => {
        send(event.type, event.payload)
      },
      () => stream.end(),
    )
    const ping = setInterval(() => {
      send('ping', {})
    }, PING_EVERY_MS)
    stream.once('close', () => {
      clearInterval(ping)
      unsubscribe()
    })
  })

  done()
}
