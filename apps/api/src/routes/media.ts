import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Executor } from '@dfs/db'
import {
  audioQueueSchema,
  coverType,
  fileMediaSchema,
  deliverySchema,
  isTextSubtitles,
  MAX_CONNECTION_TEST_BYTES,
  mediaKind,
  playbackReportSchema,
  playbackSchema,
  savePositionSchema,
  type MediaInfo,
  type MetricName,
  type PlaybackReport,
} from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import type { RateLimiter } from '../auth/rate-limit.ts'
import { linkReader } from '../content/deliveries.ts'
import { paced, sendFile, type DownloadableFile } from '../content/send.ts'
import { ApiError } from '../errors.ts'
import { audioQueue, coverBeside } from '../media/audio.ts'
import { keptExamination, MediaUnavailableError, type Examined } from '../media/examine.ts'
import {
  clearPosition,
  savedPosition,
  savePosition,
  subtitleFileAsWebVtt,
  subtitleFilesBeside,
} from '../media/playback.ts'
import { keptSubtitles } from '../media/subtitles.ts'
import { mediaTokenValid } from '../media/token.ts'
import { visibleFolder, visibleNode, type NodeRow } from '../nodes/read.ts'
import { nodeInShare, openShare } from '../shares/public.ts'
import { assertOwnOrigin } from './auth.ts'
import { downloadableFile, versionChanged } from './content.ts'

// Audio and video (DESIGN.md §6.7, §9, §10.4): what a file holds, what a
// player needs to start, where each user stopped and subtitles, for the players,
// and the plaintext of a version for the media service, which examines it.

const byId = z.object({ id: z.uuid() })
const byToken = z.object({ token: z.string().min(1).max(100) })

/**
 * Where a player finds a file (§10.4): in the drive, or through a share link,
 * whose viewers have no session. The same routes under both; a link's go
 * through its own checks first (§7.5).
 */
const PLACES = [
  { path: '/files/:id', config: {} },
  { path: '/s/:token/files/:id', config: { access: 'public' } },
] as const
/** A file's place: a token only under a link. */
const fileParams = z.object({ token: byToken.shape.token.optional(), id: z.uuid() })

/** `?deep=1`: a folder's audio and everything below it. */
const deepQuery = z.object({ deep: z.literal('1').optional() })

const connectionTestQuery = z.object({
  bytes: z.coerce.number().int().min(1).max(MAX_CONNECTION_TEST_BYTES),
})

