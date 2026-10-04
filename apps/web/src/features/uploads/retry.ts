import { ApiError } from '@/lib/api/client'

// When and how soon a failed upload request is tried again (DESIGN.md §10.2).

/** Retries per request before the upload counts as failed (and can be resumed by hand). */
export const MAX_ATTEMPTS = 6
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

/** Statuses worth retrying: timeouts, rate limits, staging backpressure, server hiccups. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * Whether a failed request may succeed if sent again. Network errors and
 * temporary server states may; a 4xx about the request itself won't, except a
 * part that arrived corrupted (`hash_mismatch`), which is read and sent again.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return RETRYABLE_STATUSES.has(error.status) || error.code === 'hash_mismatch'
  }
  // fetch rejects with a TypeError when the network fails.
  return error instanceof TypeError
}

/**
 * How long to wait before attempt number `attempt` (1 = the first retry):
 * what the server asked for in `Retry-After`, otherwise exponential backoff
 * (1 s, 2 s, 4 s, … up to 30 s) with ±20% jitter, so many clients don't
 * retry in lockstep.
 */
export function retryDelayMs(attempt: number, error: unknown, random = Math.random): number {
  if (error instanceof ApiError && error.retryAfterMs !== null) return error.retryAfterMs
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
  return Math.round(exponential * (0.8 + random() * 0.4))
}
