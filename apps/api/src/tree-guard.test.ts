import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Every statement on `nodes` says how it treats trees (DESIGN §7.7): only the
// vault's own code may reach the vault, so a query that forgets fails here
// rather than leaking. The note is `/* tree: … */` on the statement's line, or
// `// tree: …` on the line above a Drizzle call.
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const ROOTS = ['apps/api/src', 'packages/db/src', 'apps/bot/src']
const STATEMENT = [/\b(FROM|JOIN|UPDATE|INTO)\s+nodes\b/i, /\.(from|update|insert|delete)\(nodes\b/]
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*\*)/

/** Source files, leaving out tests and their helpers, and migrations. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'testing' || entry.name === 'migrations' ? [] : sources(file)
    }
    const source =
      entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'testing.ts'
    return source ? [file] : []
  })
}

function unnoted(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  return lines.flatMap((line, index) => {
    if (COMMENT_LINE.test(line) || !STATEMENT.some((pattern) => pattern.test(line))) return []
    if (line.includes('tree:') || lines[index - 1]?.includes('tree:')) return []
    return [`${path.relative(REPO, file).replaceAll(path.sep, '/')}:${String(index + 1)}`]
  })
}

describe('trees (§7.7)', () => {
  it('has a tree: note on every statement on nodes', () => {
    const files = ROOTS.flatMap((root) => sources(path.join(REPO, root)))
    expect(files.length).toBeGreaterThan(50)
    expect(files.flatMap(unnoted)).toEqual([])
  })
})
