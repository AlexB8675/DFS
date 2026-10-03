import { apiErrorSchema } from '@dfs/shared'
import type { z } from 'zod'

/** An HTTP error from the API, with the machine-readable `code` from its error body. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
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
  const parsed = apiErrorSchema.safeParse(body)
  if (parsed.success) {
    return new ApiError(response.status, parsed.data.error.code, parsed.data.error.message)
  }
  return new ApiError(response.status, 'http_error', `Request failed (${response.status}).`)
}
