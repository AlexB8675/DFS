import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanFolder } from './profile-scan.ts'

// The HTTP cache check of the plays suite looks in a browser's profile folder for a run of a file's bytes
// (DESIGN.md §10.4). The browser cannot read its own profile, so a command on the Node side does.

const folders: string[] = []

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), 'dfs-scan-test-'))
  folders.push(made)
  return made
}

afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

const run = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)

describe('scanFolder', () => {
  it('counts the files, at any depth, that hold the run', () => {
    const root = folder()
    mkdirSync(join(root, 'Default', 'Cache'), { recursive: true })
    writeFileSync(join(root, 'top'), Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9))
    writeFileSync(
      join(root, 'Default', 'Cache', 'deep'),
      Uint8Array.of(9, 9, 1, 2, 3, 4, 5, 6, 7, 8),
    )
    writeFileSync(join(root, 'Default', 'other'), Uint8Array.of(1, 2, 3, 4, 5, 6, 7))
    expect(scanFolder(root, run)).toEqual({
      scanned: 3,
      holding: 2,
      unreadable: 0,
      where: [join('Default', 'Cache', 'deep'), 'top'].sort(),
    })
  })

  it('is 0 for a folder that holds nothing of the run, or is empty, or is not there', () => {
    const root = folder()
    expect(scanFolder(root, run)).toEqual({ scanned: 0, holding: 0, unreadable: 0, where: [] })
    writeFileSync(join(root, 'a'), Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1))
    expect(scanFolder(root, run)).toEqual({ scanned: 1, holding: 0, unreadable: 0, where: [] })
    expect(scanFolder(join(root, 'missing'), run)).toEqual({
      scanned: 0,
      holding: 0,
      unreadable: 0,
      where: [],
    })
  })
})
