import type { Executor } from '@dfs/db'
import { fileMediaSchema, mediaKind, playbackSchema, savePositionSchema } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import { sendFile, type DownloadableFile } from '../content/send.ts'
import { ApiError } from '../errors.ts'
import { keptExamination, MediaUnavailableError, type Examined } from '../media/examine.ts'
import {
  clearPosition,
  savedPosition,
  savePosition,
  subtitleFileAsWebVtt,
  subtitleFilesBeside,
} from '../media/playback.ts'
import { mediaTokenValid } from '../media/token.ts'
import { visibleNode, type NodeRow } from '../nodes/read.ts'
import { downloadableFile, versionChanged } from './content.ts'

// Audio and video (DESIGN.md §6.7, §9, §10.4): what a file holds, what a
// player needs to start, where each user stopped and subtitles, for the players,
// and the plaintext of a version for the media service, which examines it.

const byId = z.object({ id: z.uuid() })

export function mediaRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  routes.get(
    '/files/:id/media',
    { schema: { params: byId, response: { 200: fileMediaSchema } } },
    async (request) => {
      const auth = requireAuth(request.auth)
      const node = await mediaNode(app.db, auth.user.id, request.params.id)
      const file = await downloadableFile(app.db, node.id)
      return { versionId: file.version_id, ...(await examined(app, file)) }
    },
  )

  // What a player needs to start, from the database alone (§10.4).
  routes.get(
    '/files/:id/playback',
    { schema: { params: byId, response: { 200: playbackSchema } } },
    async (request) => {
      const auth = requireAuth(request.auth)
      const node = await mediaNode(app.db, auth.user.id, request.params.id)
      const file = await downloadableFile(app.db, node.id)
      const [positionMs, subtitleFiles] = await Promise.all([
        savedPosition(app.db, auth.user.id, node.id, file.version_id),
        subtitleFilesBeside(app.db, node),
      ])
      return { versionId: file.version_id, positionMs, subtitleFiles }
    },
  )

  routes.put(
    '/files/:id/position',
    { schema: { params: byId, body: savePositionSchema } },
    async (request, reply) => {
      const auth = requireAuth(request.auth)
      const node = await mediaNode(app.db, auth.user.id, request.params.id)
      const { versionId, positionMs } = request.body
      const file = await downloadableFile(app.db, node.id)
      if (file.version_id !== versionId) throw versionChanged()
      await savePosition(app.db, { userId: auth.user.id, nodeId: node.id, versionId, positionMs })
      return reply.code(204).send()
    },
  )

  routes.delete('/files/:id/position', { schema: { params: byId } }, async (request, reply) => {
    const auth = requireAuth(request.auth)
    const node = await mediaNode(app.db, auth.user.id, request.params.id)
    await clearPosition(app.db, auth.user.id, node.id)
    return reply.code(204).send()
  })

  // Subtitles as WebVTT (§6.7): a subtitle file beside the video, by its ID.
  routes.get(
    '/files/:id/media/:versionId/subtitles/:track',
    {
      schema: {
        params: z.object({
          id: z.uuid(),
          versionId: z.uuid(),
          track: z
            .string()
            .regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.vtt$/i),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request.auth)
      const { id, versionId, track } = request.params
      const node = await mediaNode(app.db, auth.user.id, id)
      const file = await downloadableFile(app.db, node.id)
      if (file.version_id !== versionId) throw versionChanged()
      const vtt = await subtitleFileAsWebVtt(
        app,
        node,
        track.slice(0, -'.vtt'.length).toLowerCase(),
      )
      return reply
        .header('content-type', 'text/vtt; charset=utf-8')
        .header('cache-control', 'private, no-cache')
        .send(vtt)
    },
  )

  done()
}

/** One of the user's audio or video files, or a 404 or `422 not_media`. */
async function mediaNode(db: Executor, userId: string, id: string): Promise<NodeRow> {
  const node = await visibleNode(db, userId, id)
  if (node.kind !== 'file' || !mediaKind(node.name, node.mime_type)) {
    throw new ApiError(422, 'not_media', 'This file isn’t audio or video.')
  }
  return node
}

/**
 * `GET /internal/media/:versionId`: a version's plaintext, with Range, for
 * the media service, with the API's token for that version. On the API's
 * port but outside `/api`, so the edge never forwards it (§3.2).
 */
export function internalMediaRoutes(
  app: FastifyInstance,
  _options: object,
  done: () => void,
): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  routes.get(
    '/internal/media/:versionId',
    {
      config: { access: 'public' },
      schema: { params: z.object({ versionId: z.uuid() }) },
    },
    async (request, reply) => {
      const { versionId } = request.params
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
      if (!token || !(await mediaTokenValid(app.keys, versionId, token))) {
        throw new ApiError(401, 'invalid_token', 'This needs a token for this file.')
      }
      return sendFile(app, request, reply, await readableVersion(app.db, versionId))
    },
  )

  done()
}

/** What examining the version found: kept, or examined now. */
async function examined(
  app: FastifyInstance,
  file: Pick<DownloadableFile, 'version_id' | 'size_bytes'>,
): Promise<Examined> {
  if (file.size_bytes === 0) return { info: null, problem: 'It’s empty.' }
  // Kept, it is served even while the media service is away.
  const kept = await keptExamination(app.db, file.version_id)
  if (kept) return kept
  if (!app.media) {
    throw new ApiError(
      503,
      'media_unavailable',
      'Audio and video can’t be examined here: there is no media service.',
    )
  }
  try {
    return await app.media.examine(file.version_id)
  } catch (error) {
    if (!(error instanceof MediaUnavailableError)) throw error
    app.log.warn({ err: error, versionId: file.version_id }, 'could not examine a file')
    throw new ApiError(
      503,
      'media_unavailable',
      'The media service isn’t answering. Try again in a moment.',
    )
  }
}

/** A version that can be read, by its ID: uploaded, and not failed or purged. */
async function readableVersion(db: Executor, versionId: string): Promise<DownloadableFile> {
  const { rows } = await db.execute<DownloadableFile>(sql`
    SELECT node.name, node.mime_type,
      version.id AS version_id, version.size_bytes::float8 AS size_bytes, version.chunk_size,
      version.chunk_count, version.wrapped_dek, version.key_id
    FROM file_versions version JOIN nodes node ON node.id = version.node_id
    WHERE version.id = ${versionId} AND version.state IN ('syncing', 'stored')`)
  const [file] = rows
  if (!file) throw new ApiError(404, 'not_found', 'This file no longer exists.')
  return file
}
