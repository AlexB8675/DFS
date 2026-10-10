import {
  aliveUploadsSchema,
  changePasswordSchema,
  createChannelSchema,
  createFolderSchema,
  createShareSchema,
  completeUploadSchema,
  createUploadBatchSchema,
  createUploadSchema,
  createUserSchema,
  ensureFoldersSchema,
  adminTaskRequestSchema,
  auditQuerySchema,
  loginSchema,
  passwordResetRequestSchema,
  lookupNodesSchema,
  metricsQuerySchema,
  moderationSchema,
  moveNodesSchema,
  nodeIdsSchema,
  nodeKindSchema,
  MAX_CONNECTION_TEST_BYTES,
  playbackReportSchema,
  resetPasswordSchema,
  savePositionSchema,
  sortFieldSchema,
  sortOrderSchema,
  streamLinkRequestSchema,
  unlockShareSchema,
  updateChannelSchema,
  updateNodeSchema,
  updateShareSchema,
  updateUserSchema,
  shareCountInputSchema,
  adminShareQuerySchema,
} from '@dfs/shared'
import { delay, http, HttpResponse, sse, type JsonBodyType } from 'msw'
import { z, ZodError } from 'zod'
import { AdminMockDb, MOCK_RELEASE } from './admin-db'
import { MockApiError, type MockEvent, type MockFileContent, type MockPlace } from './db'
import { MOCK_RESPONSE_HEADER } from './marker'
import { DEMO_ACCOUNTS } from './seed'

// Mocks the HTTP API of DESIGN.md §9 on top of the in-memory database.

export const db = new AdminMockDb()

/** A realistic delay before each answer; the contract suite turns it off for speed. */
let responseDelay = true
/**
 * Connection tests running, a user's and this browser's through links: the
 * API allows each one at a time (§10.4), a link viewer's by their address.
 */
const connectionTests = new Set<'user' | 'address'>()

export function setResponseDelay(enabled: boolean): void {
  responseDelay = enabled
}

/** The real API pings every 25 s so clients notice dead connections (§6.1). */
const PING_INTERVAL_MS = 25_000

interface Id {
  id: string
}

interface Token {
  token: string
}

/** A file's place in a player's route: a token only under a link. */
interface Place {
  token?: string
  id: string
}

/** Where the players find a file (§10.4): the drive, or a share link, with no session. */
const PLAYER_PLACES = [
  { path: '/api/files/:id', options: {} },
  { path: '/api/s/:token/files/:id', options: { public: true } },
] as const

function placeOf(params: Place): MockPlace {
  return { token: params.token ?? null, id: params.id }
}

