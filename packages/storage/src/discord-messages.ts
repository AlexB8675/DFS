import { DiscordAPIError } from '@discordjs/rest'
import { Routes, type APIMessage, type APIUser } from 'discord-api-types/v10'
import type { BlobToStore } from './blob-store.ts'
import type { DiscordRest } from './discord.ts'

// DFS's messages in its data channels (DESIGN.md §4), for the store and the
// bot's orphan reconciler.

/** Discord's snowflakes count milliseconds from 2015. */
const DISCORD_EPOCH = 1_420_070_400_000n
/** Discord's code for a message that doesn't exist (any more). */
const UNKNOWN_MESSAGE = 10008
const BLOB_MESSAGE = /^dfs1 b=(\d+) k=(solo|pack) n=(\d+) i=([0-9a-f]{12})$/

/** What a data message says about its blob. */
export interface BlobMessage {
  blobId: number
  kind: 'solo' | 'pack'
  frameCount: number
  /** The database that posted it (`instance.id`). */
  instanceId: string
}

/** A data message's content: `dfs1 b=184467 k=pack n=212 i=3fa9c1d2e0b4`. */
export function blobMessage(blob: BlobToStore, instanceId: string): string {
  return `dfs1 b=${String(blob.id)} k=${blob.kind} n=${String(blob.frameCount)} i=${instanceId}`
}

/** The blob a message holds, or `null` if it isn't a data message. */
export function parseBlobMessage(content: string): BlobMessage | null {
  const match = BLOB_MESSAGE.exec(content)
  if (!match?.[1] || !match[3] || !match[4]) return null
  return {
    blobId: Number(match[1]),
    kind: match[2] === 'pack' ? 'pack' : 'solo',
    frameCount: Number(match[3]),
    instanceId: match[4],
  }
}

/** When a Discord ID was made, in milliseconds since 1970. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
}

/** The bot's own user ID. */
export async function botUserId(rest: DiscordRest): Promise<string> {
  return ((await rest.get(Routes.user())) as APIUser).id
}

/**
 * The first `limit` messages after the message `after` (or from the start of
 * the channel), oldest first. Discord lists them newest first.
 */
export async function messagesAfter(
  rest: DiscordRest,
  discordChannelId: string,
  after: string,
  limit = 100,
): Promise<APIMessage[]> {
  const page = (await rest.get(Routes.channelMessages(discordChannelId), {
    query: new URLSearchParams({ after, limit: String(limit) }),
  })) as APIMessage[]
  return page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
}

/** Deletes a message; one that is already gone counts as deleted. */
export async function deleteMessage(
  rest: DiscordRest,
  discordChannelId: string,
  messageId: string,
): Promise<void> {
  try {
    await rest.delete(Routes.channelMessage(discordChannelId, messageId))
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE) return
    throw error
  }
}
