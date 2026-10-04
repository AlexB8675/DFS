import { randomUUID } from 'node:crypto'
import pg from 'pg'

// Integration tests run against a real PostgreSQL 18 (DESIGN §17). The global
// setup (`./global-setup.ts`) starts one server per test run and migrates a
// template database; each test file then copies the template, which takes
// milliseconds and keeps files from seeing each other's rows.

/** What the global setup hands to test files through Vitest's `inject`. */
export interface TestPostgres {
  /** A connection URL with the right to create databases. */
  adminUrl: string
  /** The migrated database that test databases are copied from. */
  template: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    testPostgres: TestPostgres
  }
}

export interface TestDatabase {
  url: string
  drop: () => Promise<void>
}

/**
 * A fresh, migrated database for one test file:
 * `const database = await createTestDatabase(inject('testPostgres'))`.
 */
export async function createTestDatabase(server: TestPostgres): Promise<TestDatabase> {
  const name = `dfs_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  await withAdmin(server.adminUrl, (admin) =>
    admin.query(`CREATE DATABASE ${name} TEMPLATE ${server.template}`),
  )
  return {
    url: databaseUrl(server.adminUrl, name),
    drop: async () => {
      await withAdmin(server.adminUrl, (admin) =>
        admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      )
    },
  }
}

/** The same server and credentials, another database. */
export function databaseUrl(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

export async function withAdmin<T>(
  url: string,
  work: (admin: pg.Client) => Promise<T>,
): Promise<T> {
  const admin = new pg.Client({ connectionString: url, application_name: 'dfs-tests' })
  await admin.connect()
  try {
    return await work(admin)
  } finally {
    await admin.end()
  }
}
