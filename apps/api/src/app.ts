import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import type { Config } from '@dfs/config'
import type { MasterKeys } from '@dfs/crypto'
import { createDatabase, createPool, Metrics, recordProcess, type Database } from '@dfs/db'
import { LocalBlobStore, Staging, type BlobReader } from '@dfs/storage'
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type pg from 'pg'
import { registerAccess } from './auth/access.ts'
import { RateLimiter } from './auth/rate-limit.ts'
import { Checks } from './checks.ts'
import { JournalFlusher } from './journal.ts'
import { CdnBlobReader } from './content/cdn-reader.ts'
import { Deliveries } from './content/deliveries.ts'
import { FrameCache, MemoryBudget } from './content/frame-cache.ts'
import { registerErrorHandling } from './errors.ts'
import { EventHub } from './events/hub.ts'
import { DataKeyCache, loadMasterKeys } from './keys.ts'
import { MediaClient } from './media/client.ts'
import { MediaExaminer } from './media/examine.ts'
import { hideStreamToken } from './media/stream-links.ts'
import { JobQueue } from './queue.ts'
import { adminRoutes } from './routes/admin.ts'
import { authRoutes } from './routes/auth.ts'
import { contentRoutes } from './routes/content.ts'
import { eventRoutes } from './routes/events.ts'
import { healthRoutes } from './routes/health.ts'
import { internalMediaRoutes, mediaRoutes } from './routes/media.ts'
import { nodeRoutes } from './routes/nodes.ts'
import { shareRoutes } from './routes/shares.ts'
import { uploadStreamRoutes } from './routes/upload-stream.ts'
import { uploadRoutes } from './routes/uploads.ts'
import { StagingLimit } from './staging.ts'
import { UnderWay } from './under-way.ts'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    pool: pg.Pool
    db: Database
    /** Per-instance request limits (DESIGN.md §7.5). */
    limits: {
      signIn: RateLimiter
      shareUnlock: RateLimiter
      passwordResets: RateLimiter
      connectionTests: RateLimiter
      linkPlayReports: RateLimiter
      streamLinks: RateLimiter
    }
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
    /** What this instance does, for the admin's graphs (§16). */
    metrics: Metrics
    /** How Discord and the internet answer; `main.ts` starts them once listening (§16). */
    checks: Checks
    /** Seals the journal into batches for Discord (§8); `main.ts` starts it. */
    journalFlusher: JournalFlusher
    /** Examines audio and video through the media service (§6.7); `null` without one. */
    media: MediaExaminer | null
    /** Files and ZIPs being sent, for the graphs (§16). */
    downloads: UnderWay
    /** How fast each user's reads of each version go, for their players (§10.4). */
    deliveries: Deliveries
  }
}

/**
 * Frames in flight ahead of what downloads have sent, across all of them:
 * about 12 frames of 20 MiB. A download that finds no room reads one frame
 * at a time instead.
 */
const READ_AHEAD_BYTES = 256 * 1024 * 1024

/**
 * Routes that stay open or take as long as the bytes they move: counted, but
 * not timed, so response times say how quick the API answers.
 */
const UNTIMED_ROUTES = new Set([
  '/api/events',
  '/api/files/:id/content',
  '/api/folders/:id/archive',
  '/api/archive/:token',
  '/api/uploads/:id/parts/:index',
  '/api/uploads/:id/content',
  '/api/s/:token/files/:id/content',
  '/api/s/:token/archive',
  '/internal/media/:versionId',
  // Quick once a file is examined; the first ask waits for ffprobe.
  '/api/files/:id/media',
  '/api/s/:token/files/:id/media',
  // As long as the device's connection takes.
  '/api/connection-test',
  '/api/s/:token/connection-test',
  // A cover is copied out of the file by the media service, which reads it.
  '/api/files/:id/media/:versionId/cover',
  '/api/s/:token/files/:id/media/:versionId/cover',
  // Subtitles inside a file may be extracted on the first ask, reading it whole.
  '/api/files/:id/media/:versionId/subtitles/:track',
  '/api/s/:token/files/:id/media/:versionId/subtitles/:track',
])

