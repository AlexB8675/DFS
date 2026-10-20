import { appendTimelineBatch } from '@dfs/db'

// Writing to the timeline store (DESIGN.md §16), for the route that takes a
// page's batches and for the stream sessions.

/**
 * A batch the timeline store could not take, in a few words that are safe to
 * log: the database's code and message, and nothing of the batch.
 */
export class TimelineStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimelineStoreError'
  }
}

/**
 * `appendTimelineBatch`, whose failure is a `TimelineStoreError`. A timeline's
 * events never reach the general log (§16), and a failed statement carries
 * them: drizzle's error repeats the statement's parameters in its message and
 * in `params`, and the database's error, its `cause`, can repeat the row in its
 * `detail`. The API logs errors whole, so a disk that fills or a statement that
 * times out would write the events there. The error thrown instead keeps the
 * database's code and message, and neither a `cause`, nor `params`, nor a
 * `detail`.
 */
export async function appendTimelineBatchQuietly(
  ...args: Parameters<typeof appendTimelineBatch>
): ReturnType<typeof appendTimelineBatch> {
  try {
    return await appendTimelineBatch(...args)
  } catch (error) {
    throw new TimelineStoreError(`Could not store a timeline batch: ${describe(error)}`)
  }
}

/** The database's code and message, from the `cause` of the error drizzle wraps it in; else the error's name. */
function describe(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    'message' in cause &&
    typeof cause.message === 'string'
  ) {
    return `${cause.code} ${cause.message}`
  }
  return error instanceof Error ? error.name : 'Error'
}
