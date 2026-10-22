import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The corpus and browser suites are run on their own, never with the unit tests.
    exclude: [...configDefaults.exclude, 'src/**/*.corpus.test.ts', 'src/**/*.browser.test.ts'],
  },
})
