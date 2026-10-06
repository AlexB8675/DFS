import { apiErrorSchema } from '@dfs/shared'
import type { z } from 'zod'

/** An HTTP error from the API, with the machine-readable `code` from its error body. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** From a `Retry-After` header (503 when staging is full, 429): how long to back off. */
  readonly retryAfterMs: number | null

  constructor(status: number, code: string, message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

// ── Session plumbing ─────────────────────────────────────────────────────────

let csrfToken: string | null = null

/** Stores the token from `GET /api/auth/me`; it is sent on every state-changing request (§7.1). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

// ── Requests ─────────────────────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type QueryParams = Record<string, string | number | boolean | null | undefined>

interface RequestOptions {
  method?: Method
  query?: QueryParams
  /** Serialized as JSON. */
  json?: unknown
  /** Sent as-is, for binary uploads. */
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** Sends a request to `/api{path}` and throws an `ApiError` unless it succeeds. */
export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', query, json, body, signal } = options
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken)

  let payload = body
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json')
    payload = JSON.stringify(json)
  }

  const response = await fetch(buildUrl(path, query), { method, headers, body: payload, signal })
  if (!response.ok) throw await toApiError(response)
  return response
}

/** GETs `path` and validates the JSON response against `schema`. */
export async function apiGet<T>(
  path: string,
  schema: z.ZodType<T>,
  options: Pick<RequestOptions, 'query' | 'signal'> = {},
): Promise<T> {
  const response = await apiFetch(path, options)
  return schema.parse(await response.json())
}

/** Sends a JSON body and, if `schema` is given, validates the JSON response. */
export async function apiSend(method: Method, path: string, json?: unknown): Promise<void>
export async function apiSend<T>(
  method: Method,
  path: string,
  json: unknown,
  schema: z.ZodType<T>,
): Promise<T>
export async function apiSend<T>(
  method: Method,
  path: string,
  json?: unknown,
  schema?: z.ZodType<T>,
): Promise<T | undefined> {
  const response = await apiFetch(path, { method, json })
  return schema ? schema.parse(await response.json()) : undefined
}

interface UploadOptions {
  query?: QueryParams
  headers?: Record<string, string>
  signal?: AbortSignal
  /** How many bytes of the body the browser has sent so far, as it sends them. */
  onProgress?: (sentBytes: number) => void
}

/**
 * PUTs a binary body to `/api{path}`, reporting its progress, and throws an
 * `ApiError` unless it succeeds. A `Blob` is read from disk as it is sent,
 * however large. XMLHttpRequest is the browser's only way to see a body go
 * out; elsewhere (Node, in the checks) `fetch` sends it, without progress.
 */
export function apiUpload(
  path: string,
  body: Blob | ArrayBuffer,
  options: UploadOptions = {},
): Promise<void> {
  const { query, signal, onProgress } = options
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // A file's slice has no type of its own.
    'Content-Type': 'application/octet-stream',
    ...options.headers,
  }
  if (typeof XMLHttpRequest === 'undefined') {
    return apiFetch(path, { method: 'PUT', query, body, headers, signal }).then(() => undefined)
  }
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error)
      return
    }
    const request = new XMLHttpRequest()
    request.open('PUT', buildUrl(path, query))
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    if (onProgress) {
      request.upload.addEventListener('progress', (event) => {
        onProgress(event.loaded)
      })
    }
    const abort = () => {
      request.abort()
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.addEventListener('loadend', () => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(signal.reason as Error)
      // Like fetch, a request that got no answer is a TypeError: worth retrying.
      else if (request.status === 0) reject(new TypeError('The upload couldn’t reach the server.'))
      else if (request.status < 300) resolve()
      else {
        reject(
          apiErrorFrom(
            request.status,
            parseJson(request.responseText),
            request.getResponseHeader('Retry-After'),
          ),
        )
      }
    })
    request.send(body)
  })
}

function buildUrl(path: string, query: QueryParams = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value))
  }
  const search = params.size > 0 ? `?${params.toString()}` : ''
  return `/api${path}${search}`
}

async function toApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null)
  return apiErrorFrom(response.status, body, response.headers.get('Retry-After'))
}

/** An answer's error, from its status, its JSON body and its `Retry-After` header. */
function apiErrorFrom(status: number, body: unknown, retryAfter: string | null): ApiError {
  const parsed = apiErrorSchema.safeParse(body)
  const retryAfterMs = parseRetryAfter(retryAfter)
  if (parsed.success) {
    const { code, message } = parsed.data.error
    return new ApiError(status, code, message, retryAfterMs)
  }
  return new ApiError(status, 'http_error', `Request failed (${status}).`, retryAfterMs)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `Retry-After` is either a number of seconds or an HTTP date. Returns milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}
