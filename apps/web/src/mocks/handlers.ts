import {
  createFolderSchema,
  createShareSchema,
  createUploadSchema,
  ensureFoldersSchema,
  moveNodesSchema,
  nodeIdsSchema,
  nodeKindSchema,
  sortFieldSchema,
  sortOrderSchema,
  updateNodeSchema,
} from '@dfs/shared'
import { delay, http, HttpResponse, sse, type JsonBodyType } from 'msw'
import { z, ZodError } from 'zod'
import { db, MockApiError, type MockEvent } from './db'
import { MOCK_RESPONSE_HEADER } from './marker'

// Mocks the HTTP API of DESIGN.md §9 on top of the in-memory database.

interface Id {
  id: string
}

const listQuery = z.object({
  kind: nodeKindSchema.optional(),
  sort: sortFieldSchema.default('name'),
  order: sortOrderSchema.default('asc'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

const pageQuery = z.object({
  q: z.string().default(''),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export const handlers = [
  // ── Auth ───────────────────────────────────────────────────────────────────
  http.get('/api/auth/me', ({ request }) => respond(request, () => db.session())),
  http.post('/api/auth/logout', ({ request }) =>
    respondEmpty(request, () => {
      db.signOut()
    }),
  ),
  // Mock-only stand-in for the Discord OAuth round trip (§7.1).
  http.post('/api/auth/dev-login', ({ request }) =>
    respondEmpty(
      request,
      () => {
        db.signIn()
      },
      { public: true },
    ),
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
    respond(request, () => {
      const file = db.fileContent(params.id)
      return new HttpResponse(file.body, {
        headers: {
          'Content-Type': file.mimeType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        },
      })
    }),
  ),

  // ── Share links ────────────────────────────────────────────────────────────
  http.get('/api/shares', ({ request }) => respond(request, () => db.shares())),
  http.post('/api/shares', ({ request }) =>
    respond(request, async () => db.createShare(createShareSchema.parse(await request.json())), {
      status: 201,
    }),
  ),
  http.delete<Id>('/api/shares/:id', ({ request, params }) =>
    respondEmpty(request, () => {
      db.revokeShare(params.id)
    }),
  ),

  // ── Live events (§6.1) ─────────────────────────────────────────────────────
  sse<Record<MockEvent['type'], string>>('/api/events', ({ client, request }) => {
    if (!db.signedIn) {
      client.error()
      return
    }
    const unsubscribe = db.subscribe((event) => {
      client.send({ event: event.type, data: JSON.stringify(event) })
    })
    request.signal.addEventListener('abort', unsubscribe, { once: true })
  }),
]

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RespondOptions {
  status?: number
  /** Skip the session and CSRF checks. */
  public?: boolean
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
  await delay(60 + Math.random() * 160)
  let response: Response
  try {
    if (!options.public) authorize(request)
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

function authorize(request: Request): void {
  if (!db.signedIn) throw new MockApiError(401, 'unauthenticated', 'Sign in to continue.')
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

function readQuery<T>(request: Request, schema: z.ZodType<T>): T {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams))
}
