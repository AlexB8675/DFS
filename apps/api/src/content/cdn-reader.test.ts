import { Metrics } from '@dfs/db'
import { describe, expect, it, vi } from 'vitest'
import { CdnBlobReader } from './cdn-reader.ts'

const blob = (id: number) => ({ id, channelId: 'c', messageId: 'm', attachmentId: 'a' })

describe('CdnBlobReader (DESIGN.md §6.2)', () => {
  it('asks the bot once for blobs whose signing is already under way, 200 at a time', async () => {
    const asked: number[][] = []
    const reader = new CdnBlobReader({
      botUrl: 'http://bot.test',
      secret: 'secret',
      fetch: async (_input, init) => {
        const { blobIds } = JSON.parse(init?.body as string) as { blobIds: number[] }
        asked.push(blobIds)
        await Promise.resolve()
        return Response.json({
          urls: blobIds
            .filter((id) => id !== 3)
            .map((id) => ({
              blobId: id,
              url: `https://cdn.discordapp.com/attachments/1/2/${String(id)}.bin?ex=1`,
              expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            })),
        })
      },
    })
    const [first, second] = await Promise.all([
      reader.signUrls([blob(1), blob(2), blob(3)]),
      reader.signUrls([blob(2), blob(3), blob(4)]),
    ])
    expect(asked).toEqual([[1, 2, 3], [4]])
    expect([...first.keys()]).toEqual([1, 2])
    expect([...second.keys()]).toEqual([2, 4])

    asked.length = 0
    await reader.signUrls(Array.from({ length: 450 }, (_, i) => blob(i + 10)))
    expect(asked.map((ids) => ids.length)).toEqual([200, 200, 50])
  })

  it('reports a bot that fails to answer as worth retrying', async () => {
    const reader = new CdnBlobReader({
      botUrl: 'http://bot.test',
      secret: 'secret',
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    })
    await expect(reader.signUrls([blob(1)])).rejects.toMatchObject({ retryable: true })
    await expect(reader.read(blob(1), 0, 4)).rejects.toMatchObject({ retryable: true })
  })

  it('waits out a 429 from the CDN, reads on, and counts it', async () => {
    const metrics = new Metrics()
    const record = vi.spyOn(metrics, 'record')
    let calls = 0
    const reader = new CdnBlobReader({
      botUrl: 'http://bot.test',
      secret: 'secret',
      metrics,
      fetch: () => {
        calls += 1
        return Promise.resolve(
          calls === 1
            ? new Response(null, { status: 429, headers: { 'Retry-After': '0.05' } })
            : new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 206,
                headers: { 'Content-Range': 'bytes 0-3/10' },
              }),
        )
      },
    })
    const url = {
      url: 'https://cdn.discordapp.com/attachments/1/2/1.bin?ex=1',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }
    expect(await reader.read({ ...blob(1), url }, 0, 4)).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(record).toHaveBeenCalledWith('cdn.429')
    expect(record).not.toHaveBeenCalledWith('cdn.failures')
  })

  it('stops a read its reader gave up on, and counts no failure', async () => {
    const metrics = new Metrics()
    const record = vi.spyOn(metrics, 'record')
    const reader = new CdnBlobReader({
      botUrl: 'http://bot.test',
      secret: 'secret',
      metrics,
      fetch: (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    })
    const url = {
      url: 'https://cdn.discordapp.com/attachments/1/2/1.bin?ex=1',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }
    const controller = new AbortController()
    const reading = reader.read({ ...blob(1), url }, 0, 4, controller.signal)
    controller.abort()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(record).not.toHaveBeenCalledWith('cdn.failures')
  })
})
