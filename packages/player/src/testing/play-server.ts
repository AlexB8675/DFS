// The server of the browser suites (DESIGN.md §10.4; the iron-clad spec §4.7). It serves the
// corpus manifest's files, the user's videos included, where they are: each body is a read
// stream over the manifest's own path, so nothing is copied or kept. A test shapes the network
// that the following requests see (a bandwidth shared by every open response, a latency before
// the headers, and faults that apply once each, as in range-server.ts) through
// `POST <base>/control`, and reads what the server saw from `GET <base>/log`. Vitest runs `setup`
// as the browser config's `globalSetup`, which provides `playServer` for the tests to `inject`.
// Everything is under `http://127.0.0.1:<port>/<token>`, a random token of each run, so that no
// other page on the computer can read the files. For tests only (it uses `node:http`), so the
// package does not export it.

import { randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { isSynthetic, loadManifest, parseRange, uniqueTitles } from '@dfs/mp4/testing/node'
import type { ManifestEntry } from '@dfs/mp4/testing/node'
import type { TestProject } from 'vitest/node'
import type { Fault, LogEntry, Network, PlayFile, PlayServerInfo } from './provided.ts'

/**
 * The test page is on Vitest's port, another origin, and which one isn't known when the server
 * starts: so any origin may fetch by Range and read the headers a player needs. What keeps
 * another page from the files is the token in their path.
 */
const CORS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag',
  'Access-Control-Max-Age': '600',
}

/** The largest read from a file at once, so that a shaped link is fed in pieces as small as a real one's. */
const PIECE_BYTES = 16 * 1024

/** The most a control request may weigh. */
const CONTROL_LIMIT_BYTES = 1024 * 1024

export interface PlayServer {
  info: PlayServerInfo
  /** Ends the open responses and stops listening. It resolves when the server is closed, and may be called again. */
  close(): Promise<void>
}

interface Served {
  path: string
  size: number
  etag: string
}

/** Where a request's path points under the token, or null for a path the server does not have. */
type Route = { kind: 'file'; id: string } | { kind: 'control' } | { kind: 'log' }

function route(url: string | undefined, token: string): Route | null {
  const path = new URL(url ?? '/', 'http://localhost').pathname
  const match = /^\/([^/]+)\/(control|log|file\/([^/]+))$/.exec(path)
  if (match?.[1] !== token) return null
  if (match[2] === 'control') return { kind: 'control' }
  if (match[2] === 'log') return { kind: 'log' }
  return match[3] === undefined ? null : { kind: 'file', id: match[3] }
}

function reply(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number> = {},
  body?: string,
): void {
  res.writeHead(status, { ...CORS, ...headers })
  res.end(body)
}

/** Waits `ms` (for ever when null), or until the response is over: the timer does not outlive a client that went away. */
function pause(res: ServerResponse, ms: number | null): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      res.off('close', done)
      resolve()
    }
    const timer = ms === null ? undefined : setTimeout(done, ms)
    res.once('close', done)
  })
}

/** Whether the response is over: read afresh, as it changes while the body waits. */
function gone(res: ServerResponse): boolean {
  return res.destroyed
}

/** Waits until the response can take more, or is over. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed) {
      resolve()
      return
    }
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

/** Writes a piece, and resolves when it has left for the socket (or the response is over). */
function written(res: ServerResponse, piece: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    res.write(piece, () => {
      resolve()
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** A fault as a control gave it, or why it is not one. */
function faultOf(value: unknown): Fault | string {
  if (!isRecord(value)) return 'a fault is not an object'
  switch (value.kind) {
    case 'drop':
      return count(value.afterBytes)
        ? { kind: 'drop', afterBytes: value.afterBytes }
        : 'a drop needs afterBytes'
    case 'stall':
      return count(value.afterBytes) && (value.ms === null || count(value.ms))
        ? { kind: 'stall', afterBytes: value.afterBytes, ms: value.ms }
        : 'a stall needs afterBytes and ms (a number or null)'
    case 'switch':
      return count(value.refuseMs)
        ? { kind: 'switch', refuseMs: value.refuseMs }
        : 'a switch needs refuseMs'
    case 'status':
      return typeof value.status === 'number' &&
        Number.isInteger(value.status) &&
        value.status >= 200 &&
        value.status <= 599
        ? { kind: 'status', status: value.status }
        : 'a status fault needs a status from 200 to 599'
    default:
      return 'a fault has an unknown kind'
  }
}

/** A control's body as a network, or why it is not one. */
function networkOf(text: string): Network | string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return 'the control is not JSON'
  }
  if (!isRecord(value)) return 'the control is not an object'
  const { bandwidthBytesPerSecond, latencyMs, faults } = value
  const net: Network = {}
  if (bandwidthBytesPerSecond !== undefined) {
    if (!count(bandwidthBytesPerSecond) || bandwidthBytesPerSecond === 0) {
      return 'bandwidthBytesPerSecond must be a number above 0'
    }
    net.bandwidthBytesPerSecond = bandwidthBytesPerSecond
  }
  if (latencyMs !== undefined) {
    if (!count(latencyMs)) return 'latencyMs must be a number from 0'
    net.latencyMs = latencyMs
  }
  if (faults !== undefined) {
    if (!Array.isArray(faults)) return 'faults must be a list'
    net.faults = []
    for (const item of faults as unknown[]) {
      const fault = faultOf(item)
      if (typeof fault === 'string') return fault
      net.faults.push(fault)
    }
  }
  return net
}

function bodyOf(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (part: Buffer) => {
      size += part.length
      if (size > CONTROL_LIMIT_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      parts.push(part)
    })
    req.on('end', () => {
      resolve(Buffer.concat(parts).toString('utf8'))
    })
    req.on('error', () => {
      resolve(null)
    })
  })
}

