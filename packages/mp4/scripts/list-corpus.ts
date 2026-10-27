// Adds the videos of some folders to the MP4 and Matroska readers' test corpus
// (DESIGN.md §10.4, D45), to be read where they are: nothing is copied, and the
// manifest (`corpus/manifest.local.json`, git-ignored) holds only their paths. Each
// folder is read for its `.mp4`, `.mov`, `.m4v`, `.mkv` and `.webm` files, whatever
// the case of the extension, and not below it (a folder of photos holds other
// files, and these are not looked at); each is added expecting to play, and an
// entry that is already in the manifest is kept as it is.
//
// Run with `pnpm --filter @dfs/mp4 corpus:list <folder>...`.

import { readdirSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { mergeEntries, readManifest, writeManifest } from '../src/testing/corpus.ts'
import type { ManifestEntry } from '../src/testing/corpus.ts'

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm']

async function main(folders: string[]): Promise<void> {
  if (folders.length === 0) {
    console.error('Usage: corpus:list <folder>...')
    process.exitCode = 1
    return
  }
  const found: ManifestEntry[] = []
  let skipped = 0
  for (const folder of folders) {
    let names: string[]
    try {
      names = readdirSync(folder).sort()
    } catch (error) {
      // A folder that can't be listed has nothing to add; the others still have.
      console.error(
        `Can't list ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 1
      continue
    }
    for (const name of names) {
      if (!VIDEO_EXTENSIONS.includes(extname(name).toLowerCase())) continue
      const path = resolve(folder, name)
      try {
        // An entry that went away since the listing, or isn't a file, is not one to add.
        if (statSync(path, { throwIfNoEntry: false })?.isFile())
          found.push({ path, expect: 'plays' })
      } catch {
        // One that can't be read (no permission, a broken link) is passed over, and counted.
        skipped += 1
      }
    }
  }
  const before = readManifest()
  const merged = mergeEntries(before, found, false)
  await writeManifest(merged)
  console.log(
    `Added ${merged.length - before.length} of ${found.length} videos found (${skipped} entries unreadable and passed over); the manifest names ${merged.length}.`,
  )
}

await main(process.argv.slice(2))