export function mediaRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  /** Connection tests running, by whose they are: a user's, or an address's. */
  const testing = new Set<string>()

  for (const place of PLACES) {
    routes.get(
      `${place.path}/media`,
      { config: place.config, schema: { params: fileParams, response: { 200: fileMediaSchema } } },
      async (request) => {
        const file = await servedVersion(app.db, await playedFile(app, request, request.params))
        return { versionId: file.version_id, ...(await examined(app, file)) }
      },
    )

    // What a player needs to start, from the database alone (§10.4).
    routes.get(
      `${place.path}/playback`,
      { config: place.config, schema: { params: fileParams, response: { 200: playbackSchema } } },
      async (request) => {
        const played = await playedFile(app, request, request.params)
        const file = await servedVersion(app.db, played)
        const { userId, node } = played
        const [positionMs, subtitleFiles] = await Promise.all([
          userId === null ? null : savedPosition(app.db, userId, node.id, file.version_id),
          played.besideOffered ? subtitleFilesBeside(app.db, node) : [],
        ])
        return { versionId: file.version_id, positionMs, subtitleFiles }
      },
    )

    // How fast this viewer's reads of the version go: for the player's warning (§10.4).
    routes.get(
      `${place.path}/media/:versionId/delivery`,
      {
        config: place.config,
        schema: {
          params: fileParams.extend({ versionId: z.uuid() }),
          response: { 200: deliverySchema },
        },
      },
      async (request) => {
        const played = await playedFile(app, request, request.params)
        return app.deliveries.totals(played.readerId, request.params.versionId)
      },
    )

    // How a play went, as the player saw it (§10.4, §16): logged, with its times on the graphs.
    routes.post(
      `${place.path}/playback-report`,
      { config: place.config, schema: { params: fileParams, body: playbackReportSchema } },
      async (request, reply) => {
        if (request.params.token !== undefined) {
          // No session, so no CSRF token: from DFS's own page, and a few per address.
          assertOwnOrigin(app, request)
          withinLimit(app.limits.linkPlayReports, `address:${request.ip}`, 'Too many reports.')
        }
        const played = await playedFile(app, request, request.params)
        const report = request.body
        // Only a version of this file: any other's formats stay out of the log.
        const kept = (await isVersionOf(app.db, played.node.id, report.versionId))
          ? await keptExamination(app.db, report.versionId)
          : null
        request.log.info(
          {
            play: {
              ...report,
              nodeId: played.node.id,
              ...(played.shareId !== null && { shareId: played.shareId }),
              video: kept?.info ? summary(kept.info) : null,
              userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
            },
          },
          'video play reported',
        )
        recordPlay(app, report)
        return reply.code(204).send()
      },
    )

    // An audio file's cover (§6.7): the picture in its tags, else one beside it.
    routes.get(
      `${place.path}/media/:versionId/cover`,
      {
        config: place.config,
        schema: { params: fileParams.extend({ versionId: z.uuid() }) },
      },
      async (request, reply) => {
        const played = await playedFile(app, request, request.params)
        const file = await servedVersion(app.db, played)
        if (file.version_id !== request.params.versionId) throw versionChanged()
        const inside = await coverInside(app, file.version_id)
        if (inside) {
          // The version never changes, so the browser keeps it: the server keeps nothing.
          return reply
            .header('content-type', inside.type)
            .header('cache-control', 'private, max-age=31536000, immutable')
            .header('x-content-type-options', 'nosniff')
            .send(inside.bytes)
        }
        const beside = played.besideOffered ? await coverBeside(app.db, played.node) : null
        if (!beside) throw new ApiError(404, 'not_found', 'This file has no cover.')
        return sendFile(app, request, reply, { ...beside, mime_type: imageType(beside.name) })
      },
    )

    // Subtitles as WebVTT (§6.7): a stream inside the file by its number, or a
    // subtitle file beside it by its ID.
    routes.get(
      `${place.path}/media/:versionId/subtitles/:track`,
      {
        config: place.config,
        schema: {
          params: fileParams.extend({
            versionId: z.uuid(),
            track: z
              .string()
              .regex(/^(?:\d{1,5}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.vtt$/i),
          }),
        },
      },
      async (request, reply) => {
        const track = request.params.track.slice(0, -'.vtt'.length).toLowerCase()
        const played = await playedFile(app, request, request.params)
        const file = await servedVersion(app.db, played)
        if (file.version_id !== request.params.versionId) throw versionChanged()
        const inside = /^\d+$/.test(track)
        if (!inside && !played.besideOffered) throw noSuchSubtitles()
        const vtt = inside
          ? await streamSubtitles(app, file, Number(track))
          : await subtitleFileAsWebVtt(app, played.node, track)
        return (
          reply
            .header('content-type', 'text/vtt; charset=utf-8')
            // Inside the version, which never changes, the browser keeps them; beside it, they may change.
            .header(
              'cache-control',
              inside ? 'private, max-age=31536000, immutable' : 'private, no-cache',
            )
            .send(vtt)
        )
      },
    )
  }

  // A folder's audio files for the bar's queue, or everything below it (§10.4).
  routes.get(
    '/folders/:id/audio',
    { schema: { params: byId, querystring: deepQuery, response: { 200: audioQueueSchema } } },
    async (request) => {
      const auth = requireAuth(request.auth)
      const folder = await visibleFolder(app.db, auth.user.id, request.params.id)
      return audioQueue(app.db, folder.id, request.query.deep === '1')
    },
  )

  routes.get(
    '/s/:token/audio',
    {
      config: { access: 'public' },
      schema: {
        params: byToken,
        querystring: deepQuery.extend({ folderId: z.uuid().optional() }),
        response: { 200: audioQueueSchema },
      },
    },
    async (request) => {
      const { root } = await openShare(app, request, request.params.token)
      const { folderId, deep } = request.query
      const folder = folderId ? await nodeInShare(app, root, folderId) : root
      if (folder.kind !== 'folder') {
        throw new ApiError(404, 'not_found', 'This folder no longer exists.')
      }
      return audioQueue(app.db, folder.id, deep === '1')
    },
  )

  // Where a user stopped, on the server for a drive's file. A link's viewers
  // have no account, and keep theirs in the browser (§10.4).
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

  // Bytes from the VPS itself, not from Discord: how fast this device's
  // connection to the server is, for telling a slow network from a slow file
  // (§10.4). A user's, and a link viewer's, by their address.
  routes.get(
    '/connection-test',
    { schema: { querystring: connectionTestQuery } },
    (request, reply) => {
      const key = `user:${requireAuth(request.auth).user.id}`
      return sendConnectionTest(app, request, reply, testing, key, {})
    },
  )

  routes.get(
    '/s/:token/connection-test',
    { config: { access: 'public' }, schema: { params: byToken, querystring: connectionTestQuery } },
    async (request, reply) => {
      const { share } = await openShare(app, request, request.params.token)
      return sendConnectionTest(app, request, reply, testing, `address:${request.ip}`, {
        shareId: share.id,
      })
    },
  )

  done()
}

