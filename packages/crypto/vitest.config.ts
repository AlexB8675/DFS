import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Sealing and opening run on the thread pool, which a full `pnpm check` shares.
    testTimeout: 20_000,
  },
})
