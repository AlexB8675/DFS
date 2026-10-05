import { readFileSync } from 'node:fs'
import path from 'node:path'

// Passwords refused for being too common (DESIGN.md §7.1), lowercase: the
// ones among SecLists' million most common that the length rule doesn't
// already refuse, about 30,000. scripts/update-common-passwords.ts makes the
// list; common-passwords.LICENSE says where it comes from.

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  readFileSync(path.join(import.meta.dirname, 'common-passwords.txt'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean),
)
