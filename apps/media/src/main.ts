import { loadMediaConfig, type MediaConfig } from './config.ts'
import { buildMediaServer } from './server.ts'

// Starts the media service (DESIGN.md §6.7): `node src/main.ts`, in its own
// image, which has ffmpeg. It always runs in a container, so it listens on
// every address there; the Compose network keeps it internal.

const SHUTDOWN_GRACE_MS = 10_000

let config: MediaConfig
try {
  config = loadMediaConfig(process.env)
} catch (error) {
  console.error('[ERROR]', error instanceof Error ? error.message : error)
  process.exit(1)
}

const app = buildMediaServer({ config })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref()
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed')
        process.exit(1)
      },
    )
  })
}

await app.listen({ port: config.port, host: '0.0.0.0' })
