import http from 'node:http'
import https from 'node:https'
import type { Metrics } from '@dfs/db'
import type { ServiceStatus } from '@dfs/shared'

// The API's checks (DESIGN.md §16): every 10 s it asks Discord, the internet
// and itself for an answer, so their response times are measured all the
// time rather than only while people use DFS. Each check is a request on a
// new connection: the name lookup, the connection, TLS and the answer, the
// same every time.

export type CheckTarget = 'discord' | 'internet'

/** What the API asks, with no token and nothing about DFS. */
export const CHECK_URLS: Record<CheckTarget, string> = {
  /** Where Discord's gateway is: Discord's API, answering without a token. */
  discord: 'https://discord.com/api/v10/gateway',
  /** Google's connectivity check, made for this: an empty answer, 204. */
  internet: 'https://www.gstatic.com/generate_204',
}

const INTERVAL_MS = 10_000
/** A check without an answer by then failed. */
const TIMEOUT_MS = 5_000
/** Checks kept per target for the overview: the last minute's. */
const KEPT = 6
/** Failed checks in a row that make a target down: half a minute. */
const DOWN_AFTER = 3
const USER_AGENT = 'DFS health check'

/** A target as the last minute's checks saw it. */
export interface CheckReading {
  /** No check has ended yet: the API has just started. */
  checked: boolean
  /** The last `DOWN_AFTER` checks all failed. */
  down: boolean
  /** Failed checks in the last minute. */
  failures: number
  /** The median answer time of the last minute's checks, or `null` if none answered. */
  ms: number | null
}

/**
 * A target as the overview's services show it: how quickly it answers, or
 * that it doesn't. Not checked yet isn't trouble: the API has just started.
 */
export function reach(reading: CheckReading): { status: ServiceStatus; detail: string } {
  if (!reading.checked) return { status: 'ok', detail: 'Checking…' }
  if (reading.down) return { status: 'down', detail: 'Not answering' }
  const time =
    reading.ms === null
      ? 'No answer'
      : `${reading.ms < 10 ? reading.ms.toFixed(1) : String(Math.round(reading.ms))} ms`
  if (reading.failures === 0) return { status: 'ok', detail: time }
  const checks = reading.failures === 1 ? 'check' : 'checks'
  return { status: 'degraded', detail: `${time} · ${String(reading.failures)} ${checks} failed` }
}

export interface CheckOptions {
  urls?: Record<CheckTarget, string>
  intervalMs?: number
  timeoutMs?: number
}

export class Checks {
  readonly #metrics: Pick<Metrics, 'time' | 'record'>
  readonly #urls: Record<CheckTarget, URL>
  readonly #intervalMs: number
  readonly #timeoutMs: number
  readonly #results: Record<CheckTarget, (number | null)[]> = { discord: [], internet: [] }
  #stopping = new AbortController()
  #timer: NodeJS.Timeout | null = null
  #running: Promise<void> = Promise.resolve()

  constructor(metrics: Pick<Metrics, 'time' | 'record'>, options: CheckOptions = {}) {
    const urls = options.urls ?? CHECK_URLS
    this.#metrics = metrics
    this.#urls = { discord: new URL(urls.discord), internet: new URL(urls.internet) }
    this.#intervalMs = options.intervalMs ?? INTERVAL_MS
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  }

  /**
   * Checks now, then `intervalMs` after each round ends, until stopped. The
   * API's own check asks `selfUrl` for its health: the API times that answer
   * as it times every other, but doesn't count it as a request.
   */
  start(selfUrl: string): void {
    this.#stopping = new AbortController()
    const round = () => {
      this.#running = this.check(selfUrl).finally(() => {
        if (this.#stopping.signal.aborted) return
        this.#timer = setTimeout(round, this.#intervalMs)
        this.#timer.unref()
      })
    }
    round()
  }

  /** Ends the checks, cutting short any under way; those count for nothing. */
  async stop(): Promise<void> {
    this.#stopping.abort()
    if (this.#timer) clearTimeout(this.#timer)
    await this.#running
  }

  /** One round: each target and the API itself, at once. */
  async check(selfUrl?: string): Promise<void> {
    await Promise.all([
      ...(['discord', 'internet'] as const).map(async (target) => {
        const ms = await this.#ask(this.#urls[target])
        if (this.#stopping.signal.aborted) return
        if (ms === null) this.#metrics.record(`check.${target}.failures`)
        else this.#metrics.time(`check.${target}.ms`, ms)
        const results = this.#results[target]
        results.push(ms)
        if (results.length > KEPT) results.shift()
      }),
      selfUrl === undefined ? null : this.#ask(new URL(selfUrl)),
    ])
  }

  reading(target: CheckTarget): CheckReading {
    const results = this.#results[target]
    const answered = results.filter((ms) => ms !== null).sort((a, b) => a - b)
    const last = results.slice(-DOWN_AFTER)
    return {
      checked: results.length > 0,
      down: last.length === DOWN_AFTER && last.every((ms) => ms === null),
      failures: results.length - answered.length,
      ms: answered[Math.floor(answered.length / 2)] ?? null,
    }
  }

  /**
   * How long one request takes to be answered, on a connection of its own,
   * until the last byte; `null` without an answer in time, or with a server
   * error. Any other answer, even a refusal, came back from the server.
   */
  #ask(url: URL): Promise<number | null> {
    return new Promise((resolve) => {
      const started = performance.now()
      const request = (url.protocol === 'https:' ? https : http).get(
        url,
        {
          agent: false,
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.any([this.#stopping.signal, AbortSignal.timeout(this.#timeoutMs)]),
        },
        (response) => {
          response.on('end', () => {
            resolve((response.statusCode ?? 500) < 500 ? performance.now() - started : null)
          })
          // Cut short before its end. After it, these change nothing.
          response.on('error', () => {
            resolve(null)
          })
          response.on('close', () => {
            resolve(null)
          })
          response.resume()
        },
      )
      request.on('error', () => {
        resolve(null)
      })
    })
  }
}
