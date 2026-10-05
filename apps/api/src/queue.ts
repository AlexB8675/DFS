import type { Config } from '@dfs/config'
import { BLOB_UPLOAD_QUEUE, QUEUES } from '@dfs/db'
import type { FastifyBaseLogger } from 'fastify'
import { PgBoss } from 'pg-boss'

/**
 * The API's handle on the job queue, only to add jobs inside its own
 * transactions; the bot's leader runs the queue's maintenance. Started on
 * first use, so the API starts while Postgres is down.
 */
export class JobQueue {
  readonly #config: Config
  readonly #log: FastifyBaseLogger
  #started: Promise<PgBoss> | null = null

  constructor(config: Config, log: FastifyBaseLogger) {
    this.#config = config
    this.#log = log
  }

  get(): Promise<PgBoss> {
    this.#started ??= this.#start().catch((error: unknown) => {
      this.#started = null
      throw error
    })
    return this.#started
  }

  async stop(): Promise<void> {
    const boss = await this.#started?.catch(() => null)
    await boss?.stop({ graceful: false })
  }

  async #start(): Promise<PgBoss> {
    const boss = new PgBoss({
      connectionString: this.#config.databaseUrl,
      application_name: 'dfs-api-queue',
      max: 2,
      supervise: false,
      schedule: false,
    })
    boss.on('error', (error) => {
      this.#log.error({ err: error }, 'job queue error')
    })
    try {
      await boss.start()
      await boss.createQueue(QUEUES.blobUpload, BLOB_UPLOAD_QUEUE)
      return boss
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => undefined)
      throw error
    }
  }
}
