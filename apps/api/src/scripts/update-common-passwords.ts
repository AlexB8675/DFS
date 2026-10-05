import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { passwordSchema } from '@dfs/shared'

// Regenerates auth/common-passwords.txt (DESIGN.md §7.1) from SecLists' million
// most common passwords, keeping those the length rule would otherwise allow,
// lowercased, most common first:
//
//   node src/scripts/update-common-passwords.ts [SecLists commit]
//
// Then record the commit in auth/common-passwords.LICENSE.

const SOURCE = 'Passwords/Common-Credentials/Pwdb_top-1000000.txt'
const commit = process.argv[2] ?? '913b327317496d062bcc7cace524aaad8a693be2'

const response = await fetch(
  `https://raw.githubusercontent.com/danielmiessler/SecLists/${commit}/${SOURCE}`,
)
if (!response.ok) throw new Error(`SecLists answered ${String(response.status)}.`)
const kept = new Set<string>()
for (const line of (await response.text()).split(/\r?\n/)) {
  if (passwordSchema.safeParse(line).success) kept.add(line.toLowerCase())
}
await writeFile(
  path.join(import.meta.dirname, '../auth/common-passwords.txt'),
  `${[...kept].join('\n')}\n`,
)
console.info(`[INFO] Wrote ${String(kept.size)} passwords from SecLists ${commit}.`)
