import type { Executor } from '@dfs/db'
import { nameKey, normalizeName, validateName } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { AppTokenAuth } from '../app-tokens/tokens.ts'
import { ApiError } from '../errors.ts'
import { NODE_COLUMNS, NODE_JOINS, VISIBLE, type NodeRow } from '../nodes/read.ts'
import { appFolder } from './folder.ts'

// Paths of the agent API (DESIGN.md §7.8): split before decoding, stored form
// only, resolved down from the token's folder.

function invalid(message: string): ApiError {
  return new ApiError(400, 'invalid_path', message)
}

/** One segment as sent, after decoding: it must already be a stored name. */
function checkSegment(segment: string): string {
  const shown = JSON.stringify(segment)
  if (segment === '') {
    throw invalid('A path cannot have an empty segment: leave out the doubled slash.')
  }
  if (segment === '.' || segment === '..') {
    throw invalid(`The segment ${shown} is not allowed: paths have no . or .. segments.`)
  }
  if (!segment.isWellFormed()) {
    throw invalid(`The segment ${shown} is not a valid name: it is not well-formed Unicode.`)
  }
  if (segment.normalize('NFC') !== segment) {
    throw invalid(`The segment ${shown} is not a valid name: send names in Unicode NFC.`)
  }
  if (normalizeName(segment) !== segment) {
    throw invalid(
      `The segment ${shown} is not a valid name: send names without spaces at either end.`,
    )
  }
  const problem = validateName(segment)
  if (problem) throw invalid(`The segment ${shown} is not a valid name: ${problem}`)
  return segment
}

function splitChecked(raw: string, decode: boolean): string[] {
  if (raw === '') return []
  const parts = raw.split('/')
  return parts.map((part, index) => {
    let value = part
    if (decode) {
      try {
        value = decodeURIComponent(part)
      } catch {
        throw invalid(`The segment ${JSON.stringify(part)} is not valid percent-encoding.`)
      }
    }
    if (value === '' && index === parts.length - 1 && parts.length > 1) {
      throw invalid('A path cannot end with a slash: leave out the trailing slash.')
    }
    return checkSegment(value)
  })
}

/**
 * The path segments of a request URL after the route's `prefix`. Taken from
 * the raw URL, never from the decoded wildcard: cut the query, split on `/`,
 * then decode each segment. The token's folder itself is `''` or `/`.
 */
export function urlSegments(url: string, prefix: string): string[] {
  if (!url.startsWith(prefix)) throw invalid('This path is not under the route.')
  let rest = url.slice(prefix.length)
  const query = rest.indexOf('?')
  if (query >= 0) rest = rest.slice(0, query)
  if (rest === '' || rest === '/') return []
  if (!rest.startsWith('/')) throw invalid('This path is not under the route.')
  return splitChecked(rest.slice(1), true)
}

/** The segments of a path in a JSON body: plain text, one leading `/` allowed. */
export function bodySegments(path: string): string[] {
  const rest = path.startsWith('/') ? path.slice(1) : path
  return splitChecked(rest, false)
}

export function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

export interface Resolved {
  folder: NodeRow
  node: NodeRow
  path: string
}

/**
 * The owner's visible child of `parentId` named `segment` in My drive. An
 * unfinished file is there only when `unfinished` is set. Callers that act on
 * the result pass a transaction.
 */
async function child(
  db: Executor,
  ownerId: string,
  parentId: string,
  segment: string,
  unfinished = false,
): Promise<NodeRow | undefined> {
  const { rows } = await db.execute<NodeRow>(sql`
    SELECT ${NODE_COLUMNS} FROM nodes n /* tree: by parent */ ${NODE_JOINS}
    WHERE n.parent_id = ${parentId} AND n.owner_id = ${ownerId} AND n.tree = 'drive'
      AND n.name_key = ${nameKey(segment)} AND ${VISIBLE}
      AND (${unfinished} OR n.kind = 'folder' OR n.current_version_id IS NOT NULL)`)
  return rows[0]
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'Nothing is at this path.')
}

/** The item at `segments` below the token's folder, or a 404. */
export async function resolvePath(
  db: Executor,
  token: AppTokenAuth,
  segments: readonly string[],
): Promise<Resolved> {
  const folder = await appFolder(db, token)
  let node = folder
  let path = ''
  for (const segment of segments) {
    if (node.kind !== 'folder') throw notFound()
    const next = await child(db, token.user.id, node.id, segment)
    if (!next) throw notFound()
    node = next
    path = joinPath(path, node.name)
  }
  return { folder, node, path }
}

/** Walks as far as folders exist, for making the folders that are missing. */
export async function resolvePrefix(
  db: Executor,
  token: AppTokenAuth,
  segments: readonly string[],
): Promise<{ folder: NodeRow; deepest: NodeRow; path: string; rest: string[] }> {
  const folder = await appFolder(db, token)
  let deepest = folder
  let path = ''
  for (const [index, segment] of segments.entries()) {
    const next = await child(db, token.user.id, deepest.id, segment, true)
    if (!next) return { folder, deepest, path, rest: segments.slice(index) }
    if (next.kind !== 'folder') {
      throw new ApiError(
        409,
        'not_a_folder',
        `“${joinPath(path, next.name)}” is a file, not a folder.`,
      )
    }
    deepest = next
    path = joinPath(path, next.name)
  }
  return { folder, deepest, path, rest: [] }
}
