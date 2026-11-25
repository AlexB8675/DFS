import type { Executor } from '@dfs/db'
import { appItemSchema, nameKey } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requireAppToken, requireWrite } from '../auth/access.ts'
import { ApiError } from '../errors.ts'
import { NODE_COLUMNS, NODE_JOINS, VISIBLE, type NodeRow } from '../nodes/read.ts'
import { lockDrive } from '../nodes/write.ts'
import { streamBody } from '../uploads/stream-body.ts'
import {
  cancelUpload,
  completeUpload,
  startUploads,
  streamStart,
  type CompletionGuard,
} from '../uploads/uploads.ts'
import { appFolder } from './folder.ts'
import { toAppItem } from './items.ts'
import { childNamed, joinPath, resolvePrefix, urlSegments } from './paths.ts'
import { ensureBelow } from './tree.ts'

// `PUT /api/v1/files/{path}` (DESIGN.md §7.8): a file made or replaced in one
// request. Its body stays a stream: the plugin's catch-all parser leaves it
// unread, and `streamBody` cuts it into parts as it arrives.

/** Uploads in flight at once, per token. */
const MAX_IN_FLIGHT = 3
const MAX_TYPE_LENGTH = 255

interface Conditions {
  ifMatch: string | undefined
  ifNoneMatch: string | undefined
}

function badRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message)
}

/** The request's declared length: required, digits only, a safe integer. */
function declaredLength(request: FastifyRequest): number {
  const header = request.headers['content-length']
  if (header === undefined) {
    throw new ApiError(
      411,
      'length_required',
      'Send a Content-Length: the body cannot be sent chunked.',
    )
  }
  const length = Number(header)
  if (!/^\d+$/.test(header) || !Number.isSafeInteger(length)) {
    throw badRequest('Content-Length must be a whole number of bytes.')
  }
  return length
}

/**
 * The `Content-Type` as sent, kept before Fastify sees it: Fastify answers 415
 * to a header that isn't a media type, and a PUT stores whatever was sent.
 */
const sentTypes = new WeakMap<FastifyRequest, string>()

/** The type as sent, trimmed; none, or an empty one, is `null`. */
function declaredType(request: FastifyRequest): string | null {
  const type = sentTypes.get(request)?.trim() ?? ''
  if (type.length > MAX_TYPE_LENGTH) {
    throw badRequest(`Content-Type can be at most ${String(MAX_TYPE_LENGTH)} characters.`)
  }
  return type === '' ? null : type
}

function conditionsOf(request: FastifyRequest): Conditions {
  const ifNoneMatch = request.headers['if-none-match']?.trim()
  if (ifNoneMatch !== undefined && ifNoneMatch !== '*') {
    throw badRequest('If-None-Match on a PUT can only be *: it asks for a file that is not there.')
  }
  return { ifMatch: request.headers['if-match']?.trim(), ifNoneMatch }
}

/** The conditions against the file's current version (`null`: no file to speak of). */
function checkConditions(conditions: Conditions, current: string | null, path: string): void {
  if (conditions.ifNoneMatch !== undefined && current !== null) {
    throw new ApiError(412, 'exists', `“${path}” already exists.`)
  }
  const { ifMatch } = conditions
  if (ifMatch === undefined) return
  const matches =
    current !== null &&
    (ifMatch === '*' ||
      ifMatch.split(',').some((tag) => {
        const trimmed = tag.trim()
        // A weak tag never matches: a version is exact bytes.
        if (trimmed.startsWith('W/')) return false
        const bare = /^"(.*)"$/.exec(trimmed)?.[1] ?? trimmed
        return bare === current
      }))
  if (!matches) {
    throw new ApiError(
      412,
      'version_changed',
      `“${path}” is not at the version in If-Match: it changed, or is not there.`,
    )
  }
}

function pathChanged(): ApiError {
  return new ApiError(
    409,
    'path_changed',
    'The file’s place changed while it uploaded, so nothing was stored.',
  )
}