const listQuery = z.object({
  kind: nodeKindSchema.optional(),
  sort: sortFieldSchema.default('name'),
  order: sortOrderSchema.default('asc'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

const shareListQuery = z.object({
  parentId: z.uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

const pageQuery = z.object({
  q: z.string().default(''),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export const handlers = [
  // ── Auth (§7.1) ────────────────────────────────────────────────────────────
  // A session opened with a temporary password reaches only these three
  // routes until it chooses a new password (`limited`).
  http.get('/api/auth/me', ({ request }) =>
    respond(request, () => db.session(), { limited: true }),
  ),
  http.post('/api/auth/logout', ({ request }) =>
    respondEmpty(
      request,
      () => {
        db.signOut()
      },
      { limited: true },
    ),
  ),
  http.post('/api/auth/password', ({ request }) =>
    respond(
      request,
      async () => db.changePassword(changePasswordSchema.parse(await request.json())),
      {
        limited: true,
      },
    ),
  ),
  // No session yet, so no CSRF token: the real API checks `Origin` instead.
  http.post('/api/auth/login', ({ request }) =>
    respond(request, async () => db.signIn(loginSchema.parse(await request.json())), {
      public: true,
    }),
  ),
  http.get('/api/version', ({ request }) => respond(request, () => MOCK_RELEASE, { public: true })),
  http.post('/api/auth/password-reset', ({ request }) =>
    respondEmpty(
      request,
      async () => {
        db.requestPasswordReset(passwordResetRequestSchema.parse(await request.json()))
      },
      { public: true },
    ),
  ),
  // Mock only: the demo sign-ins the login page offers.
  http.get('/api/dev/accounts', ({ request }) =>
    respond(request, () => DEMO_ACCOUNTS, { public: true }),
  ),
  http.post('/api/dev/reset', ({ request }) =>
    respondEmpty(
      request,
      () => {
        db.reset()
      },
      { public: true },
    ),
  ),

  // ── Browse ─────────────────────────────────────────────────────────────────
  http.get<Id>('/api/nodes/:id', ({ request, params }) =>
    respond(request, () => db.node(params.id)),
  ),
  http.post('/api/nodes/lookup', ({ request }) =>
    respond(request, async () => ({
      items: db.lookupNodes(lookupNodesSchema.parse(await request.json()).ids),
    })),
  ),
  http.get<Id>('/api/nodes/:id/path', ({ request, params }) =>
    respond(request, () => db.path(params.id)),
  ),
  http.get<Id>('/api/nodes/:id/children', ({ request, params }) =>
    respond(request, () => db.children(params.id, readQuery(request, listQuery))),
  ),

  // ── Folders and node changes ───────────────────────────────────────────────
  http.post('/api/folders', ({ request }) =>
    respond(
      request,
      async () => {
        const input = createFolderSchema.parse(await request.json())
        return db.createFolder(input.parentId, input.name)
      },
      { status: 201 },
    ),
  ),
  http.post('/api/folders/ensure', ({ request }) =>
    respond(request, async () => {
      const input = ensureFoldersSchema.parse(await request.json())
      return db.ensureFolders(input.parentId, input.paths)
    }),
  ),
  http.patch<Id>('/api/nodes/:id', ({ request, params }) =>
    respond(request, async () =>
      db.update(params.id, updateNodeSchema.parse(await request.json())),
    ),
  ),
  http.post('/api/nodes/move', ({ request }) =>
    respondEmpty(request, async () => {
      const input = moveNodesSchema.parse(await request.json())
      db.move(input.ids, input.parentId)
    }),
  ),
  http.post('/api/nodes/trash', ({ request }) =>
    respondEmpty(request, async () => {
      db.trash(nodeIdsSchema.parse(await request.json()).ids)
    }),
  ),
  http.delete<Id>('/api/nodes/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.trash([params.id])
    }),
  ),
  http.post<Id>('/api/nodes/:id/restore', ({ request, params }) =>
    respond(request, () => db.restore(params.id)),
  ),

  // ── Trash ──────────────────────────────────────────────────────────────────
  http.get('/api/trash', ({ request }) =>
    respond(request, () => {
      const query = readQuery(request, pageQuery)
      // The server's default TRASH_RETENTION_DAYS.
      return { ...db.trashItems(query.cursor ?? null, query.limit), retentionDays: 30 }
    }),
  ),
  http.delete('/api/trash', ({ request }) =>
    respondEmpty(request, () => {
      db.emptyTrash()
    }),
  ),
  http.delete<Id>('/api/trash/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.deleteForever(params.id)
    }),
  ),

  // ── Search ─────────────────────────────────────────────────────────────────
  http.get('/api/search', ({ request }) =>
    respond(request, () => {
      const query = readQuery(request, pageQuery)
      return db.search(query.q, query.cursor ?? null, query.limit)
    }),
  ),

  // ── Uploads (§6.1) ─────────────────────────────────────────────────────────
  http.post('/api/uploads/batch', ({ request }) =>
    respond(
      request,
      async () => {
        const input = createUploadBatchSchema.parse(await request.json())
        return { results: db.createUploads(input.uploads) }
      },
      { status: 201 },
    ),
  ),
  // The mock keeps uploads while it runs: there is no janitor to tell.
  http.post('/api/uploads/alive', ({ request }) =>
    respondEmpty(request, async () => {
      aliveUploadsSchema.parse(await request.json())
    }),
  ),
  http.get<Id>('/api/uploads/:id', ({ request, params }) =>
    respond(request, () => db.uploadStatus(params.id)),
  ),
  http.post('/api/uploads', ({ request }) =>
    respond(
      request,
      async () => {
        const input = createUploadSchema.parse(await request.json())
        return db.createUpload(
          input.parentId,
          input.name,
          input.sizeBytes,
          input.mimeType,
          input.modifiedAt,
          input.ifExists,
        )
      },
      { status: 201 },
    ),
  ),
  http.put<{ id: string; index: string }>('/api/uploads/:id/parts/:index', ({ request, params }) =>
    respondEmpty(request, async () => {
      const body = await request.arrayBuffer()
      await db.receivePart(
        params.id,
        Number(params.index),
        body,
        request.headers.get('X-Part-SHA256'),
      )
    }),
  ),
  http.put<Id>('/api/uploads/:id/content', ({ request, params }) =>
    respondEmpty(request, async () => {
      const from = Number(new URL(request.url).searchParams.get('from') ?? 0)
      await db.receiveStream(params.id, from, await request.arrayBuffer())
    }),
  ),
  http.post<Id>('/api/uploads/:id/complete', ({ request, params }) =>
    respondEmpty(request, async () => {
      const text = await request.text()
      const input = completeUploadSchema.parse(text ? JSON.parse(text) : {})
      db.completeUpload(params.id, input.partSha256)
    }),
  ),
  http.delete<Id>('/api/uploads/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.cancelUpload(params.id)
    }),
  ),

  // ── Content ────────────────────────────────────────────────────────────────
  http.get<Id>('/api/files/:id/content', ({ request, params }) =>
    respond(request, async () => {
      const version = new URL(request.url).searchParams.get('version')
      const response = fileResponse(request, db.fileContent(params.id, version))
      if (version) await recordDelivery({ token: null, id: params.id }, version, response)
      return response
    }),
  ),
  http.get('/api/connection-test', ({ request }) =>
    respond(request, () => connectionTest(request, 'user')),
  ),

  // ── Audio and video (§6.7, §10.4): the drive's, and a link's alike ─────────
  ...PLAYER_PLACES.flatMap(({ path, options }) => [
    http.get<Place>(`${path}/media`, ({ request, params }) =>
      respond(request, () => db.media(placeOf(params)), options),
    ),
    http.get<Place>(`${path}/playback`, ({ request, params }) =>
      respond(request, () => db.playback(placeOf(params)), options),
    ),
    http.get<Place & { versionId: string }>(
      `${path}/media/:versionId/delivery`,
      ({ request, params }) =>
        respond(request, () => db.delivery(placeOf(params), params.versionId), options),
    ),
    http.post<Place>(`${path}/stream-link`, ({ request, params }) =>
      respond(
        request,
        async () => {
          const { create } = streamLinkRequestSchema.parse(await request.json())
          const { link, created } = db.streamLink(placeOf(params), create)
          return Response.json(link, { status: created ? 201 : 200 })
        },
        options,
      ),
    ),
    http.post<Place>(`${path}/playback-report`, ({ request, params }) =>
      respondEmpty(
        request,
        async () => {
          // Checked as the API checks it, and then forgotten: the mock keeps no logs.
          playbackReportSchema.parse(await request.json())
          db.media(placeOf(params))
        },
        options,
      ),
    ),
    http.get<Place & { versionId: string }>(
      `${path}/media/:versionId/cover`,
      ({ request, params }) =>
        respond(
          request,
          () => {
            const cover = db.cover(placeOf(params), params.versionId)
            return new HttpResponse(cover.body.slice(), {
              headers: { 'Content-Type': cover.type, 'Cache-Control': 'private, no-cache' },
            })
          },
          options,
        ),
    ),
    http.get<Place & { versionId: string; track: string }>(
      `${path}/media/:versionId/subtitles/:track`,
      ({ request, params }) =>
        respond(
          request,
          () =>
            new HttpResponse(db.subtitles(placeOf(params), params.versionId, params.track), {
              headers: {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Cache-Control': 'private, no-cache',
              },
            }),
          options,
        ),
    ),
  ]),
  http.get<Id>('/api/folders/:id/audio', ({ request, params }) =>
    respond(request, () =>
      db.audioQueue(params.id, new URL(request.url).searchParams.get('deep') === '1'),
    ),
  ),
  http.get<Token>('/api/s/:token/audio', ({ request, params }) =>
    respond(
      request,
      () => {
        const query = new URL(request.url).searchParams
        return db.shareAudioQueue(params.token, query.get('folderId'), query.get('deep') === '1')
      },
      { public: true },
    ),
  ),
  // Where a user stopped: a link's viewers keep theirs in the browser.
  http.put<Id>('/api/files/:id/position', ({ request, params }) =>
    respondEmpty(request, async () => {
      db.savePosition(params.id, savePositionSchema.parse(await request.json()))
    }),
  ),
  http.delete<Id>('/api/files/:id/position', ({ request, params }) =>
    respondEmpty(request, () => {
      db.clearPosition(params.id)
    }),
  ),

  // ── Archives (§6.2) ────────────────────────────────────────────────────────
  http.get<Id>('/api/folders/:id/archive', ({ request, params }) =>
    respond(request, () => {
      const archive = db.folderArchive(params.id)
      return zipResponse(archive.body, archive.name)
    }),
  ),
  http.post('/api/archive', ({ request }) =>
    respond(
      request,
      async () => db.createArchiveTicket(nodeIdsSchema.parse(await request.json()).ids),
      { status: 201 },
    ),
  ),
  http.get<{ token: string }>('/api/archive/:token', ({ request, params }) =>
    respond(request, () => zipResponse(db.takeArchive(params.token), 'download.zip')),
  ),

  // ── Admin (§9) ─────────────────────────────────────────────────────────────
  http.get('/api/admin/users', ({ request }) => respond(request, () => db.adminUsers())),
  http.post('/api/admin/users', ({ request }) =>
    respond(request, async () => db.createUser(createUserSchema.parse(await request.json())), {
      status: 201,
    }),
  ),
  http.post<Id>('/api/admin/users/:id/password', ({ request, params }) =>
    respond(request, async () =>
      db.resetPassword(params.id, resetPasswordSchema.parse(await request.json())),
    ),
  ),
  http.patch<Id>('/api/admin/users/:id', ({ request, params }) =>
    respond(request, async () =>
      db.updateUser(params.id, updateUserSchema.parse(await request.json())),
    ),
  ),
  http.get<Id>('/api/admin/users/:id/usage', ({ request, params }) =>
    respond(request, () => db.userUsage(params.id)),
  ),
  http.get<Id>('/api/admin/nodes/:id', ({ request, params }) =>
    respond(request, () => db.adminNode(params.id)),
  ),
  http.get<Id>('/api/admin/nodes/:id/path', ({ request, params }) =>
    respond(request, () => db.adminPath(params.id)),
  ),
  http.get<Id>('/api/admin/nodes/:id/children', ({ request, params }) =>
    respond(request, () => db.adminChildren(params.id, readQuery(request, listQuery))),
  ),
  http.get<Id>('/api/admin/nodes/:id/links', ({ request, params }) =>
    respond(request, () => db.linksToDelete(params.id)),
  ),
  http.delete<Id>('/api/admin/nodes/:id', ({ request, params }) =>
    respond(request, async () =>
      db.moderate(params.id, moderationSchema.parse(await request.json()).reason),
    ),
  ),
  http.get('/api/admin/health', ({ request }) => respond(request, () => db.health())),
  http.get('/api/admin/storage', ({ request }) => respond(request, () => db.storageStatus())),
  http.get('/api/admin/tasks', ({ request }) => respond(request, () => db.adminTasks())),
  http.post('/api/admin/tasks', ({ request }) =>
    respond(request, async () => db.startTask(adminTaskRequestSchema.parse(await request.json())), {
      status: 202,
    }),
  ),
  http.get<Id>('/api/admin/tasks/:id', ({ request, params }) =>
    respond(request, () => db.adminTask(params.id)),
  ),
  http.get('/api/admin/database', ({ request }) => respond(request, () => db.databaseStatus())),
  http.post<{ name: string }>('/api/admin/database/tables/:name/vacuum', ({ request, params }) =>
    respondEmpty(request, () => {
      db.vacuumTable(params.name)
    }),
  ),
  http.get('/api/admin/system', ({ request }) => respond(request, () => db.systemInfo())),
  http.post('/api/admin/system/cache/clear', ({ request }) =>
    respond(request, () => db.clearFrameCache()),
  ),
  http.post<{ pid: string; how: string }>(
    '/api/admin/database/sessions/:pid/:how',
    ({ request, params }) =>
      respondEmpty(request, () => {
        const { pid, how } = z
          .object({
            pid: z.coerce.number().int().positive(),
            how: z.enum(['cancel', 'terminate']),
          })
          .parse(params)
        db.signalSession(pid, how)
      }),
  ),
  http.get('/api/admin/metrics', ({ request }) =>
    respond(request, () => db.metrics(readQuery(request, metricsQuerySchema))),
  ),
  http.get('/api/admin/channels', ({ request }) => respond(request, () => db.channels())),
  http.post('/api/admin/channels', ({ request }) =>
    respond(
      request,
      async () => db.createChannel(createChannelSchema.parse(await request.json())),
      { status: 201 },
    ),
  ),
  http.patch<Id>('/api/admin/channels/:id', ({ request, params }) =>
    respond(request, async () =>
      db.updateChannel(params.id, updateChannelSchema.parse(await request.json()).enabled),
    ),
  ),
  http.get('/api/admin/audit', ({ request }) =>
    respond(request, () => db.auditLog(readQuery(request, auditQuerySchema))),
  ),
  http.get('/api/admin/sessions', ({ request }) =>
    respond(request, () =>
      db.adminSessions(readQuery(request, z.object({ userId: z.uuid().optional() })).userId),
    ),
  ),
  http.delete<{ key: string }>('/api/admin/sessions/:key', ({ request, params }) =>
    respondEmpty(request, () => {
      db.endSession(
        z
          .string()
          .regex(/^[0-9a-f]{16}$/)
          .parse(params.key),
      )
    }),
  ),
  http.post<Id>('/api/admin/users/:id/sign-out', ({ request, params }) =>
    respond(request, () => db.signOutUser(params.id)),
  ),
  http.get('/api/admin/shares/owners', ({ request }) =>
    respond(request, () => {
      const query = readQuery(request, adminShareQuerySchema.pick({ active: true, q: true }))
      return db.adminShareOwners({ active: query.active === 'true', q: query.q })
    }),
  ),
  http.get('/api/admin/shares', ({ request }) =>
    respond(request, () => {
      const query = readQuery(request, adminShareQuerySchema)
      return db.adminShares({ ...query, active: query.active === 'true' })
    }),
  ),
  http.delete<Id>('/api/admin/shares/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.deleteShareAsAdmin(params.id)
    }),
  ),
  http.get('/api/admin/uploads', ({ request }) => respond(request, () => db.adminUploads())),
  http.delete<Id>('/api/admin/uploads/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.cancelUploadAsAdmin(params.id)
    }),
  ),

  // ── Share links ────────────────────────────────────────────────────────────
  http.get('/api/shares', ({ request }) => respond(request, () => db.shares())),
  http.post('/api/shares/count', ({ request }) =>
    respond(request, async () => db.shareCount(shareCountInputSchema.parse(await request.json()))),
  ),
  http.post('/api/shares', ({ request }) =>
    respond(request, async () => db.createShare(createShareSchema.parse(await request.json())), {
      status: 201,
    }),
  ),
  http.patch<Id>('/api/shares/:id', ({ request, params }) =>
    respond(request, async () =>
      db.updateShare(params.id, updateShareSchema.parse(await request.json())),
    ),
  ),
  http.delete<Id>('/api/shares/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.deleteShare(params.id)
    }),
  ),

  // ── Public share access (§7.5): no session, no CSRF token ──────────────────
  http.get<Token>('/api/s/:token', ({ request, params }) =>
    respond(request, () => db.publicShare(params.token), { public: true }),
  ),
  http.post<Token>('/api/s/:token/unlock', ({ request, params }) =>
    respondEmpty(
      request,
      async () => {
        db.unlockShare(params.token, unlockShareSchema.parse(await request.json()).password)
      },
      { public: true },
    ),
  ),
  http.get<Token>('/api/s/:token/children', ({ request, params }) =>
    respond(
      request,
      () => {
        const query = readQuery(request, shareListQuery)
        return db.shareChildren(
          params.token,
          query.parentId ?? null,
          query.cursor ?? null,
          query.limit,
        )
      },
      { public: true },
    ),
  ),
  http.get<Token & Id>('/api/s/:token/files/:id/content', ({ request, params }) =>
    respond(
      request,
      async () => {
        const query = new URL(request.url).searchParams
        const version = query.get('version')
        const file = db.shareFileContent(params.token, params.id, version)
        // Only a download counts (§7.5): a request from byte 0, so seeking in
        // a video doesn't, and never a preview or a browser that has the file.
        const range = request.headers.get('Range')
        const fromStart = range === null || range.startsWith('bytes=0-')
        const preview = query.get('preview') === '1'
        if (fromStart && !preview && !notModified(request, file)) {
          db.countShareDownload(params.token)
        }
        const response = fileResponse(request, file)
        if (version) await recordDelivery(placeOf(params), version, response)
        return response
      },
      { public: true },
    ),
  ),
  http.get<Token>('/api/s/:token/connection-test', ({ request, params }) =>
    respond(
      request,
      () => {
        db.openShare(params.token)
        return connectionTest(request, 'address')
      },
      { public: true },
    ),
  ),
  http.get<Token>('/api/s/:token/archive', ({ request, params }) =>
    respond(
      request,
      () => {
        const nodeId = new URL(request.url).searchParams.get('nodeId')
        const archive = db.shareArchive(params.token, nodeId)
        return zipResponse(archive.body, archive.name)
      },
      { public: true },
    ),
  ),

  // ── Live events (§6.1) ─────────────────────────────────────────────────────
  sse<Record<MockEvent['type'] | 'ping', string>>('/api/events', ({ client, request }) => {
    if (!db.signedIn || db.mustChangePassword) {
      client.error()
      return
    }
    // The event type goes in the SSE `event` field, the rest is the JSON payload.
    const unsubscribe = db.subscribe(({ type, ...payload }) => {
      client.send({ event: type, data: JSON.stringify(payload) })
    })
    const ping = setInterval(() => {
      client.send({ event: 'ping', data: '{}' })
    }, PING_INTERVAL_MS)
    request.signal.addEventListener(
      'abort',
      () => {
        unsubscribe()
        clearInterval(ping)
      },
      { once: true },
    )
  }),
]

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RespondOptions {
  status?: number
  /** Skip the session and CSRF checks. */
  public?: boolean
  /** Also open to a session that must choose a new password first (§7.1). */
  limited?: boolean
}