/** What a player plays (§10.4): a user's file, or one a share link reaches. */
interface Played {
  node: NodeRow
  /** A file link's version, which it serves however the file changes (§7.5); `null` for the current one. */
  pinnedVersionId: string | null
  /** Whose reads the delivery figures follow (`Deliveries`): a user's, or a link viewer's. */
  readerId: string
  /** The user, whose positions the server keeps; `null` through a link. */
  userId: string | null
  /** The link it is played through, for the log. */
  shareId: string | null
  /**
   * Subtitle files beside it may be offered: in the drive, and in a shared
   * folder, but not through a file link, which shares that file alone.
   */
  besideOffered: boolean
}

/** The file a player's route names: the user's, or, under a token, one the link reaches. */
async function playedFile(
  app: FastifyInstance,
  request: FastifyRequest,
  { token, id }: { token?: string | undefined; id: string },
): Promise<Played> {
  if (token === undefined) {
    const auth = requireAuth(request.auth)
    return {
      node: await mediaNode(app.db, auth.user.id, id),
      pinnedVersionId: null,
      readerId: auth.user.id,
      userId: auth.user.id,
      shareId: null,
      besideOffered: true,
    }
  }
  const { share, root } = await openShare(app, request, token)
  const node = asMedia(await nodeInShare(app, root, id))
  return {
    node,
    pinnedVersionId: node.id === root.id ? share.version_id : null,
    readerId: linkReader(share.id, request.ip),
    userId: null,
    shareId: share.id,
    besideOffered: root.kind === 'folder',
  }
}

/** The version a player is given: a file link's own, or the file's current one. */
function servedVersion(db: Executor, played: Played): Promise<DownloadableFile> {
  return downloadableFile(db, played.node.id, played.pinnedVersionId)
}

/**
 * Sends random bytes for a connection test, a user's or a link viewer's
 * (`key`): bandwidth for nothing but measuring, so one at a time and a few
 * in ten minutes. Random, so nothing on the way compresses them, and logged.
 */
function sendConnectionTest(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: z.infer<typeof connectionTestQuery> }>,
  reply: FastifyReply,
  testing: Set<string>,
  key: string,
  logged: { shareId?: string },
): FastifyReply {
  const busy = 'A connection test is running, or ran just now.'
  if (testing.has(key)) throw new ApiError(429, 'rate_limited', busy, { 'retry-after': '1' })
  withinLimit(app.limits.connectionTests, key, busy)
  testing.add(key)
  const { bytes } = request.query
  const stats = {
    startedAt: performance.now(),
    bytes: 0,
    firstPieceMs: null,
    sourceMs: 0,
    clientMs: 0,
  }
  reply.raw.once('close', () => {
    testing.delete(key)
    const ms = performance.now() - stats.startedAt
    request.log.info(
      {
        connectionTest: {
          ...logged,
          bytes: stats.bytes,
          finished: reply.raw.writableFinished,
          totalMs: Math.round(ms),
          mbitPerSecond: ms > 0 ? Math.round((stats.bytes * 8) / ms / 100) / 10 : null,
          userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
        },
      },
      'connection tested',
    )
  })
  return reply
    .header('content-type', 'application/octet-stream')
    .header('content-length', String(bytes))
    .header('cache-control', 'no-store')
    .send(Readable.from(paced(reply.raw, randomPieces(bytes), stats)))
}

/**
 * The picture in an audio version's tags, as the media info kept for it says
 * there is one, if it is one every browser draws; `null` otherwise. A `503`
 * while the media service can't say.
 */
async function coverInside(
  app: FastifyInstance,
  versionId: string,
): Promise<{ bytes: Buffer; type: string } | null> {
  const kept = await keptExamination(app.db, versionId)
  if (!kept?.info?.hasCover) return null
  if (!app.media) throw coverUnavailable('there is no media service')
  try {
    const bytes = await app.media.cover(versionId)
    const type = bytes && coverType(bytes)
    return bytes && type ? { bytes, type } : null
  } catch (error) {
    if (!(error instanceof MediaUnavailableError)) throw error
    app.log.warn({ err: error, versionId }, 'could not read a cover')
    throw coverUnavailable('the media service isn’t answering')
  }
}

