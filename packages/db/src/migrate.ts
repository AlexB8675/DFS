import path from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createDatabase } from './client.ts'
import { LOCK_NAMESPACE, LOCKS } from './locks.ts'

/** The SQL migrations drizzle-kit generated, committed with the code. */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations')

/**
 * Applies any migrations not yet applied, holding an advisory lock so that
 * two instances starting together don't both migrate. Applying them again
 * changes nothing.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'dfs-migrate' })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, LOCKS.migrate])
    await migrate(createDatabase(client), { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    // Closing the connection also releases the lock.
    await client.end()
  }
}
