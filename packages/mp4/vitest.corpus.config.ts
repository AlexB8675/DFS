import { defineConfig } from 'vitest/config'

// The corpus suite reads real files and runs ffprobe on them, so it is run on its own (`pnpm --filter @dfs/mp4 test:corpus`) and has time to.
export default defineConfig({
  test: {
    include: ['src/**/*.corpus.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
