import {
  changePasswordSchema,
  createChannelSchema,
  createFolderSchema,
  createShareSchema,
  createUploadBatchSchema,
  createUploadSchema,
  createUserSchema,
  ensureFoldersSchema,
  loginSchema,
  lookupNodesSchema,
  metricsQuerySchema,
  moderationSchema,
  moveNodesSchema,
  nodeIdsSchema,
  nodeKindSchema,
  resetPasswordSchema,
  sortFieldSchema,
  sortOrderSchema,
  unlockShareSchema,
  updateChannelSchema,
  updateNodeSchema,
  updateShareSchema,
  updateUserSchema,
} from '@dfs/shared'
import { delay, http, HttpResponse, sse, type JsonBodyType } from 'msw'
import { z, ZodError } from 'zod'
import { AdminMockDb } from './admin-db'
import { MockApiError, type MockEvent, type MockFileContent } from './db'
import { MOCK_RESPONSE_HEADER } from './marker'
import { DEMO_ACCOUNTS } from './seed'

// Mocks the HTTP API of DESIGN.md §9 on top of the in-memory database.

export const db = new AdminMockDb()

/** A realistic delay before each answer; the contract suite turns it off for speed. */
let responseDelay = true

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
      return db.trashItems(query.cursor ?? null, query.limit)
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
  http.get<Id>('/api/uploads/:id', ({ request, params }) =>
    respond(request, () => db.uploadStatus(params.id)),
  ),
  http.post('/api/uploads', ({ request }) =>
    respond(
      request,
      async () => {
        const input = createUploadSchema.parse(await request.json())
        return db.createUpload(input.parentId, input.name, input.sizeBytes, input.mimeType)
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
  http.post<Id>('/api/uploads/:id/complete', ({ request, params }) =>
    respondEmpty(request, () => {
      db.completeUpload(params.id)
    }),
  ),
  http.delete<Id>('/api/uploads/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.cancelUpload(params.id)
    }),
  ),

  // ── Content ────────────────────────────────────────────────────────────────
  http.get<Id>('/api/files/:id/content', ({ request, params }) =>
    respond(request, () => fileResponse(request, db.fileContent(params.id))),
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
  http.delete<Id>('/api/admin/nodes/:id', ({ request, params }) =>
    respondEmpty(request, async () => {
      db.moderate(params.id, moderationSchema.parse(await request.json()).reason)
    }),
  ),
  http.get('/api/admin/health', ({ request }) => respond(request, () => db.health())),
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
    respond(request, () => {
      const query = readQuery(request, pageQuery)
      return db.auditLog(query.cursor ?? null, query.limit)
    }),
  ),

  // ── Share links ────────────────────────────────────────────────────────────
  http.get('/api/shares', ({ request }) => respond(request, () => db.shares())),
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
      db.revokeShare(params.id)
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
      () => {
        // Only a request from byte 0 counts as a download (§7.5).
        const range = request.headers.get('Range')
        const fromStart = range === null || range.startsWith('bytes=0-')
        return fileResponse(request, db.shareFileContent(params.token, params.id, fromStart))
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

/** A file, or the single byte range asked for, as the real API sends it (§6.2). */
function fileResponse(request: Request, file: MockFileContent): Response {
  const size = file.body.length
  const headers: Record<string, string> = {
    'Content-Type': file.mimeType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Accept-Ranges': 'bytes',
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '')
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
