import { mkdir, open, rename, rm } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileDurably } from './files.ts'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), open: vi.fn(), rename: vi.fn(), rm: vi.fn() }))

describe('writeFileDurably failure cleanup', () => {
  const writeFile = vi.fn()
  const sync = vi.fn()
  const close = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(mkdir).mockResolvedValue(undefined)
    vi.mocked(open).mockResolvedValue({ writeFile, sync, close } as unknown as Awaited<
      ReturnType<typeof open>
    >)
    vi.mocked(rename).mockResolvedValue(undefined)
    vi.mocked(rm).mockResolvedValue(undefined)
    writeFile.mockResolvedValue(undefined)
    sync.mockResolvedValue(undefined)
    close.mockResolvedValue(undefined)
  })

  it.each(['write', 'sync', 'close', 'rename'])(
    'removes the temporary file after a failed %s',
    async (step) => {
      const error = new Error(`${step} failed.`)
      if (step === 'write') writeFile.mockRejectedValueOnce(error)
      if (step === 'sync') sync.mockRejectedValueOnce(error)
      if (step === 'close') close.mockRejectedValueOnce(error)
      if (step === 'rename') vi.mocked(rename).mockRejectedValueOnce(error)

      await expect(writeFileDurably('staging/frame.dfs', new Uint8Array([1, 2]))).rejects.toBe(
        error,
      )
      expect(close).toHaveBeenCalledTimes(1)
      expect(rm).toHaveBeenCalledWith(expect.stringMatching(/frame\.dfs\.[\w-]+\.tmp$/), {
        force: true,
      })
      if (step !== 'rename') expect(rename).not.toHaveBeenCalled()
    },
  )

  it('preserves the original error if removing the temporary file also fails', async () => {
    const error = new Error('Disk full.')
    writeFile.mockRejectedValueOnce(error)
    vi.mocked(rm).mockRejectedValueOnce(new Error('Cleanup failed.'))
    await expect(writeFileDurably('staging/frame.dfs', new Uint8Array())).rejects.toBe(error)
  })
})
