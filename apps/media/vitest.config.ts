import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ffmpeg runs in the media image, built on the first run (a few minutes) and cached after.
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
})
