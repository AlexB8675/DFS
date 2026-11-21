// What the test servers of other packages take from the corpus (DESIGN.md §10.4): the manifest's
// files, how a file is told apart and titled, and how a Range header is read. Node only, so it is
// a subpath of its own: `@dfs/mp4/testing` (the builders) stays free of `node:`.

export { containerOf, isSynthetic, loadManifest, syntheticDir, uniqueTitles } from './corpus.ts'
export type { ManifestEntry } from './corpus.ts'
export { parseRange, playsAll } from './serve.ts'
