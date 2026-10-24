import { playwright } from '@vitest/browser-playwright'
import type { BrowserInstanceOption } from 'vitest/node'
import { defineConfig } from 'vitest/config'

// The browser suites (DESIGN.md §10.4, D45) run the repackager's output in real
// browsers, against a Range server over the corpus (src/testing/serve.ts). Chrome
// is the one installed on this PC and is the default (`DFS_CHROME_CHANNEL` names
// another installed channel, such as `msedge`, or `none` for Playwright's own Chromium);
// `DFS_BROWSERS=chromium,firefox` adds Playwright's Firefox
// (`pnpm --filter @dfs/mp4 exec playwright install firefox`), and either can be
// left out. `DFS_HEADED=1` shows the windows: Firefox plays HEVC only then.
// `DFS_CORPUS_ALL=1` plays every file expected to play and not a sample of the
// user's (src/browser/choice.ts). The unit tests never run these
// (vitest.config.ts excludes them).

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

// Unset, the installed Chrome; `msedge` and the like name another installed browser; an empty value
// or `none` names none, and leaves the channel out for Playwright's own Chromium (`playwright install
// chromium`), for a machine without any. That Chromium is built without H.264, AAC and HEVC, so most
// of the corpus is skipped there, each file saying it can't play its codec.
const channelValue = process.env.DFS_CHROME_CHANNEL?.trim()
const chromeChannel =
  channelValue === undefined
    ? 'chrome'
    : channelValue === '' || channelValue === 'none'
      ? undefined
      : channelValue

const instances: BrowserInstanceOption[] = []
if (wanted.includes('chromium')) {
  instances.push({
    browser: 'chromium',
    provider: playwright({
      // The installed Google Chrome, unless another channel is named: nothing is
      // downloaded for it. A page that plays without a click is allowed to, as the
      // media tests have no user to give one.
      launchOptions: {
        ...(chromeChannel === undefined ? {} : { channel: chromeChannel }),
        args: ['--autoplay-policy=no-user-gesture-required'],
      },
    }),
  })
}
if (wanted.includes('firefox')) {
  instances.push({
    browser: 'firefox',
    provider: playwright({
      launchOptions: {
        firefoxUserPrefs: {
          'media.autoplay.default': 0,
          'media.autoplay.blocking_policy': 0,
          // A window that other windows cover is hidden to the page, and Firefox presents no pictures to a hidden
          // page (requestVideoFrameCallback never fires), so a headed run would fail whenever something covers it.
          'widget.windows.window_occlusion_tracking.enabled': false,
        },
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
