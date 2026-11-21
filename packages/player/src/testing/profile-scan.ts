// A look into a browser's profile folder for a run of bytes (DESIGN.md §10.4): the HTTP cache check of the
// plays suite asks whether anything the browser keeps on disk holds a run of a file's bytes. Node only, so it
// is a command that the browser's config gives the page, as the page cannot read its own profile.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { indexOfRun } from './contains.ts'
import type { Scan } from './provided.ts'

/** Reads every file under `folder`, at any depth, and counts those that hold `run`. A folder that is not there holds nothing. */
export function scanFolder(folder: string, run: Uint8Array, root = folder): Scan {
  const found: Scan = { scanned: 0, holding: 0, unreadable: 0, where: [] }
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      const inside = scanFolder(path, run, root)
      found.scanned += inside.scanned
      found.holding += inside.holding
      found.unreadable += inside.unreadable
      found.where.push(...inside.where)
    } else if (entry.isFile()) {
      try {
        const bytes = readFileSync(path)
        found.scanned += 1
        if (indexOfRun(bytes, run) !== -1) {
          found.holding += 1
          found.where.push(relative(root, path))
        }
      } catch {
        found.unreadable += 1
      }
    }
  }
  found.where.sort()
  return found
}
