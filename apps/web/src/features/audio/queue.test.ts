import { describe, expect, it } from 'vitest'
import {
  appendTracks,
  currentTrack,
  jumpTo,
  moveTrack,
  removeTrack,
  shuffleQueue,
  startQueue,
  stepQueue,
  type Queue,
  type QueuedTrack,
} from './queue'

const track = (name: string): QueuedTrack => ({
  key: name,
  token: null,
  id: crypto.randomUUID(),
  name,
  versionId: crypto.randomUUID(),
  durationMs: 180_000,
  title: null,
  artist: null,
  album: null,
  hasCover: false,
})

const tracks = (...names: string[]) => names.map(track)
/** Leaves each place where it is, so a shuffle keeps the order given: plain to read. */
const keeping = () => 0.999
const playing = (queue: Queue | null) => (queue ? currentTrack(queue)?.name : null)
const played = (queue: Queue) => queue.order.join(' ')

describe('the audio queue (§10.4)', () => {
  it('starts at the track opened, and goes through the rest in order', () => {
    const queue = startQueue(tracks('a', 'b', 'c'), 1, false)
    expect(playing(queue)).toBe('b')
    const next = stepQueue(queue, 1, false)
    expect(playing(next)).toBe('c')
    // At the end it stops, unless it repeats the queue.
    expect(next && stepQueue(next, 1, false)).toBeNull()
    expect(playing(next && stepQueue(next, 1, true))).toBe('a')
    expect(playing(stepQueue(startQueue(tracks('a', 'b'), 0, false), -1, true))).toBe('b')
  })

  it('shuffled, plays the track opened first, then the others, and back in order when turned off', () => {
    const queue = startQueue(tracks('a', 'b', 'c', 'd'), 1, true, keeping)
    expect(played(queue)).toBe('b a c d')
    expect(playing(queue)).toBe('b')
    const on = shuffleQueue(startQueue(tracks('a', 'b', 'c', 'd'), 2, false), true, keeping)
    expect(played(on)).toBe('c a b d')
    const off = shuffleQueue(stepQueue(on, 1, false) ?? on, false)
    expect(played(off)).toBe('a b c d')
    expect(playing(off)).toBe('a')
  })

  it('adds tracks after the rest', () => {
    const queue = appendTracks(startQueue(tracks('a', 'b'), 0, false), tracks('c'), false)
    expect(played(queue)).toBe('a b c')
    expect(playing(queue)).toBe('a')
  })

  it('jumps to a track, and goes on with the next when the one playing is removed', () => {
    const queue = jumpTo(startQueue(tracks('a', 'b', 'c'), 0, false), 'b')
    expect(playing(queue)).toBe('b')
    expect(playing(removeTrack(queue, 'b'))).toBe('c')
    // Removing one before it keeps it playing.
    expect(playing(removeTrack(queue, 'a'))).toBe('b')
    expect(currentTrack(removeTrack(startQueue(tracks('a'), 0, false), 'a'))).toBeNull()
  })

  it('moves a track in the list, the one playing staying the one playing', () => {
    const queue = startQueue(tracks('a', 'b', 'c'), 0, false)
    const moved = moveTrack(queue, 0, 2, false)
    expect(moved.tracks.map((found) => found.name)).toEqual(['b', 'c', 'a'])
    expect(played(moved)).toBe('b c a')
    expect(playing(moved)).toBe('a')
    // Shuffled, the list moves and play order doesn't.
    const shuffled = startQueue(tracks('a', 'b', 'c'), 0, true, keeping)
    expect(played(moveTrack(shuffled, 2, 0, true))).toBe(played(shuffled))
  })
})
