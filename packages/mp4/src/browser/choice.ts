// What the browser suites decide before they play anything (DESIGN.md §10.4,
// D45): which of the corpus's files to play and how to cut a stretch of frames
// into fragments. Pure functions of names, sizes and a frame table, so that they
// are tested in Node, though only the browser suites use them. They stand in for
// the player's own choices, which come in step 4. Where a picture ends is the
// reader's now (`timing.ts`, for the index's duration), and is given here again
// for the browser suites, which have always had it from this file; `fragmentRuns` is the package's now (`fragments.ts`), and is given here again the same way.

export { fragmentRuns } from '../fragments.ts'
export { pictureEnd } from '../timing.ts'

/** What the choice needs of a corpus file: its title, the size, whether `corpus:make` made it, and what is expected of it. */
export interface Candidate {
  name: string
  size: number
  synthetic: boolean
  /** Its tracks end far apart, so it plays only to the shorter track's end: it is not played through. */
  uneven?: true
  expect: 'plays' | { refused: string }
}

/** How many of the user's files are played unless all are asked for: the largest few, and some spread through the rest. */
const SAMPLE = 12

/** How many of the sample are the largest files, which are the ones that read the most. */
const LARGEST = 3

/** A name order that doesn't depend on the locale, so that the same files are chosen on any machine. */
function byName(a: Candidate, b: Candidate): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * The files to play, from those the corpus has: every synthetic file expected
 * to play (they are the few that each stand for a case, and they are small),
 * and of the user's files expected to play, `SAMPLE` chosen by name and size
 * alone: the largest three (a tie in size goes to the earlier name), then nine
 * spread through the others, which are put in the order of their names and
 * taken at `round(i * (n - 1) / 8)` for i from 0 to 8, so that the first and
 * the last of them are among them. With `all`, every file that is expected to play
 * is played, which takes most of an hour in each browser. A file that is expected
 * to be refused is never played (the refusals are tested without a browser).
 * The synthetic files come first, then the user's, each in the order of the
 * names; the order the files are given in makes no difference.
 */
export function filesToPlay<T extends Candidate>(files: readonly T[], all: boolean): T[] {
  const playing = files.filter((file) => file.expect === 'plays' && file.uneven !== true)
  const made = playing.filter((file) => file.synthetic).sort(byName)
  const users = playing.filter((file) => !file.synthetic).sort(byName)
  if (all || users.length <= SAMPLE) return [...made, ...users]

  // The sort is stable and `users` is in name order, so equal sizes stay in name order.
  const largest = [...users].sort((a, b) => b.size - a.size).slice(0, LARGEST)
  const taken = new Set(largest)
  const rest = users.filter((file) => !taken.has(file))
  const spread = SAMPLE - LARGEST
  for (let i = 0; i < spread; i += 1) {
    const chosen = rest[Math.round((i * (rest.length - 1)) / (spread - 1))]
    if (chosen) taken.add(chosen)
  }
  return [...made, ...users.filter((file) => taken.has(file))]
}
