import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import type { Config } from '@dfs/config'
import { createDatabase, createPool, type Database } from '@dfs/db'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type pg from 'pg'
import { registerAccess } from './auth/access.ts'
import { RateLimiter } from './auth/rate-limit.ts'
import { registerErrorHandling } from './errors.ts'
import { adminRoutes } from './routes/admin.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    pool: pg.Pool
    db: Database
    /** Per-instance request limits (DESIGN.md §7.5). */
    limits: { signIn: RateLimiter }
  }
}

export interface AppOptions {
  config: Config
  /** Defaults to pino at `LOG_LEVEL`, pretty-printed in development. */
  logger?: FastifyServerOptions['logger']
}

/**
 * Builds the API (DESIGN §9) without listening, so tests can drive it with
 * `app.inject()`. The database pool connects on first use, so the API starts
 * even while Postgres is down; `/api/health` says so.
 */
export async function buildApp({ config, logger }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? loggerOptions(config),
    // IDs are ours: a client can't choose what the logs call its request.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // Only Caddy may set X-Forwarded-For (§3.2).
    trustProxy: config.trustedProxyCidrs,
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  registerErrorHandling(app)

  const pool = createPool(config.databaseUrl, {
    applicationName: 'dfs-api',
    onError: (error) => {
      app.log.warn({ err: error }, 'idle database connection failed')
    },
  })
  app.decorate('config', config)
  app.decorate('pool', pool)
  app.decorate('db', createDatabase(pool))
  app.addHook('onClose', async () => {
    await pool.end()
  })
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })
  app.decorate('limits', { signIn: new RateLimiter(30, 10 * 60_000) })

  await app.register(cookie)
  registerAccess(app)

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(authRoutes, { prefix: '/api' })
  await app.register(adminRoutes, { prefix: '/api' })
  return app
}

function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
    ],
    ...(config.nodeEnv === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    }),
  }
}
