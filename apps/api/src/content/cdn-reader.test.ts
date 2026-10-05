import { describe, expect, it } from 'vitest'
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
})
