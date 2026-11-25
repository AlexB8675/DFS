import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Owner } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import {
  keepUploadsAlive,
  receiveStreamedPart,
  stagingFull,
  type StreamStart,
} from './uploads.ts'

// The loop of a streamed upload (DESIGN.md §6.1), shared by every route that
// takes a file as one request body: it cuts the body into parts as it arrives
// and stores each as `PUT /uploads/:id/parts/:index` would, one part at a
// time while the next arrives. Whatever was stored when the stream breaks
// stays. A stream reserves room in staging for every part it will send before
// it reads one (D38), and gives back what it didn't use when it stops.

/**
 * While staging is full, a stream waits this long for room before giving up
 * with a 503 the client waits out: less than the minute Caddy lets an upload
 * stall (`read_body_idle`) before it cuts the connection.
 */
const STAGING_WAIT_MS = 45_000
const STAGING_POLL_MS = 2_000
/**
 * A stream renews its reservation this often (one not renewed for 90 s stops
 * counting, D38) and tells the session it is alive, so a slow body is not
 * swept as idle (§6.1) between two parts.
 */
const RESERVATION_RENEW_MS = 30_000

/**
 * Reads the request's body, parts `from` to the end, into the upload. The
 * caller has checked who may and the body's length against `start`, and sends
 * the answer. With `completeAlone`, a single-part upload completes with its
 * part; without, the caller completes it.
 */
export async function streamBody(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  owner: Owner,
  uploadId: string,
  from: number,
  start: StreamStart,
  { completeAlone }: { completeAlone: boolean },
): Promise<void> {
  const body = request.raw
  const gone = new AbortController()
  body.once('close', () => {
    if (!body.complete) gone.abort()
  })
  // A client that left while its caller worked has closed already: no event comes.
  if ((body.destroyed || body.closed) && !body.complete) gone.abort()
  const chunks = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  const read = async () => {
    try {
      return await chunks.next()
    } catch {
      throw interrupted()
    }
  }

  const partSize = (index: number) =>
    index === start.chunkCount - 1
      ? start.bytes - (index - from) * start.chunkSize
      : start.chunkSize
  let index = from
  let part = Buffer.allocUnsafe(partSize(index))
  let filled = 0
  // The part being stored while the next one arrives.
  let storing: Promise<void> | null = null
  // Room for every part still to come, reserved before reading a byte (D38).
  const reserving = !start.completed && start.needBytes > 0
  let renewal: NodeJS.Timeout | undefined
  try {
    try {
      if (reserving) {
        await reserveRoom(app, uploadId, start.needBytes, gone.signal)
      }
      // One after the other: the reservation's renewal updates the session's
      // row, and the keep-alive skips a row that is locked.
      renewal = setInterval(() => {
        void (async () => {
          if (reserving) {
            await app.stagingRoom.renew(uploadId).catch((error: unknown) => {
              request.log.warn({ err: error, uploadId }, 'could not renew a staging reservation')
            })
          }
          await keepUploadsAlive(app, owner, [uploadId]).catch((error: unknown) => {
            request.log.warn({ err: error, uploadId }, 'could not keep an upload alive')
          })
        })()
      }, RESERVATION_RENEW_MS)
      for (let next = await read(); !next.done; next = await read()) {
        const data = next.value
        for (let offset = 0; offset < data.length;) {
          if (index >= start.chunkCount) {
            throw new ApiError(400, 'invalid_part', 'The stream is longer than the file.')
          }
          const taken = data.copy(part, filled, offset)
          filled += taken
          offset += taken
          if (filled < part.length) continue
          await storing
          storing = store(app, owner, uploadId, index, part, completeAlone)
          index += 1
          if (index < start.chunkCount) {
            part = Buffer.allocUnsafe(partSize(index))
            filled = 0
          }
        }
      }
      await storing
    } catch (error) {
      // Its staged file is cleaned up, or kept, before the answer.
      await storing?.catch(() => undefined)
      // The rest of the body isn't wanted: the connection goes with the answer.
      if (!body.complete) reply.header('connection', 'close')
      if (!gone.signal.aborted) throw error
      // No answer reaches a client that left, and Fastify logs none: say where it stopped.
      request.log.info({ uploadId, from, parts: index - from }, 'upload stream cut off')
      throw interrupted()
    }
  } finally {
    clearInterval(renewal)
    // What it didn't send goes back once it ends. A stream cut off keeps
    // it for its resume instead: its staged parts leave only once it
    // completes, so it must not lose its room to a stream that would
    // then wait on it. Unrenewed, the reservation lapses in 90 s.
    if (reserving && !gone.signal.aborted) {
      await app.stagingRoom.release(uploadId).catch((error: unknown) => {
        request.log.warn({ err: error, uploadId }, 'could not give back a staging reservation')
      })
    }
  }
  if (index < start.chunkCount) {
    throw new ApiError(400, 'invalid_part', 'The stream ended before the file did.')
  }
}

/** Stores a part, counted as received; a failure surfaces when it is awaited. */
function store(
  app: FastifyInstance,
  owner: Owner,
  uploadId: string,
  index: number,
  part: Buffer,
  completeAlone: boolean,
): Promise<void> {
  const stored = receiveStreamedPart(app, owner, uploadId, index, part, { completeAlone }).then(
    () => {
      app.metrics.record('uploads.bytes', part.length)
    },
  )
  stored.catch(() => undefined)
  return stored
}

/**
 * Holds the stream, unread, until staging has room for all it will send
 * (§6.1, D38): the browser's sending pauses with it. Each try keeps the
 * stream's turn; past `STAGING_WAIT_MS`, a 503 its client waits out.
 */
export async function reserveRoom(
  app: FastifyInstance,
  uploadId: string,
  needBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const giveUpAt = Date.now() + STAGING_WAIT_MS
  for (;;) {
    // A listener added to a signal already aborted never fires: look first.
    if (signal.aborted) throw interrupted()
    if (await app.stagingRoom.admit(uploadId, needBytes)) return
    if (Date.now() >= giveUpAt) throw stagingFull()
    // It may have left while admit() ran.
    if ((signal as { aborted: boolean }).aborted) throw interrupted()
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, STAGING_POLL_MS)
      signal.addEventListener('abort', done, { once: true })
    })
  }
}

/** The sender stopped sending: paused, cancelled or cut off. Not the server's failure. */
function interrupted(): ApiError {
  return new ApiError(400, 'upload_interrupted', 'The upload stopped before the end of the file.')
}
