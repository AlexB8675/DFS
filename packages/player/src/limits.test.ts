import { describe, expect, it } from 'vitest'
import {
  APPEND_WINDOW_PAD_SECONDS,
  BLOCK_BYTES,
  CHUNK_BYTES,
  COVER_AHEAD_MS,
  DISK_CAP_BYTES,
  DISK_FLOOR_BYTES,
  ESTIMATE_MS,
  FEED_STEP_SECONDS,
  FRONTIER_BLOCKS,
  GAP_EDGE_SECONDS,
  GAP_STEP_SECONDS,
  HEAD_BYTES,
  INDEX_CACHE_BYTES,
  LATE_TIMER_MS,
  LEVEL_EVERY_MS,
  MAX_CHUNK_BYTES,
  MEMORY_CAP_BYTES,
  POSITION_EVERY_MS,
  QUOTA_SHRINK,
  QUOTA_SHARE,
  RATE_WINDOW_MS,
  READ_IDLE_MS,
  REOPENS_MAX,
  RETRY_BASE_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
  SEEK_DEADLINE_MS,
  SOUND_WAIT_SECONDS,
  START_GOAL_SECONDS,
  STALL_COVER_MS,
  STALL_GOAL_SECONDS,
  STUCK_MS,
  STORE_CALL_MS,
  STORE_OPEN_MS,
  TAIL_BYTES,
  WAKE_GRACE_MS,
  WATCH_EVERY_MS,
  WINDOW_AHEAD_SECONDS,
  WINDOW_BEHIND_SECONDS,
  WINDOW_BYTES,
  WINDOW_FLOOR_BYTES,
  WINDOW_MIN_AHEAD_SECONDS,
} from './limits.ts'

// The store's and the downloader's bounds (DESIGN.md §10.4): each is a number the
// spec or the plan names, so a change to one is a change of the store's behaviour
// and is made here first.

describe('the store and the downloader limits', () => {
  it('stores, seals and evicts in blocks of 1 MiB', () => {
    expect(BLOCK_BYTES).toBe(1024 * 1024)
  })

  it('caps the disk store at 2 GiB, takes 80% of the free quota, and gives up below 64 MiB', () => {
    expect(DISK_CAP_BYTES).toBe(2 * 1024 ** 3)
    expect(QUOTA_SHARE).toBe(0.8)
    expect(DISK_FLOOR_BYTES).toBe(64 * 1024 * 1024)
  })

  it('caps the memory fallback at 256 MiB and keeps 8 frontier blocks outside the cap', () => {
    expect(MEMORY_CAP_BYTES).toBe(256 * 1024 * 1024)
    expect(FRONTIER_BLOCKS).toBe(8)
  })

  it('retries after 500 ms, doubling to at most 30 s, with 20% of jitter', () => {
    expect(RETRY_BASE_MS).toBe(500)
    expect(RETRY_MAX_MS).toBe(30_000)
    expect(RETRY_JITTER).toBe(0.2)
  })

  it('measures the rate over 5 s and reports the store level every 5 s', () => {
    expect(RATE_WINDOW_MS).toBe(5_000)
    expect(LEVEL_EVERY_MS).toBe(5_000)
  })

  it('makes the first read of a play 1 MiB', () => {
    expect(HEAD_BYTES).toBe(1024 * 1024)
  })

  it('gives a request to the worker of the store 15 s, its opening 30 s, and the browser 5 s for its estimate', () => {
    expect(STORE_CALL_MS).toBe(15_000)
    expect(STORE_OPEN_MS).toBe(30_000)
    expect(ESTIMATE_MS).toBe(5_000)
  })

  it('takes a timer that fires 1 s late for a page that stood still, and gives its request 2 s more', () => {
    expect(LATE_TIMER_MS).toBe(1_000)
    expect(WAKE_GRACE_MS).toBe(2_000)
  })

  it('gives up on a read that has been silent for 10 s, and takes one that has not moved for 2 s as not covering anything', () => {
    expect(READ_IDLE_MS).toBe(10_000)
    expect(STALL_COVER_MS).toBe(2_000)
    expect(STALL_COVER_MS).toBeLessThan(READ_IDLE_MS)
  })

  it('counts a place as covered by a read when the read will be there within half a second', () => {
    expect(COVER_AHEAD_MS).toBe(500)
  })

  it('takes whole blocks as the floor of the disk store and the cap of the memory', () => {
    expect(DISK_FLOOR_BYTES % BLOCK_BYTES).toBe(0)
    expect(MEMORY_CAP_BYTES % BLOCK_BYTES).toBe(0)
  })

  it('keeps 5 s behind and reaches 30 s ahead in a window of 64 MiB, which shrinks by a quarter per quota error to 16 MiB', () => {
    expect(WINDOW_BEHIND_SECONDS).toBe(5)
    expect(WINDOW_AHEAD_SECONDS).toBe(30)
    expect(WINDOW_BYTES).toBe(64 * 1024 * 1024)
    expect(QUOTA_SHRINK).toBe(0.75)
    expect(WINDOW_FLOOR_BYTES).toBe(16 * 1024 * 1024)
    expect(WINDOW_FLOOR_BYTES).toBeLessThan(WINDOW_BYTES)
    expect(WINDOW_MIN_AHEAD_SECONDS).toBe(1)
    expect(FEED_STEP_SECONDS).toBe(1)
    expect(GAP_STEP_SECONDS).toBe(2)
    expect(GAP_EDGE_SECONDS).toBe(0.25)
  })

  it('reads 1 MiB at a cursor and doubles to 32 MiB, reads 1 MiB of the file end, and keeps 40 MiB of the index chunks', () => {
    expect(CHUNK_BYTES).toBe(1024 * 1024)
    expect(MAX_CHUNK_BYTES).toBe(32 * 1024 * 1024)
    expect(TAIL_BYTES).toBe(1024 * 1024)
    expect(INDEX_CACHE_BYTES).toBe(40 * 1024 * 1024)
  })

  it('gives the downloader the playhead every second, and holds for 2 s at the start and 4 s after a stall', () => {
    expect(POSITION_EVERY_MS).toBe(1_000)
    expect(START_GOAL_SECONDS).toBe(2)
    expect(STALL_GOAL_SECONDS).toBe(4)
  })

  it('gives a seek 10 s, takes 2 s without movement as stuck, watches every 500 ms and reopens at most 3 times', () => {
    expect(SEEK_DEADLINE_MS).toBe(10_000)
    expect(STUCK_MS).toBe(2_000)
    expect(WATCH_EVERY_MS).toBe(500)
    expect(REOPENS_MAX).toBe(3)
  })

  it('waits for a sound through 3 s of picture before the play goes on without one', () => {
    expect(SOUND_WAIT_SECONDS).toBe(3)
  })

  it('pads the append window of a track by 1 ms', () => {
    expect(APPEND_WINDOW_PAD_SECONDS).toBe(0.001)
  })
})
