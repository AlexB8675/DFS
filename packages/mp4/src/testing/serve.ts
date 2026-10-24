// A Range server over the corpus, for the browser suites (DESIGN.md §10.4, D45).
// Vitest runs this as the browser config's `globalSetup`: it serves the
// manifest's files where the browser can fetch them (the player reads a file by
// Range, so does this), and `provide`s `corpus` for the tests to `inject`. Paths
// stay here: the browser is given an id and a base name for each file. The files
// are served at `http://127.0.0.1:<port>/<token>/file/<id>`, under a random token
// of each run, so that no other page on the computer can read them: they include
// the user's videos, which never leave it. Tests and scripts only: the package
// itself does no I/O.

import { randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { pipeline } from 'node:stream'
import type { TestProject } from 'vitest/node'
import { isSynthetic, loadManifest, uniqueTitles } from './corpus.ts'
import type { ManifestEntry } from './corpus.ts'
import type { CorpusInfo } from './provided.ts'

/** The bytes `start` to `end` of a file, both inclusive. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * What a `Range` header asks of a file of `size` bytes (RFC 9110 §14): the
 * range, cut to the file's end; `'unsatisfiable'` for one that starts past the
 * end, which gets a 416; and `undefined` for no header, or one this server
 * doesn't take (another unit, several ranges, a malformed one), which the RFC
 * has it ignore and answer with the whole file.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | undefined {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, from = '', to = ''] = match
  if (from === '' && to === '') return undefined
  let start: number
  let end: number
  if (from === '') {
    // `-n`: the last n bytes.
    const last = Number(to)
    if (last === 0) return 'unsatisfiable'
    start = Math.max(0, size - last)
    end = size - 1
  } else {
    start = Number(from)
    // A last byte before the first is malformed; an open end, from past the file's end, is only unsatisfiable.
    if (to !== '' && Number(to) < start) return undefined
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  }
  return start >= size ? 'unsatisfiable' : { start, end }
}

const TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
}

/**
 * The page that runs the tests is on another port, so another origin, and which one isn't known when the server starts: so any origin may fetch by
 * Range and read the headers a player needs. What keeps another page from the files is the token in their path (`startCorpusServer`), which
 * only this run's page is given: a page that can't name the path has nothing to fetch.
 */
const CORS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  'Access-Control-Max-Age': '600',
}

function reply(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number> = {},
): void {
  res.writeHead(status, { ...CORS, ...headers })
  res.end()
}

/** Answers a request: a file of `paths` at `/<token>/file/<id>`, and nothing at any other path, one under another token included. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  paths: readonly string[],
  token: string,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    reply(res, 204)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply(res, 405, { Allow: 'GET, HEAD, OPTIONS' })
    return
  }
  const match = /^\/([^/]+)\/file\/(\d+)$/.exec(
    new URL(req.url ?? '/', 'http://localhost').pathname,
  )
  // A wrong token is a path the server never had, as a missing one is.
  const id = match?.[1] === token ? match[2] : undefined
  const path = id === undefined ? undefined : paths[Number(id)]
  if (path === undefined) {
    reply(res, 404)
    return
  }
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    // The file went from the disk after the server began: the same as one it never had.
    reply(res, 404)
    return
  }

  const range = parseRange(req.headers.range, size)
  if (range === 'unsatisfiable') {
    reply(res, 416, { 'Content-Range': `bytes */${size}` })
    return
  }
  const headers: Record<string, string | number> = {
    ...CORS,
    'Accept-Ranges': 'bytes',
    'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
  }
  let status = 200
  let bytes = size
  if (range) {
    status = 206
    bytes = range.end - range.start + 1
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
  }
  headers['Content-Length'] = bytes
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || bytes === 0) {
    res.end()
    return
  }
  // A player drops a request when it seeks or stops: the pipeline then closes the file.
  pipeline(createReadStream(path, range ?? {}), res, () => {
    // Nothing to tell: the client has what it wanted of the file, or no longer wants it.
  })
}

/** A running server over some files, and the `corpus` it provides. */
export interface CorpusServer {
  info: CorpusInfo
  close: () => Promise<void>
}

/**
 * Serves the entries' files at `http://127.0.0.1:<port>/<token>/file/<id>`, `id`
 * being the entry's place in the list, on a port the system picks. The token is
 * 128 random bits (32 hex characters), new for each server, and is part of the
 * `url` that `info` gives: the files are served nowhere else, so the page that is
 * given the URL can read them and no other page can, whatever its origin (CORS
 * allows any, as the test page's isn't known when this starts). Only those files
 * can be reached, and only by id. An entry whose file is gone from the disk (or
 * can't be looked at) is left out, with one warning for all of them, and the ids
 * are the places in the list of those that are left.
 */
export async function startCorpusServer(entries: readonly ManifestEntry[]): Promise<CorpusServer> {
  const present: { entry: ManifestEntry; size: number }[] = []
  for (const entry of entries) {
    try {
      present.push({ entry, size: statSync(entry.path).size })
    } catch {
      // Gone, or not to be read: not a file to serve, and not a reason for the suites not to start.
    }
  }
  if (present.length < entries.length) {
    console.warn(
      `${entries.length - present.length} of ${entries.length} corpus files are gone from the disk and left out.`,
    )
  }
  const paths = present.map(({ entry }) => entry.path)
  // The same titles as the corpus suite's (the folder's name and the file's, different for every file), never a path.
  const titles = uniqueTitles(paths)
  const token = randomBytes(16).toString('hex')
  const server = createServer((req, res) => {
    handle(req, res, paths, token).catch(() => {
      if (res.headersSent) res.destroy()
      else reply(res, 500)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    info: {
      url: `http://127.0.0.1:${port}/${token}`,
      files: present.map(({ entry, size }, id) => ({
        id,
        name: titles[id] ?? '',
        expect: entry.expect,
        size,
        synthetic: isSynthetic(entry.path),
      })),
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        // A player leaves its connections open, and a request may be half-sent.
        server.closeAllConnections()
      }),
  }
}

/** Whether the environment asks for every file that is expected to play to be played, and not the sample of them (`DFS_CORPUS_ALL=1`): the browser has no environment to ask. */
export function playsAll(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.DFS_CORPUS_ALL === '1'
}

/** Vitest's `globalSetup`: starts the server over the manifest, provides `corpus` and `playAll`, and closes the server at the end. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startCorpusServer(loadManifest())
  project.provide('corpus', server.info)
  project.provide('playAll', playsAll(process.env))
  return server.close
}
