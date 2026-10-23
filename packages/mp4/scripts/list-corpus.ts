// Adds the videos of some folders to the MP4 reader's test corpus (DESIGN.md
// §10.4, D45), to be read where they are: nothing is copied, and the manifest
// (`corpus/manifest.local.json`, git-ignored) holds only their paths. Each folder
// is read for its `.mp4`, `.mov` and `.m4v` files, whatever the case of the
// extension, and not below it (a folder of photos holds other files, and these
// are not looked at); each is added expecting to play, and an entry that is
// already in the manifest is kept as it is.
//
// Run with `pnpm --filter @dfs/mp4 corpus:list <folder>...`.

import { readdirSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { mergeEntries, readManifest, writeManifest } from '../src/testing/corpus.ts'
import type { ManifestEntry } from '../src/testing/corpus.ts'

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v']

async function main(folders: string[]): Promise<void> {
  if (folders.length === 0) {
    console.error('Usage: corpus:list <folder>...')
    process.exitCode = 1
    return
  }
  const found: ManifestEntry[] = []
  for (const folder of folders) {
    for (const name of readdirSync(folder).sort()) {
      const path = resolve(folder, name)
      if (VIDEO_EXTENSIONS.includes(extname(name).toLowerCase()) && statSync(path).isFile()) {
        found.push({ path, expect: 'plays' })
      }
    }
  }
  const before = readManifest()
  const merged = mergeEntries(before, found, false)
  await writeManifest(merged)
  console.log(
    `Added ${merged.length - before.length} of ${found.length} videos found; the manifest names ${merged.length}.`,
  )
}

await main(process.argv.slice(2))
