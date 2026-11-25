import { readFileSync } from 'node:fs'
import path from 'node:path'

// The app API's guide (DESIGN.md §7.8): a Markdown file beside this one, with
// the instance's address left as {{BASE_URL}}. guide.test.ts keeps it to the
// routes.

const TEMPLATE = readFileSync(path.join(import.meta.dirname, 'guide.md'), 'utf8')

/** The guide, with the instance's address (no trailing slash) filled in. */
export function loadGuide(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '')
  // A function, so a `$` in the address is not read as a replacement pattern.
  return TEMPLATE.replaceAll('{{BASE_URL}}', () => clean)
}
