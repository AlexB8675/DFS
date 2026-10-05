import { createHash, timingSafeEqual } from 'node:crypto'
import type { Config } from '@dfs/config'
import { createDatabase, createPool, Metrics, recordProcess } from '@dfs/db'
import { refreshUrlsSchema } from '@dfs/shared'
import { adoptChannel, BlobStoreError, ChannelRefusedError, discordProblem } from '@dfs/storage'
import { z } from 'zod'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { PgBoss } from 'pg-boss'
import { startLeaderWork, type LeaderWork } from './leader-work.ts'
import { LeaderElection } from './leader.ts'
import { botStorage, refreshBlobUrls, refreshedUrls, type BotStorage } from './storage.ts'

// The bot (DESIGN §11): job workers on pg-boss, and later the Discord gateway
// and the packer. Only the leader runs them. Its internal HTTP server answers
// the API on the internal network only, behind a shared secret (§7.5): its
// health, and signed CDN URLs for reading blobs back (§6.2), which any
// instance can give.

export interface Bot {
  server: FastifyInstance
  election: LeaderElection
  /** `null` until this instance leads. */
  queue: () => PgBoss | null
  stop: () => Promise<void>
}

export interface BotOptions {
  config: Config
  logger?: FastifyServerOptions['logger']
  /** Called if leadership is lost; `main.ts` exits so a restart starts clean. */
  onLeadershipLost: () => void
  /** Overrides for tests. */
  election?: { pollMs?: number; heartbeatMs?: number; backoff?: { minMs: number; maxMs: number } }
  storage?: BotStorage
}

export function createBot({
  config,
  logger,
  onLeadershipLost,
  election: electionOptions,
  storage: givenStorage,
}: BotOptions): Bot {
  const server = Fastify({ logger: logger ?? loggerOptions(config) })
  const pool = createPool(config.databaseUrl, {
    applicationName: 'dfs-bot',
    onError: (error) => {
      server.log.warn({ err: error }, 'idle database connection failed')
    },
  })
  const db = createDatabase(pool)
  // Every instance records what it does; the leader also samples the system (DESIGN.md §16).
  const metrics = new Metrics()
  const stopWatchingProcess = recordProcess(metrics, 'bot')
  const savingMetrics = metrics.start(db, server.log)
  const storage = givenStorage ?? botStorage(config, db, server.log, metrics)
  const { store } = storage
  let boss: PgBoss | null = null
  let work: LeaderWork | null = null
  let stopped = false

  const election = new LeaderElection({
    databaseUrl: config.databaseUrl,
    log: server.log,
    ...electionOptions,
    onLead: async () => {
      const queue = new PgBoss({
        connectionString: config.databaseUrl,
        application_name: 'dfs-bot-queue',
        // Wakes workers on queues with `notify` as soon as a job arrives.
        useListenNotify: true,
      })
      queue.on('error', (error) => {
        server.log.error({ err: error }, 'job queue error')
      })
      let leadingWork: LeaderWork | null = null
      try {
        // Creates or upgrades pg-boss's own schema on first start.
        await queue.start()
        if (!stopped)
          leadingWork = await startLeaderWork({
            config,
            db,
            boss: queue,
            storage,
            metrics,
            log: server.log,
          })
        if (stopped) {
          await leadingWork?.stop()
          await queue.stop({ graceful: false })
          return
        }
      } catch (error) {
        await leadingWork?.stop().catch(() => undefined)
        await queue.stop({ graceful: false }).catch(() => undefined)
        throw error
      }
      work = leadingWork
      boss = queue
      server.log.info('job queue started')
    },
    onLost: () => {
      stopped = true
      void work?.stop()
      void boss?.stop({ graceful: false }).catch(() => undefined)
      work = null
      boss = null
      onLeadershipLost()
    },
  })

  const expected = digest(`Bearer ${config.internalRpcSecret}`)
  server.addHook('onRequest', (request, reply, done) => {
    const given = digest(request.headers.authorization ?? '')
    if (!timingSafeEqual(given, expected)) {
      void reply.code(401).send({ error: { code: 'unauthorized', message: 'Unknown caller.' } })
      return
    }
    done()
  })

  server.get('/internal/health', () => ({
    role: election.state,
    queue: boss ? 'running' : 'stopped',
  }))

  // Admin → Channels (DESIGN.md §4, D25): a channel registered by hand must
  // be in this environment's category; it is made private to the bot.
  server.post('/internal/channels/adopt', async (request, reply) => {
    const input = z
      .object({ discordChannelId: z.string().regex(/^\d{17,20}$/) })
      .safeParse(request.body)
    if (!input.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'Expected a Discord channel ID.' } })
    }
    const { guildId, categoryName } = config.discord
    if (!storage.discord || !guildId) {
      return reply
        .code(409)
        .send({ error: { code: 'not_discord', message: 'This bot doesn’t store in Discord.' } })
    }
    try {
      return await adoptChannel(storage.discord, guildId, categoryName, input.data.discordChannelId)
    } catch (error) {
      if (error instanceof ChannelRefusedError) {
        return reply.code(422).send({ error: { code: 'channel_refused', message: error.message } })
      }
      const problem = discordProblem(error)
      if (!problem) throw error
      return reply.code(503).send({ error: { code: 'discord_unavailable', message: problem } })
    }
  })

  server.post('/internal/urls/refresh', async (request, reply) => {
    const input = refreshUrlsSchema.safeParse(request.body)
    if (!input.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'Expected 1 to 200 blob IDs.' } })
    }
    try {
      const signed = await refreshBlobUrls(db, store, input.data.blobIds)
      if (signed.size > 0) metrics.record('discord.signed', signed.size)
      return refreshedUrls(signed)
    } catch (error) {
      if (!(error instanceof BlobStoreError)) throw error
      request.log.warn({ err: error }, 'signing CDN URLs failed')
      return reply
        .code(503)
        .send({ error: { code: 'discord_unavailable', message: error.message } })
    }
  })

  election.start()

  return {
    server,
    election,
    queue: () => boss,
    stop: async () => {
      stopped = true
      await work?.stop()
      await boss?.stop({ graceful: true, timeout: 10_000 })
      work = null
      boss = null
      await election.stop()
      await server.close()
      await savingMetrics.stop()
      stopWatchingProcess()
      await pool.end()
    },
  }
}

/** Compares secrets of any length in constant time. */
function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: ['req.headers.authorization'],
    ...(config.nodeEnv === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    }),
  }
}
