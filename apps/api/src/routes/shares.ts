import {
  createShareSchema,
  publicShareSchema,
  shareCountInputSchema,
  shareCountSchema,
  shareLinkPageSchema,
  shareLinkSchema,
  sharedFolderPageSchema,
  unlockShareSchema,
  updateShareSchema,
} from '@dfs/shared'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../auth/access.ts'
import { archiveEntries } from '../content/archive.ts'
import { archiveQuery, requestedRange, sendFile, sendZip } from '../content/send.ts'
import {
  countDownload,
  describeShare,
  nodeInShare,
  openShare,
  sharedChildren,
  unlockShare,
} from '../shares/public.ts'
import {
  countShareLinks,
  createShare,
  listShares,
  deleteShare,
  updateShare,
} from '../shares/shares.ts'
import { assertOwnOrigin } from './auth.ts'
import { downloadableFile } from './content.ts'

const byId = z.object({ id: z.uuid() })
const byToken = z.object({ token: z.string().min(1).max(100) })
const noContent = { 204: z.null() }

/** Share links: the owner's side, and the public side under `/s/:token` (DESIGN.md §7.5, §9). */
export function shareRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const routes = app.withTypeProvider<ZodTypeProvider>()
  const open = { access: 'public' } as const

  // ── The owner's links ──────────────────────────────────────────────────────

  routes.get('/shares', { schema: { response: { 200: shareLinkPageSchema } } }, (request) =>
    listShares(app, requireAuth(request.auth)),
  )

  routes.post(
    '/shares/count',
    { schema: { body: shareCountInputSchema, response: { 200: shareCountSchema } } },
    (request) => countShareLinks(app, requireAuth(request.auth), request.body),
  )

  routes.post(
    '/shares',
    { schema: { body: createShareSchema, response: { 201: shareLinkSchema } } },
    async (request, reply) => {
      const share = await createShare(app, requireAuth(request.auth), request.body)
      return reply.code(201).send(share)
    },
  )

  routes.patch(
    '/shares/:id',
    { schema: { params: byId, body: updateShareSchema, response: { 200: shareLinkSchema } } },
    (request) => updateShare(app, requireAuth(request.auth), request.params.id, request.body),
  )

  routes.delete(
    '/shares/:id',
    { schema: { params: byId, response: noContent } },
    async (request, reply) => {
      await deleteShare(app, requireAuth(request.auth), request.params.id)
      return reply.code(204).send(null)
    },
  )

  // ── Public access: no session, so no CSRF token ────────────────────────────

  routes.get(
    '/s/:token',
    { config: open, schema: { params: byToken, response: { 200: publicShareSchema } } },
    (request) => describeShare(app, request, request.params.token),
  )

  routes.post(
    '/s/:token/unlock',
    { config: open, schema: { params: byToken, body: unlockShareSchema, response: noContent } },
    async (request, reply) => {
      assertOwnOrigin(app, request)
      await unlockShare(app, request, reply, request.params.token, request.body.password)
      return reply.code(204).send(null)
    },
  )

  routes.get(
    '/s/:token/children',
    {
      config: open,
      schema: {
        params: byToken,
        querystring: z.object({
          parentId: z.uuid().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: sharedFolderPageSchema },
      },
    },
    async (request) => {
      const { root } = await openShare(app, request, request.params.token)
      const { parentId, cursor, limit } = request.query
      return sharedChildren(app, root, parentId, cursor, limit)
    },
  )

  routes.get(
    '/s/:token/files/:id/content',
    { config: open, schema: { params: byToken.extend({ id: z.uuid() }) } },
    async (request, reply) => {
      const { share, root } = await openShare(app, request, request.params.token)
      const node = await nodeInShare(app, root, request.params.id)
      // A file link serves its own version, which may be an earlier one.
      const file = await downloadableFile(
        app.db,
        node.id,
        node.id === root.id ? share.version_id : null,
      )
      // Only a request from byte 0 is a download; seeking in a video isn't (§7.5).
      const range = requestedRange(request, file)
      if (
        request.method !== 'HEAD' &&
        (range === null || (range !== 'unsatisfiable' && range.start === 0))
      )
        await countDownload(app, share)
      return sendFile(app, request, reply, file)
    },
  )

  routes.get(
    '/s/:token/archive',
    {
      config: open,
      schema: {
        params: byToken,
        querystring: archiveQuery.extend({ nodeId: z.uuid().optional() }),
      },
    },
    async (request, reply) => {
      const { share, root } = await openShare(app, request, request.params.token)
      const node = request.query.nodeId ? await nodeInShare(app, root, request.query.nodeId) : root
      const entries = await archiveEntries(app, [node])
      // A ZIP counts as one download (§7.5).
      if (request.method !== 'HEAD') await countDownload(app, share)
      return sendZip(reply, `${node.name}.zip`, entries, request.query.tz)
    },
  )

  done()
}
