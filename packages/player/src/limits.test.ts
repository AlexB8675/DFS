import { describe, expect, it } from 'vitest'
import {
  BLOCK_BYTES,
  DISK_CAP_BYTES,
  DISK_FLOOR_BYTES,
  ESTIMATE_MS,
  FRONTIER_BLOCKS,
  HEAD_BYTES,
  LEVEL_EVERY_MS,
  MEMORY_CAP_BYTES,
  QUOTA_SHARE,
  RATE_WINDOW_MS,
  RETRY_BASE_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
  STORE_CALL_MS,
  STORE_OPEN_MS,
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

  it('takes whole blocks as the floor of the disk store and the cap of the memory', () => {
    expect(DISK_FLOOR_BYTES % BLOCK_BYTES).toBe(0)
    expect(MEMORY_CAP_BYTES % BLOCK_BYTES).toBe(0)
  })
})
