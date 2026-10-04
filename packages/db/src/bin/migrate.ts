import path from 'node:path'
import { ConfigError, loadConfig } from '@dfs/config'
import { runMigrations } from '../migrate.ts'

// `pnpm --filter @dfs/db migrate`: applies pending migrations to DATABASE_URL.

const rootDir = path.resolve(import.meta.dirname, '../../../..')

try {
  const config = loadConfig(process.env, { service: 'cli', rootDir })
  await runMigrations(config.databaseUrl)
  console.log('Migrations are up to date.')
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error)
  process.exitCode = 1
}
