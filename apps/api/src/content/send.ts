import { Readable, type Writable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { readVersion, type ReadableVersion } from './reader.ts'
import { writeZip, zipLength, zipTimeZone, type ZipEntry } from './zip.ts'

// Sending files and archives (DESIGN.md §6.2, §7.5): streamed, Range-aware,
// always as attachments with `nosniff`, so nothing uploaded runs in the page.

export interface DownloadableFile extends ReadableVersion {
  name: string
  mime_type: string | null
}

/**
 * Sends a file, or the byte range asked for with `206 Partial Content`; a
 * browser that has this version gets `304 Not Modified` and no bytes.
 */
export function sendFile(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  file: DownloadableFile,
): FastifyReply {
  void reply.header('etag', `"${file.version_id}"`).header('cache-control', 'private, no-cache')
  // Before the range: a browser that has the version needs none of it.
  if (notModified(request, file)) return reply.code(304).send()

  const size = file.size_bytes
  const range = requestedRange(request, file)
  void reply
    .header('accept-ranges', 'bytes')
    .header('content-type', file.mime_type ?? 'application/octet-stream')
    .header('content-disposition', attachment(file.name))
    .header('x-content-type-options', 'nosniff')

  if (range === 'unsatisfiable') {
    return reply
      .code(416)
      .header('content-range', `bytes */${String(size)}`)
      .send()
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  if (range)
    reply.code(206).header('content-range', `bytes ${String(start)}-${String(end)}/${String(size)}`)
  void reply.header('content-length', String(end - start + 1))
  if (request.method === 'HEAD') return reply.send(nothing())
  counted(app, reply)
  const pieces = readVersion(app, file, start, end, cancellation(reply.raw))
  return reply.send(Readable.from(paced(reply.raw, pieces)))
}

/** An archive's query: the downloader's time zone (IANA), for its times. */
export const archiveQuery = z.object({ tz: z.string().max(64).optional() })

/**
 * Sends a ZIP that streams as it is built, with its exact length known up
 * front. Its times are in `timeZone` (`?tz=`, the downloader's), or UTC.
 */
export function sendZip(
  reply: FastifyReply,
  fileName: string,
  entries: ZipEntry[],
  timeZone?: string,
): FastifyReply {
  void reply
    .header('content-type', 'application/zip')
    .header('content-disposition', attachment(fileName))
    .header('content-length', String(zipLength(entries)))
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
  if (reply.request.method === 'HEAD') return reply.send(nothing())
  counted(reply.server, reply)
  return reply.send(
    Readable.from(paced(reply.raw, writeZip(entries, { timeZone: zipTimeZone(timeZone) }))),
  )
}

/** Counts the download as under way until its response closes, for the graphs (§16). */
function counted(app: FastifyInstance, reply: FastifyReply): void {
  reply.raw.once('close', app.downloads.enter())
}

/**
 * The body of an answer to `HEAD`: none, read from nowhere. Fastify answers
 * `HEAD` by draining the stream it is given, which for a file would read it
 * from Discord for nobody; an empty one keeps the headers, its length among
 * them.
 */
function nothing(): Readable {
  return Readable.from([])
}

/**
 * `source`'s pieces, each asked for only once the response's socket has
 * taken the one before. `Readable.from` asks for the next piece as soon as it
 * hands one on, so the reader would read ahead for a client taking nothing,
 * and one more chunk would wait in the stream. A socket takes a piece before
 * the client has it, as far as the connection's buffers go (DESIGN.md §6.2).
 * A response that closes instead ends the source.
 */
export async function* paced(
  response: Writable,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  for await (const piece of source) {
    yield piece
    if (response.destroyed) return
    if (response.writableNeedDrain && !(await drained(response))) return
  }
}

/**
 * A signal that aborts once `response` closes before it has finished, as
 * when its client cancels it: a seek does, and Chrome's player does on
 * opening a video, so what is being read for it can stop at once. Unlike the
 * socket taking pieces, this doesn't wait for the connection's buffers
 * (DESIGN.md §6.2).
 */
export function cancellation(response: Writable): AbortSignal {
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableFinished) controller.abort()
  })
  return controller.signal
}

/** Resolves `true` once `stream` drains, `false` if it closes first. */
function drained(stream: Writable): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (result: boolean) => () => {
      stream.off('drain', onDrain)
      stream.off('close', onClose)
      resolve(result)
    }
    const onDrain = settle(true)
    const onClose = settle(false)
    stream.once('drain', onDrain)
    stream.once('close', onClose)
  })
}

/**
 * Whether the browser already has this version: `If-None-Match` names it
 * (our ETag, compared weakly, in a list or as `*`), so a `304` answers it.
 */
export function notModified(
  request: FastifyRequest,
  file: Pick<DownloadableFile, 'version_id'>,
): boolean {
  const header = request.headers['if-none-match']
  if (header === undefined) return false
  const etag = `"${file.version_id}"`
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag)
}

/**
 * The range a request asks for, or none when it resumes a download of
 * another version of the file (`If-Range` names the version it began with,
 * our ETag): that download gets the whole of this version, not the rest of
 * it after the start of the other.
 */
export function requestedRange(
  request: FastifyRequest,
  file: Pick<DownloadableFile, 'version_id' | 'size_bytes'>,
): ReturnType<typeof parseRange> {
  const ifRange = request.headers['if-range']
  if (ifRange !== undefined && ifRange !== `"${file.version_id}"`) return null
  return parseRange(request.headers.range, file.size_bytes)
}

/**
 * The single range of a `Range: bytes=…` header: `null` for none (or one we
 * don't serve, like several ranges), `'unsatisfiable'` for one past the end.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match) return null
  const [, from = '', to = ''] = match
  if (from === '' && to === '') return null
  let start: number
  let end: number
  if (from === '') {
    // The last `to` bytes.
    start = Math.max(0, size - Number(to))
    end = size - 1
  } else {
    start = Number(from)
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** `attachment` with the name for every browser: an ASCII fallback and the UTF-8 original. */
export function attachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
