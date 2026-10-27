import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { box, fourcc } from './build.ts'
import { containerOf, corpusDir, isSynthetic, syntheticDir, uniqueTitles } from './corpus.ts'
import { matroskaMovie } from './ebml.ts'

// The corpus manifest's helpers (DESIGN.md §10.4): which files are the synthetic
// ones, which container a file is in, and the titles that the corpus test gives
// to files.

describe('containerOf', () => {
  let folder: string
  const write = (name: string, bytes: Uint8Array | string): string => {
    const path = resolve(folder, name)
    writeFileSync(path, bytes)
    return path
  }

  beforeAll(() => {
    folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-container-'))
  })

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('is matroska for a built Matroska file, whatever its extension says', () => {
    const file = matroskaMovie({
      tracks: [{ number: 1, type: 1, codecId: 'V_VP9' }],
      clusters: [{ timestamp: 0, frames: [{ track: 1, time: 0, keyframe: true }] }],
    })
    expect(containerOf(write('built.mkv', file.bytes))).toBe('matroska')
    expect(containerOf(write('misnamed.mp4', file.bytes))).toBe('matroska')
  })

  it('is mp4 for a built MP4, which starts with a file type box', () => {
    const file = box('ftyp', fourcc('isom'), [0, 0, 2, 0], fourcc('isom'))
    expect(containerOf(write('built.mp4', file))).toBe('mp4')
    expect(containerOf(write('misnamed.mkv', file))).toBe('mp4')
  })

  it('is null for a text file, an empty file and a file too short to say', () => {
    expect(
      containerOf(write('notes.txt', 'Not a video, but long enough to be looked at.')),
    ).toBeNull()
    expect(containerOf(write('empty.mp4', new Uint8Array(0)))).toBeNull()
    expect(containerOf(write('short.mkv', Uint8Array.of(0x1a, 0x45, 0xdf)))).toBeNull()
  })

  it('reads the file where it is, and throws for one that is not there', () => {
    expect(() => containerOf(resolve(folder, 'missing.mp4'))).toThrow()
  })
})

describe('isSynthetic', () => {
  it('is true for a file in the synthetic folder, however the path is spelled', () => {
    expect(isSynthetic(resolve(syntheticDir, 'a.mp4'))).toBe(true)
    expect(isSynthetic(resolve(syntheticDir, 'a.mp4').replaceAll('\\', '/'))).toBe(true)
  })

  it('is false for a folder with the same start, one beside it, and the folder itself', () => {
    expect(isSynthetic(resolve(corpusDir, 'synthetic-other', 'a.mp4'))).toBe(false)
    expect(isSynthetic(resolve(corpusDir, 'a.mp4'))).toBe(false)
    expect(isSynthetic(syntheticDir)).toBe(false)
    expect(isSynthetic(resolve(syntheticDir, '..foo.mp4'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('does not mind the case of the drive letter', () => {
    const path = resolve(syntheticDir, 'a.mp4')
    const flipped = path.replace(/^[A-Za-z]/, (letter) =>
      letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase(),
    )
    expect(flipped).not.toBe(path)
    expect(isSynthetic(flipped)).toBe(true)
  })
})

describe('uniqueTitles', () => {
  it('names a file by its folder and its name, and never by the whole path', () => {
    expect(uniqueTitles(['D:/Media/Recordings/a.mp4', 'E:/Pictures/Trip/b.mov'])).toEqual([
      'Recordings/a.mp4',
      'Trip/b.mov',
    ])
  })

  it('tells apart files of the same name in folders of the same name', () => {
    const titles = uniqueTitles([
      'D:/Media/Final/a.mp4',
      'E:/Other/Final/a.mp4',
      'F:/Final/a.mp4',
      'D:/Media/Final/b.mp4',
    ])
    expect(titles).toEqual(['Final/a.mp4', 'Final/a.mp4 (2)', 'Final/a.mp4 (3)', 'Final/b.mp4'])
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('reads a path with backslashes too', () => {
    expect(uniqueTitles(['D:\\Media\\Final\\a.mp4'])).toEqual(['Final/a.mp4'])
  })
})