function coverUnavailable(why: string): ApiError {
  return new ApiError(
    503,
    'media_unavailable',
    `This cover can’t be read now: ${why}. Try again in a moment.`,
  )
}

/** A cover file's type, by its name, which `coverFileRank` has checked. */
function imageType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

/** Counts one against `key`, or refuses with `429` while it is over its limit. */
function withinLimit(limiter: RateLimiter, key: string, message: string): void {
  const wait = limiter.waitMs(key)
  if (wait > 0) {
    throw new ApiError(429, 'rate_limited', message, {
      'retry-after': String(Math.ceil(wait / 1000)),
    })
  }
  limiter.hit(key)
}

/** `total` random bytes, in pieces as large as a file's: a block made once, sent again and again. */
async function* randomPieces(total: number): AsyncGenerator<Uint8Array> {
  const block = randomBytes(256 * 1024)
  for (let sent = 0; sent < total; sent += block.length) {
    yield block.subarray(0, Math.min(block.length, total - sent))
    // A turn of the event loop, as reading a file takes.
    await Promise.resolve()
  }
}

/** A play on the graphs (§16): how it ended, and its times. */
function recordPlay(app: FastifyInstance, report: PlaybackReport): void {
  app.metrics.record(PLAY_OUTCOMES[report.outcome])
  if (report.firstFrameMs !== null) app.metrics.time('player.first_frame_ms', report.firstFrameMs)
  if (report.stalls > 0) app.metrics.record('player.stall_ms', report.stallMs)
}

/** Each way a play ends, as its counter. */
const PLAY_OUTCOMES = {
  played: 'player.plays',
  failed: 'player.failures',
  left: 'player.left',
} as const satisfies Record<PlaybackReport['outcome'], MetricName>

/** A video in a few words, for a play's log line: `av1 3840x2160 59.94fps pq, 24.3 Mbit/s`. */
function summary(info: MediaInfo): string {
  const video = info.streams.find((stream) => stream.type === 'video')
  const audio = info.streams.find((stream) => stream.type === 'audio')
  const picture = video
    ? `${video.codec} ${String(video.width)}x${String(video.height)} ${String(video.frameRate)}fps${video.hdr ? ` ${video.hdr}` : ''}`
    : 'no video'
  const rate = info.bitRate ? `, ${String(Math.round(info.bitRate / 100_000) / 10)} Mbit/s` : ''
  return `${info.container}: ${picture}${audio ? `, ${audio.codec}` : ''}${rate}`
}

/** Whether the version is one of the file's, kept or not. */
async function isVersionOf(db: Executor, nodeId: string, versionId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    SELECT 1 FROM file_versions WHERE id = ${versionId} AND node_id = ${nodeId}`)
  return rows.length > 0
}

/** One of the user's audio or video files, or a 404 or `422 not_media`. */
async function mediaNode(db: Executor, userId: string, id: string): Promise<NodeRow> {
  return asMedia(await visibleNode(db, userId, id))
}

/** The node, if it is an audio or video file; otherwise `422 not_media`. */
function asMedia(node: NodeRow): NodeRow {
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

/**
 * A text subtitle stream inside the version, as WebVTT: kept, or extracted
 * now, which may read the whole file. Served even while the media service is
 * away, once kept.
 */
async function streamSubtitles(
  app: FastifyInstance,
  file: Pick<DownloadableFile, 'version_id' | 'size_bytes'>,
  streamIndex: number,
): Promise<string> {
  const { info } = await examined(app, file)
  const stream = info?.streams.find((found) => found.index === streamIndex)
  if (!info || !stream || !isTextSubtitles(stream)) throw noSuchSubtitles()
  let kept = await keptSubtitles(app.db, app.keys, file.version_id, streamIndex)
  if (!kept) {
    if (!app.media) throw mediaUnavailable('there is no media service')
    try {
      kept = await app.media.subtitles(file.version_id, info, streamIndex)
    } catch (error) {
      if (!(error instanceof MediaUnavailableError)) throw error
      app.log.warn({ err: error, versionId: file.version_id }, 'could not extract subtitles')
      throw mediaUnavailable('the media service isn’t answering')
    }
  }
  if ('problem' in kept) {
    throw new ApiError(422, 'unreadable_subtitles', 'These subtitles can’t be read.')
  }
  return kept.vtt
}

function noSuchSubtitles(): ApiError {
  return new ApiError(404, 'not_found', 'There are no such subtitles.')
}

function mediaUnavailable(why: string): ApiError {
  return new ApiError(
    503,
    'media_unavailable',
    `These subtitles can’t be read now: ${why}. Try again in a moment.`,
  )
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