type WorkResult = JsonBodyType | Response

/** A player's read, counted for its warning (§10.4): sent at once here, so it never waits. */
async function recordDelivery(place: MockPlace, versionId: string, response: Response) {
  db.recordDelivery(place, versionId, (await response.clone().arrayBuffer()).byteLength)
}

/** `GET /connection-test`, and a link's: bytes to time, one test at a time, as the API has it. */
function connectionTest(request: Request, by: 'user' | 'address'): Response {
  const bytes = z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CONNECTION_TEST_BYTES)
    .parse(new URL(request.url).searchParams.get('bytes'))
  // The bytes go out at once here, so a test runs for a moment.
  if (connectionTests.has(by)) {
    throw new MockApiError(429, 'rate_limited', 'A connection test is running, or ran just now.')
  }
  connectionTests.add(by)
  setTimeout(() => {
    connectionTests.delete(by)
  }, 500)
  return new HttpResponse(new Uint8Array(bytes), {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  })
}

/**
 * Runs `work` after a realistic delay and sends its result as JSON (a
 * `Response` is passed through unchanged), or an error body if it throws.
 */
async function respond(
  request: Request,
  work: () => WorkResult | Promise<WorkResult>,
  options: RespondOptions = {},
): Promise<Response> {
  if (responseDelay) await delay(60 + Math.random() * 160)
  let response: Response
  try {
    if (!options.public) authorize(request, options.limited ?? false)
    const result = await work()
    response =
      result instanceof Response
        ? result
        : HttpResponse.json(result, { status: options.status ?? 200 })
  } catch (error) {
    response = toErrorResponse(error)
  }
  response.headers.set(MOCK_RESPONSE_HEADER, '1')
  return response
}

