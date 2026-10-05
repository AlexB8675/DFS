import { generateDek, importAesKey } from '@dfs/crypto'
import { Staging } from '@dfs/storage'
import { describe, expect, it, vi } from 'vitest'
import { stageFrame } from './stage-frame.ts'

describe('staging under load', () => {
  it('limits overlapping hashes while durable writes are pending', async () => {
    const key = await importAesKey(generateDek())
    const staging = new Staging('unused-staging-test')
    const release = Promise.withResolvers<undefined>()
    const write = vi.spyOn(staging, 'write').mockImplementation(() => release.promise)
    const hash = vi.spyOn(crypto.subtle, 'digest')
    const pending = Array.from({ length: 4 }, (_, index) =>
      stageFrame(staging, String(index), key, new Uint8Array(3), new Uint8Array()),
    )
    try {
      await vi.waitFor(() => {
        expect(write).toHaveBeenCalledTimes(4)
      })
      expect(hash).not.toHaveBeenCalled()
      release.resolve(undefined)
      await Promise.all(pending)
      expect(hash).toHaveBeenCalledTimes(4)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled(pending)
      write.mockRestore()
      hash.mockRestore()
    }
  })

  it('releases failed writers and isolates staging instances', async () => {
    const key = await importAesKey(generateDek())
    const first = new Staging('unused-staging-test-1')
    const second = new Staging('unused-staging-test-2')
    const release = Promise.withResolvers<undefined>()
    const failure = new Error('Disk unavailable.')
    const writeFirst = vi.spyOn(first, 'write').mockRejectedValue(failure)
    const writeSecond = vi.spyOn(second, 'write').mockImplementation(() => release.promise)
    const hash = vi.spyOn(crypto.subtle, 'digest')
    try {
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          expect(
            stageFrame(first, String(index), key, new Uint8Array(3), new Uint8Array()),
          ).rejects.toBe(failure),
        ),
      )
      hash.mockClear()
      writeFirst.mockImplementation(() => release.promise)
      const pending = [first, second].map((staging, index) =>
        stageFrame(staging, String(index), key, new Uint8Array(3), new Uint8Array()),
      )
      try {
        await vi.waitFor(() => {
          expect(hash).toHaveBeenCalledTimes(2)
        })
      } finally {
        release.resolve(undefined)
        await Promise.all(pending)
      }
    } finally {
      release.resolve(undefined)
      writeFirst.mockRestore()
      writeSecond.mockRestore()
      hash.mockRestore()
    }
  })
})
