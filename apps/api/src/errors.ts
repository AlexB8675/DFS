import type { FastifyError, FastifyInstance } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod'

// Every error leaves the API in one shape, `{ error: { code, message } }`
// (the shared `apiErrorSchema`), with the codes the mock API already uses.

/** An error a service throws on purpose: it becomes that status and code. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

/** Codes for the errors Fastify raises itself (bad JSON, wrong content type, body too large). */
const FRAMEWORK_CODES: Record<number, string> = {
  400: 'invalid_request',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
}

function body(code: string, message: string) {
  return { error: { code, message } }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).headers(error.headers).send(body(error.code, error.message))
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const [issue] = error.validation
      const where = issue ? `${error.validationContext ?? 'request'}${issue.instancePath}` : ''
      const message = issue ? `${where}: ${issue.message}` : 'The request was malformed.'
      return reply.code(400).send(body('invalid_request', message))
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause.issues }, 'response failed its schema')
    } else if (error.statusCode !== undefined && error.statusCode < 500) {
      const code = FRAMEWORK_CODES[error.statusCode] ?? 'invalid_request'
      return reply.code(error.statusCode).send(body(code, error.message))
    } else {
      request.log.error({ err: error }, 'request failed')
    }
    // Never a stack trace; the request ID finds the details in the log.
    return reply
      .code(500)
      .send(body('internal_error', `Something went wrong on the server (request ${request.id}).`))
  })

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(body('not_found', `No route for ${request.method} ${request.url}.`))
  })
}
