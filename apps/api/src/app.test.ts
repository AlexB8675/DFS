import path from 'node:path'
import { loadConfig } from '@dfs/config'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from './app.ts'
import { ApiError } from './errors.ts'

function testConfig(env: Record<string, string> = {}) {
  return loadConfig(
    { NODE_ENV: 'test', ...env },
    { service: 'api', rootDir: path.resolve('/repo') },
  )
}

describe('API with a database', () => {
  let database: TestDatabase
  let app: FastifyInstance

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    app = await buildApp({ config: testConfig({ DATABASE_URL: database.url }), logger: false })
  })

  afterAll(async () => {
    await app.close()
    await database.drop()
  })

  it('reports itself healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', database: 'ok' })
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('API without a database', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    // Nothing listens on port 1, so connecting fails at once.
    const config = testConfig({ DATABASE_URL: 'postgres://dfs:dfs@127.0.0.1:1/dfs' })
    app = await buildApp({ config, logger: false })
    app.get('/api/test/fails', () => {
      throw new Error('boom: a secret detail')
    })
    app.get('/api/test/refuses', () => {
      throw new ApiError(507, 'quota_exceeded', 'Not enough space.')
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('still starts, and says the database is unreachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'degraded', database: 'unreachable' })
  })

  it('answers every error in the shared shape', async () => {
    const error = async (url: string, init: { method?: 'GET' | 'POST'; body?: string } = {}) => {
      const response = await app.inject({
        method: init.method ?? 'GET',
        url,
        payload: init.body,
        headers: init.body ? { 'content-type': 'application/json' } : {},
      })
      return { status: response.statusCode, body: response.json<{ error: object }>() }
    }

    expect(await error('/api/nope')).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'No route for GET /api/nope.' } },
    })
    expect(await error('/api/test/refuses')).toEqual({
      status: 507,
      body: { error: { code: 'quota_exceeded', message: 'Not enough space.' } },
    })
    expect(await error('/api/health', { method: 'POST', body: '{bad' })).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_request' } },
    })
    const failure = await error('/api/test/fails')
    expect(failure).toMatchObject({ status: 500, body: { error: { code: 'internal_error' } } })
    // The cause stays in the log.
    expect(JSON.stringify(failure.body)).not.toContain('secret')
  })
})
