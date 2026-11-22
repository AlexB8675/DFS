// Why a play failed (DESIGN.md §10.4): on a read the server refused for good, or on anything else. A read
// that failed but may be tried again (a `ReadError` that is not fatal) is not the server's refusal.
// It uses no DOM type.

import { ReadError } from '../read.ts'

/** `read` for a `ReadError` that is fatal, `play` for every other failure. */
export function failedOnOf(error: unknown): 'read' | 'play' {
  return error instanceof ReadError && error.fatal ? 'read' : 'play'
}
