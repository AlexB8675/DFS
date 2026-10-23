import { playwright } from '@vitest/browser-playwright'
import type { BrowserInstanceOption } from 'vitest/node'
import { defineConfig } from 'vitest/config'

// The browser suites (DESIGN.md §10.4, D45) run the repackager's output in real
// browsers, against a Range server over the corpus (src/testing/serve.ts). Chrome
// is the one installed on this PC and is the default; `DFS_BROWSERS=chromium,firefox`
// adds Playwright's Firefox (`pnpm --filter @dfs/mp4 exec playwright install firefox`),
// and either can be left out. `DFS_HEADED=1` shows the windows: Firefox plays HEVC
// only then. The unit tests never run these (vitest.config.ts excludes them).

const KNOWN = ['chromium', 'firefox']
const wanted = (process.env.DFS_BROWSERS ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '')
const unknown = wanted.filter((name) => !KNOWN.includes(name))
if (wanted.length === 0 || unknown.length > 0) {
  throw new Error(
    `DFS_BROWSERS must name ${KNOWN.join(' and/or ')}, comma-separated; it was "${process.env.DFS_BROWSERS ?? ''}".`,
  )
}

const instances: BrowserInstanceOption[] = []
if (wanted.includes('chromium')) {
  instances.push({
    browser: 'chromium',
    provider: playwright({
      // The installed Google Chrome: nothing is downloaded for it. A page that plays
      // without a click is allowed to, as the media tests have no user to give one.
      launchOptions: { channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] },
    }),
  })
}
if (wanted.includes('firefox')) {
  instances.push({
    browser: 'firefox',
    provider: playwright({
      launchOptions: {
        firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
      },
    }),
  })
}

export default defineConfig({
  test: {
    include: ['src/**/*.browser.test.ts'],
    globalSetup: ['src/testing/serve.ts'],
    // Real playback is timed, so a file's tests don't share the machine with another's.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    browser: {
      enabled: true,
      headless: process.env.DFS_HEADED !== '1',
      instances,
    },
  },
})
