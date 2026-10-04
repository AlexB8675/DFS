import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export type Database = NodePgDatabase<typeof schema>

export interface PoolOptions {
  /** Shown in `pg_stat_activity`, so connections say which service holds them. */
  applicationName: string
  max?: number
  /** Called when an idle connection fails (Postgres restarted, network dropped). */
  onError: (error: Error) => void
}

/**
 * A connection pool. Waiting for a connection gives up after 5 s, so a health
 * check answers promptly while Postgres is down; pg's default is to wait forever.
 */
export function createPool(databaseUrl: string, options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5000,
  })
  // Without a listener, an idle connection dropping would crash the process.
  pool.on('error', options.onError)
  return pool
}

export function createDatabase(client: pg.Pool | pg.Client): Database {
  return drizzle({ client, schema })
}
