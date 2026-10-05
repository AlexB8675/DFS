import { EVENTS_CHANNEL, type ChannelEvent } from '@dfs/db'
import type { FastifyBaseLogger } from 'fastify'
import pg from 'pg'

// Live events (DESIGN.md §6.1): one dedicated connection per API instance
// LISTENs on `dfs_events` and hands each event to that user's open streams.
// Events aren't durable: when the connection drops, every stream is closed,
// so browsers reconnect and refetch what they show.

type Listener = (event: ChannelEvent) => void

interface Subscriber {
  onEvent: Listener
  /** The hub lost events; the stream should end so the client resyncs. */
  onLost: () => void
}

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30_000

export class EventHub {
  readonly #databaseUrl: string
  readonly #log: FastifyBaseLogger
  readonly #subscribers = new Map<string, Set<Subscriber>>()
  #client: pg.Client | null = null
  #opening: pg.Client | null = null
  #connecting: Promise<void> | null = null
  #retryMs = RETRY_MIN_MS
  #timer: NodeJS.Timeout | null = null
  #stopped = false

  constructor(databaseUrl: string, log: FastifyBaseLogger) {
    this.#databaseUrl = databaseUrl
    this.#log = log
  }

  /**
   * Streams one user's events. Connects on first use, so the API starts while
   * Postgres is down; a stream opened then gets events once it is up.
   */
  subscribe(userId: string, onEvent: Listener, onLost: () => void): () => void {
    const subscriber = { onEvent, onLost }
    const set = this.#subscribers.get(userId) ?? new Set()
    set.add(subscriber)
    this.#subscribers.set(userId, set)
    void this.#connect()
    return () => {
      set.delete(subscriber)
      if (set.size === 0) this.#subscribers.delete(userId)
    }
  }

  /** Event streams open on this instance. */
  get streams(): number {
    let open = 0
    for (const set of this.#subscribers.values()) open += set.size
    return open
  }

  /** Ends every open stream, so a shutting-down server isn't held open by them. */
  endStreams(): void {
    for (const set of this.#subscribers.values()) for (const subscriber of set) subscriber.onLost()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    const client = this.#client ?? this.#opening
    this.#client = null
    this.#opening = null
    await client?.end().catch(() => undefined)
    await this.#connecting
  }

  #connect(): Promise<void> {
    if (this.#client || this.#stopped || this.#timer) return Promise.resolve()
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  async #open(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.#databaseUrl,
      application_name: 'dfs-api-events',
      keepAlive: true,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    })
    this.#opening = client
    // pg can leave connect() pending when end() interrupts authentication.
    // Ending the socket must also release the operation awaiting it.
    const closed = Promise.withResolvers<never>()
    const isOpening = () => !this.#stopped && this.#opening === client
    client.on('notification', (message) => {
      this.#dispatch(message.payload)
    })
    client.on('error', (error) => {
      closed.reject(error)
      if (client === this.#opening) this.#opening = null
      this.#dropped(client, error)
    })
    client.on('end', () => {
      closed.reject(new Error('Live-event connection ended.'))
      if (client === this.#opening) this.#opening = null
      this.#dropped(client, null)
    })
    let retry = false
    try {
      await Promise.race([client.connect(), closed.promise])
      if (!isOpening()) return
      await Promise.race([client.query(`LISTEN ${EVENTS_CHANNEL}`), closed.promise])
      if (!isOpening()) return
      this.#client = client
      this.#retryMs = RETRY_MIN_MS
    } catch (error) {
      if (!this.#stopped) {
        this.#log.warn({ err: error, retryInMs: this.#retryMs }, 'live events: cannot listen yet')
        retry = true
      }
    } finally {
      if (client === this.#opening) this.#opening = null
      if (client !== this.#client) await client.end().catch(() => undefined)
    }
    if (retry) this.#scheduleRetry()
  }

  #dispatch(payload: string | undefined): void {
    if (!payload) return
    let event: ChannelEvent
    try {
      event = JSON.parse(payload) as ChannelEvent
    } catch {
      this.#log.warn('live events: ignored a malformed notification')
      return
    }
    for (const subscriber of this.#subscribers.get(event.userId) ?? []) subscriber.onEvent(event)
  }

  #dropped(client: pg.Client, error: unknown): void {
    if (client !== this.#client || this.#stopped) return
    this.#client = null
    void client.end().catch(() => undefined)
    this.#log.warn({ err: error }, 'live events: lost the connection; streams resync')
    // Events may have been missed: end every stream, so browsers refetch on reconnect.
    this.endStreams()
    this.#scheduleRetry()
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#subscribers.size === 0 || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#connect()
    }, this.#retryMs)
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2)
  }
}
