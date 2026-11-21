// What `@dfs/mp4/testing` gives other packages' tests (DESIGN.md §10.4): the box
// and EBML builders, which write a file byte by byte and use no `node:` module,
// so that a suite in the browser can build one too. Tests only.
//
// Both files have a `TrackSpec` and a `MovieSpec`; the EBML ones are given here
// as `EbmlTrackSpec` and `EbmlMovieSpec`, and the box builders' keep their names.

export * from './build.ts'
export * from './ebml.ts'
export type { MovieSpec, TrackSpec } from './build.ts'
export type { MovieSpec as EbmlMovieSpec, TrackSpec as EbmlTrackSpec } from './ebml.ts'

// The choice of the corpus's files to play, which the browser suites of the packages that play files all make.
export { filesToPlay } from '../browser/choice.ts'
export type { Candidate } from '../browser/choice.ts'
