/**
 * What the contract suite runs against: the mock API in Node or the real API
 * (BACKEND.md §5). Both answer the same HTTP calls; this covers the rest.
 */
export interface ContractTarget {
  name: 'mock' | 'api'
  baseUrl: string
  /** The Origin our own pages send; sign-in and share unlocks check it. */
  origin: string
  /** An owner account that is ready to use (no temporary password). */
  owner: { username: string; password: string }
  /** Lets background work finish: syncing files to storage, folder sizes. */
  settle: () => Promise<void>
}

/**
 * The test functions of the runner's own Vitest, passed in so they register
 * with it. Typed by shape, since each app resolves its own copy of Vitest.
 */
export interface TestApi {
  describe: (name: string, body: () => void) => void
  it: (name: string, body: () => Promise<void>) => void
  expect: (actual: unknown) => Assertion
}

/** The matchers the suite uses. */
export interface Assertion {
  toBe: (expected: unknown) => void
  toEqual: (expected: unknown) => void
  toMatchObject: (expected: object) => void
  toBeNull: () => void
  toHaveLength: (length: number) => void
  toContain: (item: unknown) => void
  toBeGreaterThan: (value: number) => void
  not: Assertion
}
