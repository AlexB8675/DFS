import { archiveTicketSchema, nodeIdsSchema } from '@dfs/shared'
import type { Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import { archiveEntries, createArchiveTicket, redeemArchiveTicket } from '../content/archive.ts'
import {
  archiveQuery,
  cancellation,
  sendFile,
  sendZip,
  type DownloadableFile,
} from '../content/send.ts'
import { ApiError } from '../errors.ts'
import { visibleFolder, visibleNode } from '../nodes/read.ts'

const byId = z.object({ id: z.uuid() })

/** Downloads: files with Range, folders and selections as ZIPs (DESIGN.md §6.2, §9). */
export function contentRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()

  routes.get(
    '/files/:id/content',
    { schema: { params: byId, querystring: z.object({ version: z.uuid().optional() }) } },
    async (request, reply) => {
      const auth = requireAuth(request.auth)
      await visibleNode(app.db, auth.user.id, request.params.id)
      const file = await downloadableFile(app.db, request.params.id)
      // A player names the version it plays, so a replaced file never mixes with it (§10.4).
      const { version } = request.query
      if (version && version !== file.version_id) throw versionChanged()
      return sendFile(app, request, reply, file, auth.user.id)
    },
  )

  routes.get(
    '/folders/:id/archive',
    { schema: { params: byId, querystring: archiveQuery } },
    async (request, reply) => {
      const auth = requireAuth(request.auth)
      const folder = await visibleFolder(app.db, auth.user.id, request.params.id)
      const entries = await archiveEntries(app, [folder], cancellation(reply.raw))
      return sendZip(reply, `${folder.name}.zip`, entries, request.query.tz)
    },
  )

  routes.post(
    '/archive',
    { schema: { body: nodeIdsSchema, response: { 201: archiveTicketSchema } } },
    async (request, reply) => {
      const ticket = await createArchiveTicket(app, requireAuth(request.auth), request.body.ids)
      return reply.code(201).send(ticket)
    },
  )

  routes.get(
    '/archive/:token',
    {
      schema: { params: z.object({ token: z.string().max(100) }), querystring: archiveQuery },
    },
    async (request, reply) => {
      const { fileName, nodes } = await redeemArchiveTicket(
        app,
        requireAuth(request.auth),
        request.params.token,
      )
      const entries = await archiveEntries(app, nodes, cancellation(reply.raw))
      return sendZip(reply, fileName, entries, request.query.tz)
    },
  )

  done()
}

/** The version a player named is no longer the file's (§10.4). */
export function versionChanged(): ApiError {
  return new ApiError(412, 'version_changed', 'This file has been replaced since.')
}

/**
 * A file's current version, or the one given (a file link's, §7.5), if it
 * can be read: uploaded, and not failed.
 */
export async function downloadableFile(
  db: Executor,
  nodeId: string,
  versionId: string | null = null,
): Promise<DownloadableFile> {
  const { rows } = await db.execute<DownloadableFile & { state: string | null; kind: string }>(sql`
    SELECT node.name, node.mime_type, node.kind, version.state::text AS state,
      version.id AS version_id, version.size_bytes::float8 AS size_bytes, version.chunk_size,
      version.chunk_count, version.wrapped_dek, version.key_id
    FROM nodes node LEFT JOIN file_versions version
      ON version.id = coalesce(${versionId}::uuid, node.current_version_id)
        AND version.node_id = node.id
    WHERE node.id = ${nodeId}`)
  const [file] = rows
  if (file?.kind !== 'file') throw new ApiError(404, 'not_found', 'This item no longer exists.')
  if (file.state !== 'syncing' && file.state !== 'stored') {
    throw new ApiError(409, 'not_ready', 'This file hasn’t finished uploading.')
  }
  return file
}
