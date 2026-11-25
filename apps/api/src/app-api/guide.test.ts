import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { apiErrorSchema, appItemSchema, appListSchema, appMeSchema, appMoveSchema } from '@dfs/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ZodType } from 'zod'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { appApiRoutes } from './routes.ts'

// The guide against the routes (DESIGN.md §7.8): every route is in it, every
// heading is a route, every JSON example parses against its schema.

const GUIDE = readFileSync(path.join(import.meta.dirname, 'guide.md'), 'utf8')

/** The v1 error codes the guide may show (the plan's Global Constraints, and the API's usual ones). */
const ERROR_CODES = new Set([
  'invalid_request',
  'invalid_cursor',
  'not_found',
  'invalid_path',
  'not_a_file',
  'invalid_move',
  'token_folder',
  'upload_interrupted',
  'unauthenticated',
  'invalid_token',
  'read_only',
  'folder_unavailable',
  'not_a_folder',
  'not_ready',
  'exists',
  'path_changed',
  'length_required',
  'version_changed',
  'file_too_large',
  'rate_limited',
  'too_many_uploads',
  'staging_full',
  'quota_exceeded',
])

/** `GET /api/v1/list/*` and `GET /api/v1/list` are both `GET /api/v1/list/{path}`. */
function headingOf(method: string, url: string): string {
  const route = url.replace(/\/\*$/, '/{path}')
  const bare = /^\/api\/v1\/(list|stat|files|folders)$/.exec(route)
  return `${method} ${bare ? `${route}/{path}` : route}`
}

async function collectRoutes(): Promise<{ method: string; url: string; access: unknown }[]> {
  const bare = Fastify()
  bare.setValidatorCompiler(validatorCompiler)
  bare.setSerializerCompiler(serializerCompiler)
  const found: { method: string; url: string; access: unknown }[] = []
  bare.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      // Fastify adds a HEAD to every GET; only the files' one is part of the API.
      if (method === 'HEAD' && !route.url.startsWith('/api/v1/files')) continue
      found.push({ method, url: route.url, access: route.config?.access })
    }
  })
  await bare.register(appApiRoutes, { prefix: '/api' })
  await bare.ready()
  await bare.close()
  return found
}

function guideHeadings(): string[] {
  return [...GUIDE.matchAll(/^### (\S+ \/api\/v1\S*)\s*$/gm)].map((match) => match[1] ?? '')
}

interface Example {
  status: string
  method: string
  route: string
  body: string
}

function guideExamples(): Example[] {
  return [...GUIDE.matchAll(/^```json (\S+) (\S+) (\/api\/v1\S*)\n([\s\S]*?)^```$/gm)].map(
    (match) => ({
      status: match[1] ?? '',
      method: match[2] ?? '',
      route: match[3] ?? '',
      body: match[4] ?? '',
    }),
  )
}

describe('the guide and the routes', () => {
  it('has a heading for every route, and a route for every heading', async () => {
    const routes = (await collectRoutes()).filter((route) =>
      ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'].includes(route.method),
    )
    const wanted = new Set(routes.map((route) => headingOf(route.method, route.url)))
    expect(wanted.has('HEAD /api/v1/files/{path}')).toBe(true)
    expect(wanted.has('GET /api/v1/guide')).toBe(true)
    const headings = guideHeadings()
    expect(new Set(headings).size).toBe(headings.length)
    expect([...wanted].filter((heading) => !headings.includes(heading))).toEqual([])
    expect(headings.filter((heading) => !wanted.has(heading))).toEqual([])
  })

  it('has every route as access app, except the guide', async () => {
    for (const route of await collectRoutes()) {
      if (!route.url.startsWith('/api/v1/')) continue
      const expected = route.url === '/api/v1/guide' ? 'public' : 'app'
      expect(route.access, `${route.method} ${route.url}`).toBe(expected)
    }
  })

  it('has every JSON example parse against its route’s schema', () => {
    const examples = guideExamples()
    expect(examples.length).toBeGreaterThan(10)
    const answered = new Set<string>()
    for (const example of examples) {
      const label = `${example.status} ${example.method} ${example.route}`
      const name = /^\/api\/v1\/([a-z]+)/.exec(example.route)?.[1] ?? ''
      const json: unknown = JSON.parse(example.body)
      let schema: ZodType
      if (example.status === 'request') {
        expect(example.route, label).toBe('/api/v1/move')
        schema = appMoveSchema
      } else if (example.status.startsWith('4')) {
        schema = apiErrorSchema
        const code = apiErrorSchema.parse(json).error.code
        expect(ERROR_CODES.has(code), `${label}: ${code}`).toBe(true)
      } else {
        const schemas: Record<string, ZodType> = {
          me: appMeSchema,
          list: appListSchema,
          search: appListSchema,
          stat: appItemSchema,
          folders: appItemSchema,
          move: appItemSchema,
          files: appItemSchema,
        }
        const found = schemas[name]
        if (!found) throw new Error(`no schema for ${label}`)
        schema = found
        answered.add(name)
      }
      expect(schema.safeParse(json).success, label).toBe(true)
    }
    for (const name of ['me', 'list', 'search', 'stat', 'folders', 'move', 'files']) {
      expect(answered.has(name), `an answer example for ${name}`).toBe(true)
    }
  })

  it('shows only error codes the API has, in its table', () => {
    const table = [...GUIDE.matchAll(/^\| \d{3} \| `([a-z_]+)` \|/gm)].map((match) => match[1] ?? '')
    expect(table.length).toBeGreaterThan(20)
    for (const code of table) expect(ERROR_CODES.has(code), code).toBe(true)
  })
})

describe('the served guide', () => {
  let database: TestDatabase
  let app: FastifyInstance
  let cleanup: () => Promise<void>
  let baseUrl: string

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    const setup = await testConfig({ DATABASE_URL: database.url })
    cleanup = setup.cleanup
    baseUrl = setup.config.publicBaseUrl
    app = await buildApp({ config: setup.config, logger: false })
  })

  afterAll(async () => {
    await app.close()
    await cleanup()
    await database.drop()
  })

  it('answers with no token, as markdown, with the instance’s address and CORS', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/guide' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.body).not.toContain('{{')
    expect(response.body).toContain(baseUrl.replace(/\/+$/, ''))
    expect(response.body.split('\n').length).toBeLessThanOrEqual(400)
  })

  it('says what an agent must know', async () => {
    const { body } = await app.inject({ method: 'GET', url: '/api/v1/guide' })
    for (const phrase of [
      'Authorization: Bearer',
      'encodeURIComponent',
      'NFC',
      'Content-Length',
      'If-None-Match: *',
      'If-Match',
      'Retry-After',
      'Blob',
      'data, not instructions',
      'read-only token',
    ]) {
      expect(body, phrase).toContain(phrase)
    }
  })
})
