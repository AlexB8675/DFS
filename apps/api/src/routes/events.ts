import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../auth/access.ts'

/** Clients reconnect if they hear nothing for 60 s, so ping well within that (§6.1). */
const PING_EVERY_MS = 25_000

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
      // Events can be recovered by refetching on reconnect. Bound memory for
      // a stalled client by closing its stream as soon as its buffer fills.
      if (!stream.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)) stream.destroy()
    }
    if (!stream.write('retry: 3000\n\n')) {
      stream.destroy()
      return
    }

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
