import { releaseSchema } from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type pg from 'pg'
import { z } from 'zod'

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['ok', 'unreachable']),
})

/**
 * `GET /api/health`: the API is up, and whether it can reach Postgres. Asked
 * every few seconds, by the container and by the API itself (§16), so only
 * trouble is logged.
 */
export function healthRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      config: { access: 'public' },
      logLevel: 'warn',
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
  /** `GET /api/version`: what is deployed, for pages to tell they run an older app. */
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      '/version',
      { config: { access: 'public' }, schema: { response: { 200: releaseSchema } } },
      () => app.config.release,
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
