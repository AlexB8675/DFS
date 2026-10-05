import path from 'node:path'
import { ConfigError, loadConfig, type Config } from '@dfs/config'
import { createBot } from './bot.ts'

// Starts the bot: `node src/main.ts` (D22). It waits for Postgres rather than
// failing, so `pnpm dev` works before the database is up.

const rootDir = path.resolve(import.meta.dirname, '../../..')
const SHUTDOWN_GRACE_MS = 15_000

let config: Config
try {
  config = loadConfig(process.env, { service: 'bot', rootDir })
} catch (error) {
  console.error('[ERROR]', error instanceof ConfigError ? error.message : error)
  process.exit(1)
}

const bot = createBot({
  config,
  // Another instance may lead already: stop everything and let the restart
  // policy bring this one back as a standby.
  onLeadershipLost: () => process.exit(1),
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    bot.server.log.info({ signal }, 'shutting down')
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref()
    bot.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        bot.server.log.error({ err: error }, 'shutdown failed')
        process.exit(1)
      },
    )
  })
}

const host = config.nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'
await bot.server.listen({ port: config.botPort, host })
