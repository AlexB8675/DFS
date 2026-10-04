import { LOCK_NAMESPACE, LOCKS } from '@dfs/db'
import pg from 'pg'

// Leader election (DESIGN §11): the bot that holds a Postgres advisory lock
// leads; others wait as hot standbys, so there is one gateway connection and
// one packer at a time. The lock belongs to a connection, so it lives on a
// dedicated client, never a pooled one.

export type LeaderState = 'connecting' | 'standby' | 'leader' | 'stopped'

interface Log {
  info: (object: object, message: string) => void
  warn: (object: object, message: string) => void
  error: (object: object, message: string) => void
}

export interface LeaderElectionOptions {
  databaseUrl: string
  log: Log
  /** Starts the leader's work. If it throws, leadership is given back and retried later. */
  onLead: () => Promise<void>
  /**
   * The connection holding the lock failed, so another instance may already
   * lead. The leader's work must stop at once; the bot exits (DESIGN §11).
   */
  onLost: () => void
  /** How often a standby tries for the lock. */
  pollMs?: number
  /** How often the leader checks its connection. */
  heartbeatMs?: number
  /** Retry delays while Postgres is unreachable: doubling from `min` up to `max`. */
  backoff?: { minMs: number; maxMs: number }
}

export class LeaderElection {
  readonly #options: Required<LeaderElectionOptions>
  #state: LeaderState = 'connecting'
  #client: pg.Client | null = null
  #timer: NodeJS.Timeout | null = null
  #failures = 0
  #stopped = false

  constructor(options: LeaderElectionOptions) {
    this.#options = {
      pollMs: 2000,
      heartbeatMs: 10_000,
      backoff: { minMs: 1000, maxMs: 30_000 },
      ...options,
    }
  }

  get state(): LeaderState {
    return this.#state
  }

  start(): void {
    void this.#attempt()
  }

  /** Stops trying, and gives up the lock by closing its connection. */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#state = 'stopped'
    if (this.#timer) clearTimeout(this.#timer)
    const client = this.#client
    this.#client = null
    await client?.end().catch(() => undefined)
  }

  async #attempt(): Promise<void> {
    const { log } = this.#options
    try {
      const client = this.#client ?? (await this.#connect())
      // stop() may have run during an await.
      if (this.#isStopped()) return
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [LOCK_NAMESPACE, LOCKS.botLeader],
      )
      if (this.#isStopped()) return
      this.#failures = 0
      if (rows[0]?.locked) {
        await this.#lead(client)
      } else {
        if (this.#state !== 'standby') log.info({}, 'another bot leads; waiting as a standby')
        this.#state = 'standby'
        this.#schedule(this.#options.pollMs)
      }
    } catch (error) {
      if (this.#isStopped()) return
      this.#failures += 1
      const delay = this.#backoffDelay()
      log.warn({ err: error, retryInMs: delay }, 'database unreachable; retrying')
      await this.#dropClient()
      this.#state = 'connecting'
      this.#schedule(delay)
    }
  }

  async #lead(client: pg.Client): Promise<void> {
    const { log, onLead, heartbeatMs } = this.#options
    this.#state = 'leader'
    log.info({}, 'leading')
    try {
      await onLead()
    } catch (error) {
      // Give the lock back, so a healthy instance can take over.
      log.error({ err: error }, 'could not start leading; giving it up')
      this.#state = 'connecting'
      await this.#dropClient()
      this.#failures += 1
      this.#schedule(this.#backoffDelay())
      return
    }
    const beat = async () => {
      if (this.#client !== client || this.#stopped) return
      try {
        await client.query('SELECT 1')
        this.#timer = setTimeout(() => void beat(), heartbeatMs)
      } catch (error) {
        this.#connectionLost(client, error)
      }
    }
    this.#timer = setTimeout(() => void beat(), heartbeatMs)
  }

  async #connect(): Promise<pg.Client> {
    const client = new pg.Client({
      connectionString: this.#options.databaseUrl,
      application_name: 'dfs-bot-leader',
      connectionTimeoutMillis: 5000,
      keepAlive: true,
    })
    client.on('error', (error) => {
      this.#connectionLost(client, error)
    })
    client.on('end', () => {
      this.#connectionLost(client, null)
    })
    try {
      await client.connect()
    } catch (error) {
      await client.end().catch(() => undefined)
      throw error
    }
    this.#client = client
    return client
  }

  /** The dedicated connection failed. A standby reconnects; a leader has lost the lock. */
  #connectionLost(client: pg.Client, error: unknown): void {
    if (client !== this.#client || this.#stopped) return
    this.#client = null
    void client.end().catch(() => undefined)
    if (this.#state === 'leader') {
      this.#options.log.error({ err: error }, 'lost the leader connection; the lock may be gone')
      this.#stopped = true
      this.#state = 'stopped'
      if (this.#timer) clearTimeout(this.#timer)
      this.#options.onLost()
      return
    }
    this.#state = 'connecting'
  }

  /** A method, not the field, so TypeScript doesn't assume it unchanged across an await. */
  #isStopped(): boolean {
    return this.#stopped
  }

  async #dropClient(): Promise<void> {
    const client = this.#client
    this.#client = null
    await client?.end().catch(() => undefined)
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return
    this.#timer = setTimeout(() => void this.#attempt(), delayMs)
  }

  #backoffDelay(): number {
    const { minMs, maxMs } = this.#options.backoff
    const exponential = Math.min(maxMs, minMs * 2 ** (this.#failures - 1))
    // Up to 20% jitter, so several bots don't retry in step.
    return Math.round(exponential * (0.8 + Math.random() * 0.2))
  }
}
