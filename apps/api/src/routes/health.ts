import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type pg from 'pg'
import { z } from 'zod'

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['ok', 'unreachable']),
})

/** `GET /api/health`: the API is up, and whether it can reach Postgres. */
export function healthRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      config: { access: 'public' },
      schema: { response: { 200: healthSchema, 503: healthSchema } },
    },
    async (request, reply) => {
      const reachable = await canQuery(app.pool)
      if (!reachable) request.log.warn('health check: database unreachable')
      return reply.code(reachable ? 200 : 503).send({
        status: reachable ? 'ok' : 'degraded',
        database: reachable ? 'ok' : 'unreachable',
      })
    },
  )
  done()
}

async function canQuery(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
