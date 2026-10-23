import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { corpusDir, isSynthetic, syntheticDir, uniqueTitles } from './corpus.ts'

// The corpus manifest's helpers (DESIGN.md §10.4): which files are the synthetic
// ones, and the titles that the corpus test gives to files.

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
