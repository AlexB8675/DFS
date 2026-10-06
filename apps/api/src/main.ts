import path from 'node:path'
import { ConfigError, loadConfig, type Config } from '@dfs/config'
import { buildApp } from './app.ts'

// Starts the API: `node src/main.ts` (D22), with the settings of DESIGN §15.

const rootDir = path.resolve(import.meta.dirname, '../../..')
/** How long requests in flight get to finish on shutdown. */
const SHUTDOWN_GRACE_MS = 10_000

let config: Config
try {
  config = loadConfig(process.env, { service: 'api', rootDir })
} catch (error) {
  console.error('[ERROR]', error instanceof ConfigError ? error.message : error)
  process.exit(1)
}

const app = await buildApp({ config })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    setTimeout(() => {
      app.log.error('requests did not finish in time; exiting')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS).unref()
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed')
        process.exit(1)
      },
    )
  })
}

// In a container the API must accept connections from Caddy; on a developer
// machine, only from this machine.
const host = config.nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'
await app.listen({ port: config.apiPort, host })
// Only a listening API checks Discord, the internet and itself, and flushes
// the journal: tests don't.
app.checks.start(`http://127.0.0.1:${String(config.apiPort)}/api/health`)
app.journalFlusher.start()
