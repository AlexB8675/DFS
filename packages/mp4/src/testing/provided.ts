// What the browser suites are given by `inject('corpus')` (DESIGN.md §10.4, D45):
// types only, so that both the Node side (serve.ts, which provides it) and the
// browser side (the tests, which inject it) can say them without the other's
// libraries.

import type { Mp4Refusal } from '../errors.ts'

/** One corpus file as a browser knows it: served at `${url}/file/${id}`, and named by its base name alone, as paths never reach the browser. */
export interface CorpusFile {
  id: number
  name: string
  expect: 'plays' | { refused: Mp4Refusal }
  size: number
  /** Whether `corpus:make` made it, as against one of the user's videos, which are read in place. */
  synthetic: boolean
}

/** The Range server over the corpus: where it is, and the files of the manifest that are there. */
export interface CorpusInfo {
  url: string
  files: CorpusFile[]
}

declare module 'vitest' {
  export interface ProvidedContext {
    corpus: CorpusInfo
    /** Whether every file expected to play is to be played (`DFS_CORPUS_ALL=1`), and not the sample of the user's. */
    playAll: boolean
  }
}
