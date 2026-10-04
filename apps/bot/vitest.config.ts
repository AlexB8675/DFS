import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // PostgreSQL in Docker, a migrated template, a database per test file.
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
