import { ReadError, type EngineRefusal } from '@dfs/player'
import type { RefusalReason } from '../problems'

/** Why a play failed before its first frame (§4.8, §10.4). */
export interface PlayFailure {
  message: string
  /** The engine's refusal, null for anything else. */
  reason: RefusalReason | null
  /** A read the server refused for good: the page asks /playback what happened (replaced, gone). */
  read: boolean
}

function isRefusal(error: unknown): error is EngineRefusal {
  return (
    typeof error === 'object' &&
    error !== null &&
    'refusal' in error &&
    typeof error.refusal === 'string' &&
    'reason' in error
  )
}

/** What `playStreamed` rejected with, as the page tells it. */
export function failureOf(error: unknown): PlayFailure {
  if (isRefusal(error)) return { message: error.refusal, reason: error.reason, read: false }
  if (error instanceof ReadError) return { message: error.message, reason: null, read: true }
  if (error instanceof Error) return { message: error.message, reason: null, read: false }
  return { message: String(error), reason: null, read: false }
}
