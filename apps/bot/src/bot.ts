import { createHash, timingSafeEqual } from 'node:crypto'
import type { Config } from '@dfs/config'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { PgBoss } from 'pg-boss'
import { LeaderElection } from './leader.ts'

// The bot (DESIGN §11): job workers on pg-boss, and later the Discord gateway
// and the packer. Only the leader runs them. Its internal HTTP server answers
// the API on the internal network only, behind a shared secret (§7.5).

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
}

export function createBot({
  config,
  logger,
  onLeadershipLost,
  election: electionOptions,
}: BotOptions): Bot {
  const server = Fastify({ logger: logger ?? loggerOptions(config) })
  let boss: PgBoss | null = null

  const election = new LeaderElection({
    databaseUrl: config.databaseUrl,
    log: server.log,
    ...electionOptions,
    onLead: async () => {
      const queue = new PgBoss({
        connectionString: config.databaseUrl,
        application_name: 'dfs-bot-queue',
      })
      queue.on('error', (error) => {
        server.log.error({ err: error }, 'job queue error')
      })
      // Creates or upgrades pg-boss's own schema on first start.
      await queue.start()
      boss = queue
      server.log.info('job queue started')
    },
    onLost: () => {
      void boss?.stop({ graceful: false }).catch(() => undefined)
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

  election.start()

  return {
    server,
    election,
    queue: () => boss,
    stop: async () => {
      await boss?.stop({ graceful: true, timeout: 10_000 })
      boss = null
      await election.stop()
      await server.close()
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