export interface AppOptions {
  config: Config
  /** Defaults to pino at `LOG_LEVEL`, pretty-printed in development. */
  logger?: FastifyServerOptions['logger']
  /** Defaults to the store `BLOB_STORE` names; tests read from a fake Discord. */
  blobStore?: BlobReader
  /** The media service's HTTP, which tests stand in for; defaults to `fetch`. */
  mediaFetch?: typeof fetch
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
  mediaFetch,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? loggerOptions(config),
    // IDs are ours: a client can't choose what the logs call its request.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // Only Caddy may set X-Forwarded-For (§3.2).
    trustProxy: config.trustedProxyCidrs,
    // A stream link's token is about 170 characters (§6.7); past the default 100, a 414.
    routerOptions: { maxParamLength: 300 },
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
  const metrics = new Metrics()
  const stopWatchingProcess = recordProcess(metrics, 'api')
  metrics.gauge('events.streams', () => events.streams)
  app.decorate('metrics', metrics)
  app.decorate('config', config)
  app.decorate('pool', pool)
  app.decorate('db', db)
  // Failed sign-ins and requests for a new password per client address
  // (§7.1), and wrong share passwords per address and link (§7.5).
  app.decorate('limits', {
    signIn: new RateLimiter(30, 10 * 60_000),
    shareUnlock: new RateLimiter(10, 10 * 60_000),
    passwordResets: new RateLimiter(5, 15 * 60_000),
    // Connection tests per user or address (§10.4): each is up to 32 MiB of the VPS's bandwidth.
    connectionTests: new RateLimiter(10, 10 * 60_000),
    // Play reports through share links per address (§10.4): logged, and on the graphs.
    linkPlayReports: new RateLimiter(60, 10 * 60_000),
    // Stream links made per user or, through share links, per address (§6.7).
    streamLinks: new RateLimiter(30, 10 * 60_000),
  })
  app.decorate('staging', new Staging(config.stagingDir))
  app.decorate('stagingLimit', new StagingLimit(db, config.stagingMaxBytes))
  app.decorate('keys', await loadMasterKeys(config, app.log))
  app.decorate('dataKeys', new DataKeyCache())
  app.decorate('queue', queue)
  app.decorate('events', events)
  const reader = blobStore ?? blobStoreFor(config, metrics)
  app.decorate('blobStore', reader)
  // Reading local files needs no cache of its own.
  const frameCache =
    reader instanceof LocalBlobStore
      ? null
      : new FrameCache({
          dir: config.cacheDir,
          maxBytes: config.cacheMaxBytes,
          log: app.log,
          metrics,
        })
  app.decorate('frameCache', frameCache)
  if (frameCache) metrics.gauge('cache.bytes', () => frameCache.bytes)
  if (reader instanceof CdnBlobReader)
    metrics.gauge('cdn.in_flight', () => reader.underWay.sample())
  const downloads = new UnderWay()
  app.decorate('downloads', downloads)
  app.decorate('deliveries', new Deliveries())
  metrics.gauge('downloads.active', () => downloads.sample())
  app.decorate('readBudget', new MemoryBudget(READ_AHEAD_BYTES))
  app.decorate(
    'media',
    config.mediaInternalUrl
      ? new MediaExaminer({
          client: new MediaClient(config.mediaInternalUrl, mediaFetch, metrics),
          db,
          keys: app.keys,
          log: app.log,
        })
      : null,
  )
  const checks = new Checks(metrics)
  app.decorate('checks', checks)
  const journalFlusher = new JournalFlusher(app)
  app.decorate('journalFlusher', journalFlusher)
  const savingMetrics = metrics.start(db, app.log)
  // Open event streams would keep the server from closing; a check of
  // itself would find it closing.
  app.addHook('preClose', async () => {
    events.endStreams()
    await checks.stop()
    await journalFlusher.stop()
  })
  app.addHook('onClose', async () => {
    await events.stop()
    await queue.stop()
    await savingMetrics.stop()
    stopWatchingProcess()
    await pool.end()
  })
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
    // Every answer says what is deployed, so a page running an older app
    // knows at its next request (apps/web/src/lib/version-check.ts).
    reply.header('x-dfs-version', app.config.release.version)
  })
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url
    // Health checks, the container's and the API's own, aren't counted: they
    // would drown out what people do. They are timed, so there is always an
    // answer to time (§16).
    if (route !== '/api/health') {
      metrics.record('http.requests')
      if (reply.statusCode >= 500) metrics.record('http.server_errors')
      else if (reply.statusCode >= 400) metrics.record('http.client_errors')
    }
    if (!UNTIMED_ROUTES.has(route ?? '')) metrics.time('http.ms', reply.elapsedTime)
    done()
  })

  await app.register(cookie)
  registerAccess(app)

  await app.register(healthRoutes, { prefix: '/api' })
  await app.register(authRoutes, { prefix: '/api' })
  await app.register(adminRoutes, { prefix: '/api' })
  await app.register(nodeRoutes, { prefix: '/api' })
  await app.register(uploadRoutes, { prefix: '/api' })
  await app.register(uploadStreamRoutes, { prefix: '/api' })
  await app.register(eventRoutes, { prefix: '/api' })
  await app.register(contentRoutes, { prefix: '/api' })
  await app.register(shareRoutes, { prefix: '/api' })
  await app.register(mediaRoutes, { prefix: '/api' })
  // Outside /api: the media service's alone, which the edge never forwards.
  await app.register(internalMediaRoutes)
  return app
}

/** The API only reads blobs; the bot stores them (DESIGN.md §3.1). */
function blobStoreFor(config: Config, metrics: Metrics): BlobReader {
  // Chaos troubles only the bot's writes; the API reads the local store as is.
  if (config.blobStore !== 'discord') return new LocalBlobStore(config.localBlobDir)
  return new CdnBlobReader({
    botUrl: config.botInternalUrl,
    secret: config.internalRpcSecret,
    metrics,
  })
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
    serializers: {
      // As Fastify's own, but a stream link's token, which lets anyone play its file, stays out (§6.7).
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: hideStreamToken(request.url),
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket.remotePort,
      }),
    },
    ...(config.nodeEnv === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    }),
  }
}
