import { adminTests } from './admin.ts'
import { authTests } from './auth.ts'
import { createContext } from './context.ts'
import { downloadTests } from './downloads.ts'
import { shareTests } from './shares.ts'
import type { ContractTarget, TestApi } from './target.ts'
import { treeTests } from './tree.ts'
import { uploadTests } from './uploads.ts'

// The contract between the web app and the API (DESIGN.md §9), run against
// both the mock and the real API, so the two can't drift (BACKEND.md §5).
// Tests make their own users and files: they don't rely on seed data. The mock
// keeps one session at a time, like the browser it runs in, so a test signs
// in again before it goes back to a user it switched away from.

export function defineContractSuite(t: TestApi, target: () => ContractTarget): void {
  const context = createContext(t, target)
  authTests(context)
  treeTests(context)
  uploadTests(context)
  downloadTests(context)
  shareTests(context)
  adminTests(context)
}
