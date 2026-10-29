import { describe, expect, it } from 'vitest'
import { findCluster } from '../matroska/clusters.ts'
import { LEAST_CLUSTER, virtualFile } from './virtual.ts'

// The virtual file of the seek tests (DESIGN.md §10.4): the bytes of any range are
// those of the whole file, and the clusters in them are ones the reader finds, each
// with the Timestamp it was given. The seek tests play from a landing in a small
// one, so that its keyframes are shown to be keyframes.

const HEAD = Uint8Array.from({ length: 100 }, (_, at) => at)

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('expected a value')
  return value
}

describe('a virtual file', () => {
  const clusters = [
    { size: LEAST_CLUSTER, timestamp: 0 },
    { size: LEAST_CLUSTER + 1000, timestamp: 2000 },
    { size: LEAST_CLUSTER + 50_000, timestamp: 4000 },
    { size: LEAST_CLUSTER + 7, timestamp: 70_000 },
  ]
  const file = virtualFile(HEAD, clusters)

  it('lays the clusters one after the other from the end of the head', () => {
    expect(file.first).toBe(HEAD.length)
    expect(file.starts).toEqual([
      HEAD.length,
      HEAD.length + LEAST_CLUSTER,
      HEAD.length + 2 * LEAST_CLUSTER + 1000,
      HEAD.length + 3 * LEAST_CLUSTER + 51_000,
    ])
    expect(file.total).toBe(HEAD.length + 4 * LEAST_CLUSTER + 51_007)
  })

  it('gives the same bytes for a range as the whole file has there, however it is cut', () => {
    const whole = file.bytes({ start: 0, end: file.total })
    expect(whole).toHaveLength(file.total)
    expect(whole.subarray(0, HEAD.length)).toEqual(HEAD)
    for (const [start, end] of [
      [0, 1],
      [50, 130],
      [HEAD.length, HEAD.length + 40],
      [file.starts[1] ?? 0, (file.starts[1] ?? 0) + 5],
      [(file.starts[1] ?? 0) - 3, (file.starts[1] ?? 0) + 20],
      [file.starts[2] ?? 0, file.total],
      [file.total - 20, file.total],
      [100_000, 100_000],
    ] as const) {
      expect(file.bytes({ start, end })).toEqual(whole.subarray(start, end))
    }
    expect(() => file.bytes({ start: 0, end: file.total + 1 })).toThrow(RangeError)
  })

  it('holds clusters the reader finds, each with the Timestamp and the size given', () => {
    const whole = file.bytes({ start: 0, end: file.total })
    const chunk = { start: 0, bytes: whole }
    for (const [which, cluster] of clusters.entries()) {
      const start = must(file.starts[which])
      const found = must(findCluster(chunk, start, file.total))
      expect(found.start).toBe(start)
      expect(found.place.timestamp).toBe(cluster.timestamp)
      expect(found.place.end).toBe(start + cluster.size)
      expect(found.place.sized).toBe(true)
    }
  })

  it('refuses a cluster too short to hold its blocks', () => {
    expect(() => virtualFile(HEAD, [{ size: LEAST_CLUSTER - 1, timestamp: 0 }])).toThrow(RangeError)
  })
})