/** Starts the server over the entries' files, on 127.0.0.1, on a port the system chooses. */
export async function startPlayServer(
  entries: readonly ManifestEntry[] = loadManifest(),
): Promise<PlayServer> {
  const present: { entry: ManifestEntry; served: Served }[] = []
  for (const entry of entries) {
    try {
      const stats = statSync(entry.path)
      present.push({
        entry,
        served: {
          path: entry.path,
          size: stats.size,
          etag: `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
        },
      })
    } catch {
      // Gone from the disk, or not to be read: not a file to serve.
    }
  }
  const titles = uniqueTitles(present.map(({ entry }) => entry.path))
  const files: PlayFile[] = present.map(({ entry, served }, at) => ({
    id: String(at),
    name: titles[at] ?? '',
    synthetic: isSynthetic(entry.path),
    size: served.size,
    expect: entry.expect,
  }))
  const token = randomBytes(16).toString('hex')

  // The network. Each control replaces all of it.
  let bandwidth: number | null = null
  let latencyMs = 0
  let faults: Fault[] = []
  // The link's budget is one for every open response: each piece takes the next slot on it.
  let linkFree = 0
  let refuseUntil = 0
  const log: LogEntry[] = []
  const sockets = new Set<Socket>()

  /** Waits for the link to have room for `bytes` more, as a link shared by every response does. */
  async function take(res: ServerResponse, bytes: number): Promise<void> {
    if (bandwidth === null) return
    const now = performance.now()
    const start = Math.max(linkFree, now)
    linkFree = start + (bytes / bandwidth) * 1000
    if (start > now) await pause(res, start - now)
  }

  /** The body, from `start` to `end` inclusive, in pieces, over the shaped link, with the fault that this request was given. */
  async function sendBody(
    res: ServerResponse,
    entry: LogEntry,
    served: Served,
    start: number,
    end: number,
    fault: Fault | undefined,
  ): Promise<void> {
    const length = end - start + 1
    const stream = createReadStream(served.path, { start, end, highWaterMark: PIECE_BYTES })
    // A fault at a body's end or past it never gets there: the body goes whole.
    const cutAt =
      (fault?.kind === 'drop' || fault?.kind === 'stall') && fault.afterBytes < length
        ? fault.afterBytes
        : null
    let sent = 0
    let lastWrite: Promise<void> = Promise.resolve()
    try {
      for await (const chunk of stream) {
        const bytes = chunk as Buffer
        let offset = 0
        while (offset < bytes.length) {
          if (fault !== undefined && cutAt !== null && sent === cutAt) {
            if (fault.kind === 'drop') {
              // What was sent leaves before the connection is let go: a destroyed socket forgets what it has not sent.
              await lastWrite
              if (sent === 0) await new Promise((resolve) => setImmediate(resolve))
              entry.outcome = 'dropped'
              res.destroy()
              return
            }
            if (fault.kind === 'stall') await pause(res, fault.ms)
          }
          if (gone(res)) return
          let piece = bytes.length - offset
          if (cutAt !== null && sent < cutAt) piece = Math.min(piece, cutAt - sent)
          await take(res, piece)
          if (gone(res)) return
          const part = bytes.subarray(offset, offset + piece)
          if (cutAt !== null && sent + piece === cutAt && fault?.kind === 'drop') {
            lastWrite = written(res, part)
          } else if (!res.write(part)) {
            await drained(res)
          }
          entry.bytesSent += piece
          sent += piece
          offset += piece
        }
      }
    } finally {
      stream.destroy()
    }
    if (res.destroyed) return
    entry.outcome = 'done'
    res.end()
  }

  async function answerFile(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    served: Served,
  ): Promise<void> {
    const entry: LogEntry = {
      id,
      range: req.headers.range ?? null,
      status: 0,
      bytesSent: 0,
      outcome: 'open',
    }
    log.push(entry)
    res.once('close', () => {
      if (entry.outcome === 'open') entry.outcome = 'aborted'
    })
    const fault = faults.shift()
    if (latencyMs > 0) await pause(res, latencyMs)
    if (res.destroyed) return

    const settle = (status: number, headers: Record<string, string | number>): void => {
      entry.status = status
      res.writeHead(status, { ...CORS, ...headers })
    }
    if (fault?.kind === 'status') {
      settle(fault.status, { 'Content-Length': 0 })
      entry.outcome = 'done'
      res.end()
      return
    }
    const { size } = served
    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      settle(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 })
      entry.outcome = 'done'
      res.end()
      return
    }
    const headers: Record<string, string | number> = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      ETag: served.etag,
      'Content-Type': 'application/octet-stream',
    }
    const first = range?.start ?? 0
    const last = range?.end ?? size - 1
    if (range !== undefined) headers['Content-Range'] = `bytes ${first}-${last}/${size}`
    headers['Content-Length'] = last - first + 1
    settle(range === undefined ? 200 : 206, headers)
    if (req.method === 'HEAD' || size === 0) {
      entry.outcome = 'done'
      res.end()
      return
    }
    res.flushHeaders()
    await sendBody(res, entry, served, first, last, fault)
  }

  async function answerControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const text = await bodyOf(req)
    const net = text === null ? 'the control could not be read' : networkOf(text)
    // The control's own connection is not one of the network's: it ends with this answer, so that none outlives it.
    if (typeof net === 'string') {
      reply(res, 400, { 'Content-Type': 'text/plain', Connection: 'close' }, net)
      return
    }
    bandwidth = net.bandwidthBytesPerSecond ?? null
    latencyMs = net.latencyMs ?? 0
    linkFree = 0
    faults = []
    for (const fault of net.faults ?? []) {
      if (fault.kind !== 'switch') {
        faults.push(fault)
        continue
      }
      refuseUntil = Math.max(refuseUntil, Date.now() + fault.refuseMs)
      for (const socket of sockets) if (socket !== req.socket) socket.destroy()
    }
    reply(res, 204, { Connection: 'close' })
  }

  const server = createServer((req, res) => {
    req.on('error', () => undefined)
    res.on('error', () => undefined)
    const target = route(req.url, token)
    if (target === null) {
      reply(res, 404)
      return
    }
    const allowed =
      target.kind === 'file'
        ? 'GET, HEAD, OPTIONS'
        : target.kind === 'control'
          ? 'POST, OPTIONS'
          : 'GET, DELETE, OPTIONS'
    if (req.method === 'OPTIONS') {
      reply(res, 204)
      return
    }
    if (!allowed.split(', ').includes(req.method ?? '')) {
      reply(res, 405, { Allow: allowed })
      return
    }
    if (target.kind === 'control') {
      answerControl(req, res).catch(() => {
        res.destroy()
      })
    } else if (target.kind === 'log') {
      if (req.method === 'DELETE') {
        log.length = 0
        reply(res, 204)
      } else {
        reply(
          res,
          200,
          { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          JSON.stringify(log),
        )
      }
    } else {
      const at = /^\d+$/.test(target.id) ? Number(target.id) : -1
      const served = present[at]?.served
      if (served === undefined) {
        reply(res, 404)
        return
      }
      answerFile(req, res, target.id, served).catch(() => {
        res.destroy()
      })
    }
  })
  server.on('connection', (socket) => {
    if (Date.now() < refuseUntil) {
      log.push({ id: null, range: null, status: 0, bytesSent: 0, outcome: 'refused' })
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo

  let closing: Promise<void> | null = null
  return {
    info: { base: `http://127.0.0.1:${port}/${token}`, files },
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        // A player leaves its connections open, and a response may be stalled for ever.
        server.closeAllConnections()
      })
      return closing
    },
  }
}

/**
 * Vitest's `globalSetup`: starts the server over the manifest, provides `playServer`, and closes the server at the
 * end. With no corpus file there is nothing to serve: no server is started, and `files` is empty.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const entries = loadManifest()
  if (entries.length === 0) {
    project.provide('playServer', { base: '', files: [] })
    return () => Promise.resolve()
  }
  const server = await startPlayServer(entries)
  project.provide('playServer', server.info)
  return () => server.close()
}
