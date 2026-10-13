import { chunkFrameLength } from '@dfs/crypto'
import { describe, expect, it } from 'vitest'
import { framedBytes } from './framed-bytes.ts'

describe('framedBytes (§6.1, D38)', () => {
  const chunk = 1000

  it('adds up the frame of each part, the last one shorter', () => {
    expect(framedBytes(0, chunk)).toBe(0)
    expect(framedBytes(1, chunk)).toBe(chunkFrameLength(1))
    expect(framedBytes(chunk, chunk)).toBe(chunkFrameLength(chunk))
    expect(framedBytes(chunk + 1, chunk)).toBe(chunkFrameLength(chunk) + chunkFrameLength(1))
    expect(framedBytes(3 * chunk + 5, chunk)).toBe(
      3 * chunkFrameLength(chunk) + chunkFrameLength(5),
    )
  })

  it('counts only the parts from the one given', () => {
    expect(framedBytes(3 * chunk + 5, chunk, 2)).toBe(chunkFrameLength(chunk) + chunkFrameLength(5))
    expect(framedBytes(3 * chunk + 5, chunk, 3)).toBe(chunkFrameLength(5))
    expect(framedBytes(3 * chunk + 5, chunk, 4)).toBe(0)
  })
})
