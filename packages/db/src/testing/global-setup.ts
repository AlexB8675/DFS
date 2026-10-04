import { randomUUID } from 'node:crypto'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { TestProject } from 'vitest/node'
import { runMigrations } from '../migrate.ts'
import { databaseUrl, withAdmin } from './index.ts'

// Vitest global setup for packages with integration tests. Starts PostgreSQL 18
// in Docker (or uses TEST_DATABASE_URL), migrates a template database once,
// and provides both to the test files.

const IMAGE = 'postgres:18-alpine'

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined
  let adminUrl = process.env.TEST_DATABASE_URL
  if (!adminUrl) {
    try {
      container = await new PostgreSqlContainer(IMAGE).start()
    } catch (error) {
      throw new Error(
        'Integration tests need PostgreSQL 18: start Docker, or set TEST_DATABASE_URL to a server where this user can create databases.',
        { cause: error },
      )
    }
    adminUrl = container.getConnectionUri()
  }

  // Unique per run, so test runs of several packages can share one server.
  const template = `dfs_template_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await withAdmin(adminUrl, (admin) => admin.query(`CREATE DATABASE ${template}`))
  // Closes its connection, which `CREATE DATABASE … TEMPLATE` requires.
  await runMigrations(databaseUrl(adminUrl, template))
  project.provide('testPostgres', { adminUrl, template })

  return async () => {
    if (container) {
      await container.stop()
      return
    }
    await withAdmin(adminUrl, (admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`),
    )
  }
}
