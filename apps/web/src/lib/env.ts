import type { Release } from '@dfs/shared'

/**
 * True when the API is mocked in the browser (dev only, see `src/mocks`).
 * Set `VITE_API_MOCKS=off` to talk to a real API on localhost:3000 instead.
 */
export const mocksEnabled = import.meta.env.DEV && import.meta.env.VITE_API_MOCKS !== 'off'

const given = (value: string | undefined) => (value === undefined || value === '' ? null : value)

/** The deploy this build belongs to (docker/deploy.sh); `dev` when it wasn't deployed. */
export const appRelease: Release = {
  version: given(import.meta.env.VITE_DFS_VERSION) ?? 'dev',
  deployedAt: given(import.meta.env.VITE_DFS_DEPLOYED_AT),
}
