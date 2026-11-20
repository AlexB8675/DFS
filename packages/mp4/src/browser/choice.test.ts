import { describe, expect, it } from 'vitest'
import { fragmentRuns, pictureEnd } from '../index.ts'
import * as choice from './choice.ts'
import { filesToPlay } from './choice.ts'
import type { Candidate } from './choice.ts'

// Which files the browser suites play (DESIGN.md §10.4, D45): chosen from names,
// sizes and durations alone, so it is checked here, in Node, with invented ones.

function synthetic(name: string): Candidate {
  return { name, size: 1000, synthetic: true, expect: 'plays' }
}

function theirs(name: string, size: number): Candidate {
  return { name, size, synthetic: false, expect: 'plays' }
}

/** Twenty files of the user's kind, the larger the earlier in the name's order, so that neither order is the other's reverse by accident. */
function twenty(): Candidate[] {
  return Array.from({ length: 20 }, (_, at) =>
    theirs(`clip-${String(at).padStart(2, '0')}.mp4`, 100 - at * 3),
  )
}

const names = (files: readonly Candidate[]): string[] => files.map((file) => file.name)

describe('filesToPlay', () => {
  it('plays every synthetic file expected to play, and none that is expected to be refused', () => {
    const files: Candidate[] = [
      synthetic('b.mp4'),
      synthetic('a.mov'),
      { name: 'fragmented.mp4', size: 5, synthetic: true, expect: { refused: 'fragmented' } },
      { name: 'refused-theirs.mp4', size: 5, synthetic: false, expect: { refused: 'damaged' } },
    ]
    expect(names(filesToPlay(files, false))).toEqual(['a.mov', 'b.mp4'])
    expect(names(filesToPlay(files, true))).toEqual(['a.mov', 'b.mp4'])
  })

  it('takes the three largest of the user files, then nine evenly spaced through the rest, by name', () => {
    // clip-00 is the largest, then clip-01 and clip-02. The other 17 are clip-03 to clip-19, and
    // nine of them are at round(i * 16 / 8) = 0, 2, 4, ... 16: every other one, from the first to the last.
    expect(names(filesToPlay(twenty(), false))).toEqual([
      'clip-00.mp4',
      'clip-01.mp4',
      'clip-02.mp4',
      'clip-03.mp4',
      'clip-05.mp4',
      'clip-07.mp4',
      'clip-09.mp4',
      'clip-11.mp4',
      'clip-13.mp4',
      'clip-15.mp4',
      'clip-17.mp4',
      'clip-19.mp4',
    ])
  })

  it('chooses by name and size alone: the order the files come in makes no difference', () => {
    const forward = twenty()
    const backward = [...forward].reverse()
    const shuffled = [...forward].sort((a, b) => (a.size % 7) - (b.size % 7) || a.size - b.size)
    expect(names(filesToPlay(backward, false))).toEqual(names(filesToPlay(forward, false)))
    expect(names(filesToPlay(shuffled, false))).toEqual(names(filesToPlay(forward, false)))
  })

  it('puts the synthetic files before the user files, each group by name', () => {
    const picked = names(filesToPlay([...twenty(), synthetic('z.mp4'), synthetic('a.mp4')], false))
    expect(picked.slice(0, 2)).toEqual(['a.mp4', 'z.mp4'])
    expect(picked).toHaveLength(2 + 12)
    expect(picked.slice(2)).toEqual([...picked.slice(2)].sort())
  })

  it('breaks a tie in size by name, so that the three largest are the same on every run', () => {
    // Five files tie for the largest: the first three by name are the three largest.
    const tied = ['d', 'a', 'c', 'b', 'e'].map((letter) => theirs(`${letter}.mp4`, 50))
    const small = Array.from({ length: 12 }, (_, at) =>
      theirs(`small-${String(at).padStart(2, '0')}.mp4`, 1),
    )
    const picked = names(filesToPlay([...tied, ...small], false))
    expect(picked).toHaveLength(12)
    expect(picked.slice(0, 3)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    // The rest are chosen from the others by name: d and e come before the small ones, and may be among them.
    expect(picked).toEqual([...picked].sort())
  })

  it('takes every user file when there are twelve or fewer, and none when there are none', () => {
    const twelve = twenty().slice(0, 12)
    expect(names(filesToPlay(twelve, false))).toEqual(names(twelve))
    expect(filesToPlay(twenty().slice(0, 5), false)).toHaveLength(5)
    expect(filesToPlay([], false)).toEqual([])
    expect(filesToPlay([synthetic('only.mp4')], false)).toHaveLength(1)
  })

  it('takes twelve different files of thirteen', () => {
    const picked = names(filesToPlay(twenty().slice(0, 13), false))
    expect(picked).toHaveLength(12)
    expect(new Set(picked).size).toBe(12)
  })

  it('plays every user file expected to play when all are asked for', () => {
    const all = filesToPlay([...twenty(), synthetic('s.mp4')], true)
    expect(all).toHaveLength(21)
    expect(names(all)[0]).toBe('s.mp4')
  })
})

describe('what the choice gives again', () => {
  it("is the package's fragmentRuns and pictureEnd, for the browser suites that import them from here", () => {
    expect(choice.fragmentRuns).toBe(fragmentRuns)
    expect(choice.pictureEnd).toBe(pictureEnd)
  })
})
