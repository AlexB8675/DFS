import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import type { Config } from '@dfs/config'
import type { MasterKeys } from '@dfs/crypto'
import { createDatabase, createPool, type Database } from '@dfs/db'
import { LocalBlobStore, Staging, type BlobReader } from '@dfs/storage'
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type pg from 'pg'
import { registerAccess } from './auth/access.ts'
import { RateLimiter } from './auth/rate-limit.ts'
import { CdnBlobReader } from './content/cdn-reader.ts'
import { FrameCache, MemoryBudget } from './content/frame-cache.ts'
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
import { shareRoutes } from './routes/shares.ts'
import { uploadRoutes } from './routes/uploads.ts'
import { StagingLimit } from './staging.ts'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    pool: pg.Pool
    db: Database
    /** Per-instance request limits (DESIGN.md §7.5). */
    limits: { signIn: RateLimiter; shareUnlock: RateLimiter }
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
    blobStore: BlobReader
    /** Frames read back from Discord, on this instance's disk; none for the local store. */
    frameCache: FrameCache | null
    /** Memory for frames read ahead of what downloads have sent (§6.2). */
    readBudget: MemoryBudget | null
  }
}

/**
 * Frames in flight ahead of what downloads have sent, across all of them:
 * about 25 frames of 10 MiB. A download that finds no room reads one frame
 * at a time instead.
 */
const READ_AHEAD_BYTES = 256 * 1024 * 1024

export interface AppOptions {
  config: Config
  /** Defaults to pino at `LOG_LEVEL`, pretty-printed in development. */
  logger?: FastifyServerOptions['logger']
  /** Defaults to the store `BLOB_STORE` names; tests read from a fake Discord. */
  blobStore?: BlobReader
}

/**
 * Builds the API (DESIGN §9) without listening, so tests can drive it with
 * `app.inject()`. The database pool connects on first use, so the API starts
 * even while Postgres is down; `/api/health` says so.
 */
export async function buildApp({
  config,
  logger,
  blobStore,
}: AppOptions): Promise<FastifyInstance> {
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
  // Failed sign-ins per client address (§7.1), and wrong share passwords per address and link (§7.5).
  app.decorate('limits', {
    signIn: new RateLimiter(30, 10 * 60_000),
    shareUnlock: new RateLimiter(10, 10 * 60_000),
  })
  app.decorate('staging', new Staging(config.stagingDir))
  app.decorate('stagingLimit', new StagingLimit(db, config.stagingMaxBytes))
  app.decorate('keys', await loadMasterKeys(config, app.log))
  app.decorate('dataKeys', new DataKeyCache())
  app.decorate('queue', queue)
  app.decorate('events', events)
  const reader = blobStore ?? blobStoreFor(config)
  app.decorate('blobStore', reader)
  // Reading local files needs no cache of its own.
  app.decorate(
    'frameCache',
    reader instanceof LocalBlobStore
      ? null
      : new FrameCache({ dir: config.cacheDir, maxBytes: config.cacheMaxBytes, log: app.log }),
  )
  app.decorate('readBudget', new MemoryBudget(READ_AHEAD_BYTES))
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
  await app.register(shareRoutes, { prefix: '/api' })
  return app
}

/** The API only reads blobs; the bot stores them (DESIGN.md §3.1). */
function blobStoreFor(config: Config): BlobReader {
  // Chaos troubles only the bot's writes; the API reads the local store as is.
  if (config.blobStore !== 'discord') return new LocalBlobStore(config.localBlobDir)
  return new CdnBlobReader({ botUrl: config.botInternalUrl, secret: config.internalRpcSecret })
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
