import { describe, expect, it } from 'vitest'
import { POSITIONS_MAX, Positions } from './positions.ts'
import type { FedRun } from './window.ts'

// Where in the file each time that was fed lies (DESIGN.md §10.4): the byte
// offset the downloader is told to read around when the playhead is there.

function run(
  kind: 'video' | 'audio',
  start: number,
  end: number,
  offset: number,
): FedRun & { offset: number } {
  return { kind, start, end, bytes: 100, keyframe: kind === 'audio' || start === 0, offset }
}

describe('Positions', () => {
  it('answers null when nothing was fed', () => {
    expect(new Positions().offsetAt(1)).toBeNull()
  })

  it('answers the offset of the run that covers a time, the start included and the end not', () => {
    const positions = new Positions()
    positions.add(run('video', 0, 1, 1000))
    positions.add(run('video', 1, 2, 5000))
    expect(positions.offsetAt(0)).toBe(1000)
    expect(positions.offsetAt(0.5)).toBe(1000)
    expect(positions.offsetAt(1)).toBe(5000)
    expect(positions.offsetAt(1.99)).toBe(5000)
  })

  it('answers the picture’s offset, whatever the sound’s runs are', () => {
    const positions = new Positions()
    // A file of all picture and then all sound.
    positions.add(run('video', 0, 1, 1000))
    positions.add(run('audio', 0, 0.5, 900_000))
    positions.add(run('audio', 0.5, 1.5, 910_000))
    expect(positions.offsetAt(0.25)).toBe(1000)
    expect(positions.offsetAt(0.75)).toBe(1000)
    // A file of all sound and then all picture: the picture's offset, not the least.
    const soundFirst = new Positions()
    soundFirst.add(run('audio', 0, 1, 100))
    soundFirst.add(run('video', 0, 1, 800_000))
    expect(soundFirst.offsetAt(0.5)).toBe(800_000)
  })

  it('answers the nearest picture run at or before a time that only the sound covers, and null before any', () => {
    const positions = new Positions()
    positions.add(run('audio', 0, 4, 40))
    positions.add(run('video', 0.033, 1, 300))
    positions.add(run('video', 1.5, 2, 700))
    // The picture's first frame is shown at 0.033 s: nothing of the picture is before 0.
    expect(positions.offsetAt(0)).toBeNull()
    // In a gap of the picture that the sound covers: the picture run before it.
    expect(positions.offsetAt(1.2)).toBe(300)
    expect(positions.offsetAt(3)).toBe(700)
  })

  it('answers the nearest run at or before a time that none covers, and null before them all', () => {
    const positions = new Positions()
    positions.add(run('video', 2, 3, 2000))
    positions.add(run('video', 5, 6, 5000))
    expect(positions.offsetAt(1)).toBeNull()
    // In the gap: the run before it.
    expect(positions.offsetAt(4)).toBe(2000)
    // After the last.
    expect(positions.offsetAt(9)).toBe(5000)
  })

  it('takes the picture run that ends nearest the time, the least offset of those that end together', () => {
    const positions = new Positions()
    positions.add(run('video', 0, 3, 100))
    positions.add(run('audio', 0, 4, 40))
    positions.add(run('video', 3, 3.5, 300))
    positions.add(run('video', 3, 3.5, 250))
    expect(positions.offsetAt(10)).toBe(250)
  })

  it('forgets everything on clear', () => {
    const positions = new Positions()
    positions.add(run('video', 0, 1, 1000))
    positions.clear()
    expect(positions.offsetAt(0.5)).toBeNull()
    positions.add(run('video', 0, 1, 2000))
    expect(positions.offsetAt(0.5)).toBe(2000)
  })

  it('keeps the newest runs when a play has fed more than it can hold, dropping the oldest', () => {
    const positions = new Positions()
    const total = POSITIONS_MAX + 10
    for (let at = 0; at < total; at++) positions.add(run('video', at, at + 1, at * 10))
    // The first ten are gone: the nearest at or before them is nothing.
    expect(positions.offsetAt(0.5)).toBeNull()
    expect(positions.offsetAt(9.5)).toBeNull()
    expect(positions.offsetAt(10.5)).toBe(100)
    expect(positions.offsetAt(total - 0.5)).toBe((total - 1) * 10)
  })
})