/** Like `respond`, for work that returns nothing: answers `204 No Content`. */
function respondEmpty(
  request: Request,
  work: () => void | Promise<void>,
  options: RespondOptions = {},
): Promise<Response> {
  return respond(
    request,
    async () => {
      await work()
      return new HttpResponse(null, { status: 204 })
    },
    options,
  )
}

function authorize(request: Request, limited: boolean): void {
  if (!db.signedIn) throw new MockApiError(401, 'unauthenticated', 'Sign in to continue.')
  if (!limited && db.mustChangePassword) {
    throw new MockApiError(
      403,
      'password_change_required',
      'Choose a new password before you continue.',
    )
  }
  const changesState = request.method !== 'GET' && request.method !== 'HEAD'
  if (changesState && request.headers.get('X-CSRF-Token') !== db.csrfToken) {
    throw new MockApiError(403, 'csrf_failed', 'The request is missing a valid CSRF token.')
  }
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof MockApiError) {
    return HttpResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    )
  }
  if (error instanceof ZodError) {
    return HttpResponse.json(
      { error: { code: 'invalid_request', message: 'The request was malformed.' } },
      { status: 400 },
    )
  }
  throw error
}

/**
 * A file, or the single byte range asked for, as the real API sends it (§6.2);
 * `304 Not Modified` to a browser that has this version.
 */