/** Its own plugin, so its body stays a stream. */
export function appPutRoute(app: FastifyInstance, _options: object, done: () => void): void {
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_request, _payload, parsed) => {
    parsed(null)
  })
  app.addHook('onRequest', (request, _reply, hookDone) => {
    const sent = request.headers['content-type']
    if (sent !== undefined) {
      sentTypes.set(request, sent)
      request.headers['content-type'] = 'application/octet-stream'
    }
    hookDone()
  })
  const inFlight = new Map<string, number>()

  const upload = async (
    request: FastifyRequest,
    reply: FastifyReply,
    token: ReturnType<typeof requireAppToken>,
    name: string,
    segments: string[],
    sizeBytes: number,
    type: string | null,
    conditions: Conditions,
  ) => {
    const ownerId = token.user.id
    const parentSegments = segments.slice(0, -1)
    // Missing folders first, in a transaction of their own (a ruling: see the plan).
    if ((await resolvePrefix(app.db, token, parentSegments)).rest.length > 0) {
      // Missing parents mean no file: an If-Match can only fail, and no folder is made for it.
      if (conditions.ifMatch !== undefined) checkConditions(conditions, null, segments.join('/'))
      await app.db.transaction(async (tx) => {
        await lockDrive(tx, ownerId, 'shared')
        const { deepest, rest } = await resolvePrefix(tx, token, parentSegments)
        if (rest.length > 0) await ensureBelow(tx, ownerId, deepest.id, rest)
      })
    }

    // The start: what the conditions saw is what the upload is made against.
    const started = await app.db.transaction(async (tx) => {
      await lockDrive(tx, ownerId, 'shared')
      await appFolder(tx, token)
      const { deepest, path, rest } = await resolvePrefix(tx, token, parentSegments)
      if (rest.length > 0) throw pathChanged()
      const full = joinPath(path, name)
      const existing = await childNamed(tx, ownerId, deepest.id, name, true)
      if (existing?.kind === 'folder') {
        throw new ApiError(409, 'not_a_file', `“${full}” is a folder, not a file.`)
      }
      // An unfinished file has no current version: as good as none.
      checkConditions(conditions, existing?.current_version_id ?? null, full)
      const [outcome] = await startUploads(app, tx, token, [
        { parentId: deepest.id, name, sizeBytes, mimeType: type ?? '' },
      ])
      if (outcome === undefined) throw new Error('Starting an upload returned nothing.')
      if (outcome instanceof ApiError) {
        throw outcome.code === 'name_conflict'
          ? new ApiError(409, 'not_a_file', `“${full}” is a folder, not a file.`)
          : outcome
      }
      return { session: outcome, parentPath: path, parentId: deepest.id }
    })

    const { uploadId, nodeId } = started.session
    let wasNew = false
    const guard: CompletionGuard = {
      mimeType: type,
      async check(tx, uploaded, file) {
        const { rows } = await tx.execute(sql`
          SELECT 1 FROM app_tokens WHERE id = ${token.tokenId}`)
        if (rows.length === 0) {
          throw new ApiError(401, 'invalid_token', 'This app token has been removed.')
        }
        await appFolder(tx, token)
        if (!file.visible || file.nameKey !== nameKey(name)) throw pathChanged()
        // Moved to another folder meanwhile (within the token's folder or out of it).
        // A rename of an ancestor is accepted: the answer's path is the one from the start.
        if (uploaded.parentId !== started.parentId) throw pathChanged()
        await checkReach(tx, ownerId, token.folderId, uploaded.parentId)
        checkConditions(conditions, file.currentVersionId, joinPath(started.parentPath, name))
        wasNew = file.currentVersionId === null
      },
    }
    try {
      if (sizeBytes > 0) {
        const start = await streamStart(app, token, uploadId, 0)
        await streamBody(app, request, reply, token, uploadId, 0, start, {
          completeAlone: false,
        })
      }
      await completeUpload(app, token, uploadId, undefined, guard)
    } catch (error) {
      await cancelUpload(app, token, uploadId).catch((cause: unknown) => {
        request.log.warn({ err: cause, uploadId }, 'could not cancel a refused app upload')
      })
      throw error
    }
    // Read by ID, with the path known at the start: a move right after the
    // commit must not turn a stored upload's answer into a 404.
    const { rows } = await app.db.execute<NodeRow>(sql`
      SELECT ${NODE_COLUMNS} FROM nodes n /* tree: by id, answer after the commit */ ${NODE_JOINS}
      WHERE n.id = ${nodeId}`)
    const row = rows[0]
    if (!row) throw new Error('A stored upload’s file is gone.')
    // This upload's own version, size and type: a PUT that committed right after
    // must not hand its version to this client, which would hide a lost update.
    const item = {
      ...toAppItem(row, joinPath(started.parentPath, row.name)),
      version: started.session.versionId,
      size: sizeBytes,
      mimeType: type,
    }
    return { item, created: wasNew }
  }

  const put = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = requireAppToken(request.appToken)
    requireWrite(token)
    const segments = urlSegments(request.url, '/api/v1/files')
    const name = segments.at(-1)
    if (name === undefined) {
      throw new ApiError(400, 'invalid_path', 'A file needs a name: send it at /files/{path}.')
    }
    const sizeBytes = declaredLength(request)
    const type = declaredType(request)
    const conditions = conditionsOf(request)

    const running = inFlight.get(token.tokenId) ?? 0
    if (running >= MAX_IN_FLIGHT) {
      throw new ApiError(
        429,
        'too_many_uploads',
        'This app token already has 3 uploads in flight. Wait for one to end.',
        { 'retry-after': '5' },
      )
    }
    inFlight.set(token.tokenId, running + 1)
    try {
      const { item, created } = await upload(
        request,
        reply,
        token,
        name,
        segments,
        sizeBytes,
        type,
        conditions,
      )
      reply.code(created ? 201 : 200)
      return item
    } finally {
      const left = (inFlight.get(token.tokenId) ?? 1) - 1
      if (left <= 0) inFlight.delete(token.tokenId)
      else inFlight.set(token.tokenId, left)
    }
  }

  const routes = app.withTypeProvider<ZodTypeProvider>()
  const options = {
    config: { access: 'app' as const },
    schema: { response: { 200: appItemSchema, 201: appItemSchema } },
  }
  routes.put('/v1/files', options, put)
  routes.put('/v1/files/*', options, put)
  done()
}

/** The upload's folder must still lead up to the token's folder through visible folders in My drive. */
async function checkReach(
  tx: Executor,
  ownerId: string,
  folderId: string,
  parentId: string | null,
): Promise<void> {
  let id = parentId
  // A tree is no deeper than this, and a cycle would otherwise never end.
  for (let depth = 0; depth < 10_000 && id !== null; depth += 1) {
    if (id === folderId) return
    const { rows } = await tx.execute<{ parent_id: string | null }>(sql`
      SELECT n.parent_id FROM nodes n /* tree: by id, gated */
      WHERE n.id = ${id} AND n.owner_id = ${ownerId} AND n.kind = 'folder'
        AND n.tree = 'drive' AND ${VISIBLE}`)
    const [folder] = rows
    if (!folder) throw pathChanged()
    id = folder.parent_id
  }
  throw pathChanged()
}
