import { sessionSchema, type Session } from '@dfs/shared'
import type { z } from 'zod'

// An HTTP client for the contract suite: it speaks to the mock API and to the
// real one the same way the web app does (DESIGN.md §9): a session cookie,
// the CSRF token from the session, and our own Origin.

export class ApiResponseError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(`${String(status)} ${code}: ${message}`)
    this.status = status
    this.code = code
  }
}

export interface RequestOptions {
  json?: unknown
  body?: Uint8Array<ArrayBuffer>
  headers?: Record<string, string>
  /** Leave out the CSRF header, to test that it is required. */
  withoutCsrf?: boolean
}

export class ApiClient {
  readonly baseUrl: string
  /** The page origin requests claim, as a browser would send it. */
  readonly origin: string
  #cookies = new Map<string, string>()
  #csrfToken: string | null = null

  constructor(baseUrl: string, origin = baseUrl) {
    this.baseUrl = baseUrl
    this.origin = origin
  }

  /** Sends a request to `/api{path}` and returns the raw response, whatever its status. */
  async fetch(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers)
    headers.set('Origin', this.origin)
    if (this.#cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      )
    }
    if (method !== 'GET' && this.#csrfToken && !options.withoutCsrf) {
      headers.set('X-CSRF-Token', this.#csrfToken)
    }
    let body: RequestInit['body']
    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(options.json)
    } else if (options.body) {
      headers.set('Content-Type', 'application/octet-stream')
      body = options.body
    }
    const response = await fetch(`${this.baseUrl}/api${path}`, { method, headers, body })
    this.#keepCookies(response)
    return response
  }

  /** Sends a request and parses a successful answer with `schema`, or throws `ApiResponseError`. */
  async call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    options?: RequestOptions,
  ): Promise<T> {
    const response = await this.#ok(await this.fetch(method, path, options))
    const parsed = schema.parse(await response.json())
    // Sign-in and password changes hand out a new CSRF token.
    const session = sessionSchema.safeParse(parsed)
    if (session.success) this.#csrfToken = session.data.csrfToken
    return parsed
  }

  /** Like `call`, for answers without a body (204). */
  async send(method: string, path: string, options?: RequestOptions): Promise<void> {
    await this.#ok(await this.fetch(method, path, options))
  }

  /** The error a request fails with, as `{ status, code }`; fails the test if it succeeds. */
  async error(method: string, path: string, options?: RequestOptions) {
    const response = await this.fetch(method, path, options)
    if (response.ok)
      throw new Error(`Expected ${method} ${path} to fail; it answered ${String(response.status)}.`)
    const body = (await response.json()) as { error: { code: string } }
    return { status: response.status, code: body.error.code }
  }

  signIn(username: string, password: string): Promise<Session> {
    return this.call('POST', '/auth/login', sessionSchema, { json: { username, password } })
  }

  async #ok(response: Response): Promise<Response> {
    if (response.ok) return response
    const body = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string }
    } | null
    throw new ApiResponseError(
      response.status,
      body?.error?.code ?? 'unknown',
      body?.error?.message ?? response.statusText,
    )
  }

  #keepCookies(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      const expired = attributes.some((attribute) =>
        /^\s*expires=thu, 01 jan 1970/i.test(attribute),
      )
      if (expired || value === '') this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }
}