function fileResponse(request: Request, file: MockFileContent): Response {
  const revalidation = { ETag: file.etag, 'Cache-Control': 'private, no-cache' }
  if (notModified(request, file)) {
    return new HttpResponse(null, { status: 304, headers: revalidation })
  }
  const size = file.body.length
  const headers: Record<string, string> = {
    ...revalidation,
    'Content-Type': file.mimeType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Accept-Ranges': 'bytes',
  }
  // A range of another version than the one asked about is the whole file (If-Range).
  const ifRange = request.headers.get('If-Range')
  const range = ifRange === null || ifRange === file.etag ? request.headers.get('Range') : null
  const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '')
  if (!match || (match[1] === '' && match[2] === '')) {
    return new HttpResponse(file.body.slice(), { headers })
  }
  const [, from = '', to = ''] = match
  const start = from === '' ? Math.max(0, size - Number(to)) : Number(from)
  const end = from === '' || to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (start >= size || start > end) {
    return new HttpResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  return new HttpResponse(file.body.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` },
  })
}

/** Whether `If-None-Match` names the file's version (compared weakly, in a list, or `*`). */
function notModified(request: Request, file: MockFileContent): boolean {
  const header = request.headers.get('If-None-Match')
  if (header === null) return false
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === file.etag)
}

function zipResponse(body: Uint8Array<ArrayBuffer>, fileName: string): Response {
  return new HttpResponse(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}

function readQuery<T>(request: Request, schema: z.ZodType<T>): T {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams))
}
