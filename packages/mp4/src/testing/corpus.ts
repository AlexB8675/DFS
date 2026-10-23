// The corpus that the real-file suites read (DESIGN.md §10.4, D45): a manifest of
// the files to check and what each is expected to do, the folders it and the
// ffprobe cache live in, and the reading of a file's index in place. The
// corpus is git-ignored, and the user's videos in it are read where they are:
// nothing is copied, and no fixture is made from their bytes. Tests and scripts
// only: the package itself does no I/O.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mp4Error } from '../errors.ts'
import type { Mp4Refusal } from '../errors.ts'
import { locateMoov, moovIn } from '../locate.ts'
import { readMovie } from '../movie.ts'
import type { Movie } from '../movie.ts'

/** The package's `corpus` folder, which `.gitignore` keeps out of the repository. */
export const corpusDir = fileURLToPath(new URL('../../corpus/', import.meta.url))
/** The files that `corpus:make` writes. */
export const syntheticDir = resolve(corpusDir, 'synthetic')
/** What ffprobe said about each file, keyed by the file's path, size and modification time. */
export const cacheDir = resolve(corpusDir, '.cache')
export const manifestPath = resolve(corpusDir, 'manifest.local.json')

/** One file of the corpus: where it is, what the reader must do with it, and optionally the codec strings it must give (each a prefix, such as `avc1.64`). */
export interface ManifestEntry {
  path: string
  expect: 'plays' | { refused: Mp4Refusal }
  codecs?: { video?: string; audio?: string }
}

const REFUSALS: readonly string[] = [
  'fragmented',
  'no-picture',
  'several-descriptions',
  'edit-list',
  'unsupported-codec',
  'damaged',
]

/** A path as the manifest keeps it: absolute, with forward slashes, so that one file is one key whichever way it was spelled. */
export function manifestKey(path: string): string {
  return resolve(path).replaceAll('\\', '/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryOf(value: unknown, at: number): ManifestEntry {
  const bad = (what: string): Error => new Error(`Entry ${at} of ${manifestPath} ${what}.`)
  if (!isRecord(value)) throw bad('is not an object')
  const { path, expect, codecs } = value
  if (typeof path !== 'string' || path === '') throw bad('has no path')
  let wanted: ManifestEntry['expect']
  if (expect === 'plays') {
    wanted = 'plays'
  } else if (
    isRecord(expect) &&
    typeof expect.refused === 'string' &&
    REFUSALS.includes(expect.refused)
  ) {
    wanted = { refused: expect.refused as Mp4Refusal }
  } else {
    throw bad(`has an expectation that is neither 'plays' nor { refused: <reason> }`)
  }
  const entry: ManifestEntry = { path, expect: wanted }
  if (codecs !== undefined) {
    if (!isRecord(codecs)) throw bad('has codecs that are not an object')
    const { video, audio } = codecs
    if (
      (video !== undefined && typeof video !== 'string') ||
      (audio !== undefined && typeof audio !== 'string')
    ) {
      throw bad('has a codec that is not a string')
    }
    entry.codecs = {
      ...(typeof video === 'string' ? { video } : {}),
      ...(typeof audio === 'string' ? { audio } : {}),
    }
  }
  return entry
}

/** Every entry of the manifest, whether its file is there or not; none when there is no manifest. */
export function readManifest(): ManifestEntry[] {
  if (!existsSync(manifestPath)) return []
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    throw new Error(`${manifestPath} is not a { files: [...] } manifest.`)
  }
  return (parsed.files as unknown[]).map(entryOf)
}

export async function writeManifest(entries: readonly ManifestEntry[]): Promise<void> {
  mkdirSync(corpusDir, { recursive: true })
  await writeFile(manifestPath, JSON.stringify({ files: entries }, null, 2) + '\n')
}

/**
 * The entries with `added` in them, keyed by path. A path that is in both stays
 * as it was unless `replace` is set, which `corpus:make` does for its own
 * files, whose expectations it owns; a new path goes at the end.
 */
export function mergeEntries(
  existing: readonly ManifestEntry[],
  added: readonly ManifestEntry[],
  replace: boolean,
): ManifestEntry[] {
  const byKey = new Map(existing.map((entry) => [manifestKey(entry.path), entry]))
  for (const entry of added) {
    const key = manifestKey(entry.path)
    if (replace || !byKey.has(key)) byKey.set(key, { ...entry, path: key })
  }
  return [...byKey.values()]
}

/** The entries whose files are there, saying once how many are not. */
export function loadManifest(): ManifestEntry[] {
  const all = readManifest()
  const present = all.filter((entry) => existsSync(entry.path))
  if (present.length < all.length) {
    console.warn(`${all.length - present.length} of ${all.length} corpus files are missing.`)
  }
  return present
}

/** `length` bytes of the file from `position`, or fewer where the file ends. */
export function readRange(path: string, position: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  const fd = openSync(path, 'r')
  try {
    let filled = 0
    while (filled < length) {
      const got = readSync(fd, out, filled, length - filled, position + filled)
      if (got === 0) break
      filled += got
    }
    return filled === length ? out : out.subarray(0, filled)
  } finally {
    closeSync(fd)
  }
}

/** How much of a file's start is read to find its index (§10.4): the same 1 MiB that the player will fetch. */
export const HEAD_BYTES = 1024 * 1024

/**
 * A file's movie, read in place as the player will read it: the first 1 MiB to
 * find the `moov`, then that range only, from which `moovIn` takes the `moov`
 * (past the `free` or other boxes that may come before it). Throws what
 * `locateMoov`, `moovIn` and `readMovie` throw (`Mp4Error` for a file that is
 * turned away), and an `Mp4Error('damaged')` for a file with no `moov` to be found.
 */
export function readIndex(path: string, fileSize: number): Movie {
  const found = locateMoov(readRange(path, 0, Math.min(HEAD_BYTES, fileSize)), fileSize)
  if (!found) throw new Mp4Error('damaged', 'No moov was found in the file.')
  return readMovie(moovIn(readRange(path, found.start, found.end - found.start)))
}

/**
 * Whether a path is a file in the synthetic folder, by where it is and not by how
 * it is spelled: the separators and, on Windows, the case of the drive letter
 * don't matter, and a folder that only begins like it (`synthetic-other`) is
 * not it.
 */
export function isSynthetic(path: string): boolean {
  const from = relative(syntheticDir, path)
  return from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)
}

/**
 * A title for each path, for the test names: the folder's name and the file's
 * (`Final/a.mp4`), never the whole path, and different for every path: a title
 * that an earlier path has is given ` (2)`, ` (3)` and so on.
 */
export function uniqueTitles(paths: readonly string[]): string[] {
  const used = new Set<string>()
  return paths.map((path) => {
    const normal = path.replaceAll('\\', '/')
    const title = `${posix.basename(posix.dirname(normal))}/${posix.basename(normal)}`
    let unique = title
    for (let n = 2; used.has(unique); n += 1) unique = `${title} (${n})`
    used.add(unique)
    return unique
  })
}
