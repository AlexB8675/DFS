import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The browser suites are run on their own, never with the unit tests.
    exclude: [...configDefaults.exclude, 'src/**/*.browser.test.ts'],
  },
})
