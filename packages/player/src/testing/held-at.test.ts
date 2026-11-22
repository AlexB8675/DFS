import { describe, expect, it } from 'vitest'
import { heldAt, lastNeededFrame, neededVideoEnd, seekHeldToSecond } from './held-at.ts'

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

describe('heldAt, bytes held at the mark', () => {
  it('is the mark for bytes the store held then, though a read made after the mark returned them later (R54)', () => {
    // The read of the engine from the store resolved at 180, but the bytes were there at the mark.
    const reads = [{ start: 0, end: 5000, at: 180 }]
    expect(heldAt(reads, 100, [4000], 'a seek', (end) => end <= 4000)).toBe(100)
  })

  it('still takes the read for a byte that the store did not hold at the mark', () => {
    const reads = [{ start: 0, end: 5000, at: 180 }]
    expect(heldAt(reads, 100, [4000, 4500], 'a seek', (end) => end <= 4000)).toBe(180)
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

describe('seekHeldToSecond', () => {
  it('holds a seek to the second when its bytes cross the link in half a second or less', () => {
    expect(seekHeldToSecond(15_000_000, 31_400_000)).toBe(true)
    expect(seekHeldToSecond(10_000_000, 20_000_000)).toBe(true)
  })

  it('does not when the bytes need more than half a second on the link', () => {
    // A 30 MB group on a 31.4 MB/s link: 0.95 s on the wire alone.
    expect(seekHeldToSecond(30_000_000, 31_400_000)).toBe(false)
    expect(seekHeldToSecond(10_000_001, 20_000_000)).toBe(false)
  })

  it('holds a seek that has no bytes to cross', () => {
    expect(seekHeldToSecond(0, 12_500_000)).toBe(true)
  })
})

describe('lastNeededFrame', () => {
  const sync = Uint8Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])

  it('is the shown frame plus the reorder frames inside the group', () => {
    expect(lastNeededFrame(sync, 1, 12, 2)).toBe(3)
  })

  it('stops before the next keyframe: the next group is never needed (R54)', () => {
    // Frame 3 is shown; the reorder frames would reach 7, but frame 5 begins the next group.
    expect(lastNeededFrame(sync, 3, 12, 4)).toBe(4)
  })

  it('stops at the last frame of the file', () => {
    expect(lastNeededFrame(sync, 11, 12, 8)).toBe(11)
    expect(lastNeededFrame(sync, 10, 12, 8)).toBe(11)
  })

  it('is the shown frame itself when the next frame is a keyframe', () => {
    expect(lastNeededFrame(sync, 4, 12, 8)).toBe(4)
  })
})
