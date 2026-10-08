import { z } from 'zod'

// The media service's settings (DESIGN.md §6.7, §15). It holds no secret:
// no master key, database or token, so it reads none of the API's settings,
// only where to listen and where the API is.

export interface MediaConfig {
  nodeEnv: 'development' | 'test' | 'production'
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  port: number
  /** The API, without a trailing slash: plaintext of a version, with a token for it. */
  apiUrl: string
  release: string
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MEDIA_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  API_INTERNAL_URL: z.url({ protocol: /^https?$/ }),
  DFS_VERSION: z.string().default('dev'),
})

export function loadMediaConfig(env: NodeJS.ProcessEnv): MediaConfig {
  const parsed = schema.safeParse(
    // An empty variable means "use the default", as in the other services.
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  )
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
  }
  const raw = parsed.data
  return {
    nodeEnv: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    port: raw.MEDIA_PORT,
    apiUrl: raw.API_INTERNAL_URL.replace(/\/+$/, ''),
    release: raw.DFS_VERSION,
  }
}
