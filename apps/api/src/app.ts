import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import type { Config } from '@dfs/config'
import type { MasterKeys } from '@dfs/crypto'
import { createDatabase, createPool, type Database } from '@dfs/db'
import { BlobStoreError, LocalBlobStore, Staging, type BlobStore } from '@dfs/storage'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type pg from 'pg'
import { registerAccess } from './auth/access.ts'
import { RateLimiter } from './auth/rate-limit.ts'
import { registerErrorHandling } from './errors.ts'
import { EventHub } from './events/hub.ts'
import { DataKeyCache, loadMasterKeys } from './keys.ts'
import { JobQueue } from './queue.ts'
import { adminRoutes } from './routes/admin.ts'
import { authRoutes } from './routes/auth.ts'
import { contentRoutes } from './routes/content.ts'
import { eventRoutes } from './routes/events.ts'
import { healthRoutes } from './routes/health.ts'
import { nodeRoutes } from './routes/nodes.ts'
import { uploadRoutes } from './routes/uploads.ts'
import { StagingLimit } from './staging.ts'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    pool: pg.Pool
    db: Database
    /** Per-instance request limits (DESIGN.md §7.5). */
    limits: { signIn: RateLimiter }
    /** Frames received but not yet stored (§6.1), and whether there is room for more. */
    staging: Staging
    stagingLimit: StagingLimit
    /** The master keys, and data keys unwrapped with them lately (§7.3). */
    keys: MasterKeys
    dataKeys: DataKeyCache
    /** For adding jobs inside the API's transactions (§11). */
    queue: JobQueue
    /** Live events for the users with open streams on this instance (§6.1). */
    events: EventHub
    /** Where stored blobs are read from (§6.2). */
    blobStore: BlobStore
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
  const db = createDatabase(pool)
  const queue = new JobQueue(config, app.log)
  const events = new EventHub(config.databaseUrl, app.log)
  app.decorate('config', config)
  app.decorate('pool', pool)
  app.decorate('db', db)
  // Failed sign-ins per client address (§7.1).
  app.decorate('limits', { signIn: new RateLimiter(30, 10 * 60_000) })
  app.decorate('staging', new Staging(config.stagingDir))
  app.decorate('stagingLimit', new StagingLimit(db, config.stagingMaxBytes))
  app.decorate('keys', await loadMasterKeys(config, app.log))
  app.decorate('dataKeys', new DataKeyCache())
  app.decorate('queue', queue)
  app.decorate('events', events)
  app.decorate('blobStore', blobStoreFor(config))
  // Open event streams would keep the server from closing.
  app.addHook('preClose', (done) => {
    events.endStreams()
    done()
  })
  app.addHook('onClose', async () => {
    await events.stop()
    await queue.stop()
    await pool.end()
  })
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  await app.register(cookie)
  registerAccess(app)

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(authRoutes, { prefix: '/api' })
  await app.register(adminRoutes, { prefix: '/api' })
  await app.register(nodeRoutes, { prefix: '/api' })
  await app.register(uploadRoutes, { prefix: '/api' })
  await app.register(eventRoutes, { prefix: '/api' })
  await app.register(contentRoutes, { prefix: '/api' })
  return app
}

/** The local store in development; reading from Discord arrives with M1. */
function blobStoreFor(config: Config): BlobStore {
  if (config.blobStore === 'local') return new LocalBlobStore(config.localBlobDir)
  const unavailable = () =>
    Promise.reject(
      new BlobStoreError('Reading from Discord arrives with M1.', { retryable: false }),
    )
  return { put: unavailable, read: unavailable, delete: unavailable }
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
