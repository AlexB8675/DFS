import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readVersion, type ReadableVersion } from './reader.ts'
import { writeZip, zipLength, type ZipEntry } from './zip.ts'

// Sending files and archives (DESIGN.md §6.2, §7.5): streamed, Range-aware,
// always as attachments with `nosniff`, so nothing uploaded runs in the page.

export interface DownloadableFile extends ReadableVersion {
  name: string
  mime_type: string | null
}

/** Sends a file, or the byte range asked for with `206 Partial Content`. */
export function sendFile(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  file: DownloadableFile,
): FastifyReply {
  const size = file.size_bytes
  const range = parseRange(request.headers.range, size)
  void reply
    .header('accept-ranges', 'bytes')
    .header('etag', `"${file.version_id}"`)
    .header('cache-control', 'private, no-cache')
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
  return reply.send(Readable.from(readVersion(app, file, start, end)))
}

/** Sends a ZIP that streams as it is built, with its exact length known up front. */
export function sendZip(reply: FastifyReply, fileName: string, entries: ZipEntry[]): FastifyReply {
  return reply
    .header('content-type', 'application/zip')
    .header('content-disposition', attachment(fileName))
    .header('content-length', String(zipLength(entries)))
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .send(Readable.from(writeZip(entries)))
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
