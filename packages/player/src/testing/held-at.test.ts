import { describe, expect, it } from 'vitest'
import { heldAt, neededVideoEnd } from './held-at.ts'

// The moment the store held the bytes a picture needs, from the reads that resolved (DESIGN.md §10.4, R50).

/** No byte was held when the seek began, but those that a read brought. */
const never = (): boolean => false

describe('heldAt', () => {
  it('is the latest, over the needed ends, of when the read that covers the last byte resolved after the mark', () => {
    const reads = [
      { start: 0, end: 1000, at: 150 },
      { start: 1000, end: 3000, at: 220 },
    ]
    expect(heldAt(reads, 100, [900, 2500], 'a seek', never)).toBe(220)
  })

  it('takes the union of the reads: a needed end that lies in the later of two reads that follow each other is covered', () => {
    const reads = [
      { start: 500, end: 1000, at: 130 },
      { start: 1000, end: 2000, at: 180 },
    ]
    expect(heldAt(reads, 100, [1800], 'a seek', never)).toBe(180)
  })

  it('is the mark when every needed byte was held before the seek: the whole seek is the time', () => {
    // The only read that covers the bytes resolved before the mark: the store had them already.
    const reads = [{ start: 0, end: 5000, at: 40 }]
    expect(heldAt(reads, 100, [4000], 'a seek', never)).toBe(100)
  })

  it('is the mark for a read that resolved after the mark for one end and before it for another', () => {
    const reads = [
      { start: 0, end: 1000, at: 40 },
      { start: 1000, end: 2000, at: 160 },
    ]
    expect(heldAt(reads, 100, [900, 1900], 'a seek', never)).toBe(160)
  })

  it('fails naming the bytes when no read covered them, before the mark or after it', () => {
    const reads = [{ start: 0, end: 1000, at: 150 }]
    expect(() => heldAt(reads, 100, [1500], 'a seek', never)).toThrow(
      'The measure of a seek found no read that covers the bytes up to 1500.',
    )
  })

  it('says nothing when there is nothing needed', () => {
    expect(heldAt([], 100, [], 'a seek', never)).toBeNull()
  })

  it('is the mark for bytes that the store already held when the seek began, though no read brought them (the onward download did)', () => {
    // The eager download wrote them; no `Downloader.read` was made, and the whole seek is the time.
    const held = (end: number): boolean => end <= 4000
    expect(heldAt([], 100, [3000, 4000], 'a seek', held)).toBe(100)
  })

  it('still fails when some needed byte was neither held at the mark nor covered by a read', () => {
    const held = (end: number): boolean => end <= 4000
    expect(() => heldAt([], 100, [3000, 5000], 'a seek', held)).toThrow(
      'The measure of a seek found no read that covers the bytes up to 5000.',
    )
  })
})

describe('neededVideoEnd', () => {
  const ends = [100, 200, 300, 400, 500]

  it('ends at the latest frame that was covered when the picture showed: its reorder frames, not yet read, were not needed (R51)', () => {
    // The picture showed (frame 1) before the read of the frames after it brought them.
    const covered = (end: number): boolean => end <= 200
    expect(neededVideoEnd(ends, 1, covered, 'a seek')).toBe(200)
  })

  it('takes in the reorder frames that were covered, up to the latest of them', () => {
    const covered = (end: number): boolean => end <= 400
    expect(neededVideoEnd(ends, 1, covered, 'a seek')).toBe(400)
  })

  it('is the largest end among the frames up to the latest covered one, whatever their order in the file', () => {
    expect(neededVideoEnd([300, 100, 200], 0, (end) => end !== 200, 'a seek')).toBe(300)
  })

  it('fails naming the bytes when not even the shown frame was covered', () => {
    const covered = (end: number): boolean => end <= 100
    expect(() => neededVideoEnd(ends, 1, covered, 'a seek')).toThrow(
      'The measure of a seek found no read that covers the bytes up to 200.',
    )
  })
})

describe('neededVideoEnd, the shown frame', () => {
  it('fails when the shown frame was not covered, though a frame after it was', () => {
    const covered = (end: number): boolean => end !== 200
    expect(() => neededVideoEnd([100, 200, 300], 1, covered, 'a seek')).toThrow('up to 200.')
  })
})
