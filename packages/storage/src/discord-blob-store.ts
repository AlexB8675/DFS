import { randomBytes } from 'node:crypto'
import { DiscordAPIError } from '@discordjs/rest'
import { Routes, type APIMessage } from 'discord-api-types/v10'
import {
  BlobStoreError,
  type BlobStore,
  type BlobToStore,
  type CdnUrl,
  type PutResult,
  type StoredBlob,
} from './blob-store.ts'
import { attachmentUrl, blobFilename, cdnUrl, readBlobFromCdn, refreshCdnUrls } from './cdn.ts'
import { discordProblem, type DiscordRest } from './discord.ts'

/** A registered data channel (`storage_channels`). */
export interface StorageChannel {
  id: string
  discordChannelId: string
  /** Disabled channels take no new blobs; their blobs stay readable. */
  enabled: boolean
}

export interface DiscordBlobStoreOptions {
  rest: DiscordRest
  /**
   * The registered data channels, enabled or not (DESIGN.md §4). Asked again
   * every minute, and whenever a blob names a channel not in the last answer.
   */
  channels: () => Promise<StorageChannel[]>
  /** `BLOB_MAX_BYTES`: the largest attachment DFS posts. */
  maxBytes: number
  /** For reads from the CDN; replaceable in tests. */
  fetch?: typeof fetch
}

const CHANNELS_FRESH_MS = 60_000
/** Discord answers a repeated nonce with the first message for a few minutes. */
const NONCE_KEPT_MS = 5 * 60_000
/** Discord's code for a message that doesn't exist (any more). */
const UNKNOWN_MESSAGE = 10008

/**
 * Blobs as Discord attachments, one per message (DESIGN.md §2, §4), posted
 * to the registered data channels of this environment only (D25). The bot
 * uses it; the API reads through the bot's signed URLs instead (§6.2).
 */
export class DiscordBlobStore implements BlobStore {
  readonly #rest: DiscordRest
  readonly #loadChannels: () => Promise<StorageChannel[]>
  readonly #maxBytes: number
  readonly #fetch: typeof fetch
  #channels: { list: StorageChannel[]; loadedAt: number } | null = null
  readonly #inFlight = new Map<string, number>()
  #turn = 0
  /**
   * The channel and nonce of each blob being posted. A retry reuses both, so
   * if Discord stored the message but the answer was lost, `enforce_nonce`
   * makes Discord return that message instead of posting it twice (§6.1).
   * Nonces are random: blob IDs repeat across databases sharing the bot.
   */
  readonly #attempts = new Map<number, { channel: StorageChannel; nonce: string; at: number }>()

  constructor(options: DiscordBlobStoreOptions) {
    this.#rest = options.rest
    this.#loadChannels = options.channels
    this.#maxBytes = options.maxBytes
    this.#fetch = options.fetch ?? fetch
  }

  async put(blob: BlobToStore, data: Uint8Array): Promise<PutResult> {
    if (data.length > this.#maxBytes) {
      throw new BlobStoreError(
        `Blob ${String(blob.id)} is ${String(data.length)} bytes, more than an attachment may hold.`,
        { retryable: false },
      )
    }
    const { channel, nonce } = await this.#attempt(blob.id)
    const filename = blobFilename(blob.id)
    const content = `dfs1 b=${String(blob.id)} k=${blob.kind} n=${String(blob.frameCount)}`
    this.#inFlight.set(channel.id, (this.#inFlight.get(channel.id) ?? 0) + 1)
    let message: APIMessage
    try {
      message = (await this.#rest.post(Routes.channelMessages(channel.discordChannelId), {
        body: {
          content,
          nonce,
          enforce_nonce: true,
          attachments: [{ id: 0, filename }],
        },
        files: [{ name: filename, data, contentType: 'application/octet-stream' }],
      })) as APIMessage
    } catch (error) {
      throw storeError(error, `Posting blob ${String(blob.id)}`)
    } finally {
      this.#inFlight.set(channel.id, (this.#inFlight.get(channel.id) ?? 1) - 1)
    }

    const [attachment, ...others] = message.attachments
    if (message.content !== content || !attachment || others.length > 0) {
      // Not the message just posted: leave it alone, and post with a new nonce next time.
      this.#attempts.delete(blob.id)
      throw new BlobStoreError(`Discord answered blob ${String(blob.id)} with another message.`, {
        retryable: true,
      })
    }
    if (attachment.size !== data.length) {
      this.#attempts.delete(blob.id)
      await this.#deleteMessage(channel.discordChannelId, message.id).catch(() => undefined)
      throw new BlobStoreError(
        `Discord kept ${String(attachment.size)} of blob ${String(blob.id)}'s ${String(data.length)} bytes.`,
        { retryable: true },
      )
    }
    this.#attempts.delete(blob.id)
    return {
      location: { channelId: channel.id, messageId: message.id, attachmentId: attachment.id },
      url: cdnUrl(attachment.url),
    }
  }

  async read(blob: StoredBlob, offset: number, length: number): Promise<Uint8Array> {
    return readBlobFromCdn(this.#fetch, blob, offset, length, async (unsigned) => {
      const urls = await this.signUrls([unsigned])
      return urls.get(unsigned.id) ?? null
    })
  }

  async delete(blob: StoredBlob): Promise<void> {
    if (!blob.channelId || !blob.messageId) return
    const channel = await this.#channel(blob.channelId)
    try {
      await this.#deleteMessage(channel.discordChannelId, blob.messageId)
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE) return
      throw storeError(error, `Deleting blob ${String(blob.id)}`)
    }
  }

  /**
   * Fresh signed URLs for stored blobs, by blob ID (DESIGN.md §6.2). A blob
   * whose message is gone gets none.
   */
  async signUrls(blobs: readonly StoredBlob[]): Promise<Map<number, CdnUrl>> {
    const unsigned = new Map<string, number>()
    for (const blob of blobs) {
      if (!blob.channelId || !blob.attachmentId) continue
      const channel = await this.#channel(blob.channelId)
      unsigned.set(
        attachmentUrl(channel.discordChannelId, blob.attachmentId, blobFilename(blob.id)),
        blob.id,
      )
    }
    let signed: Map<string, CdnUrl>
    try {
      signed = await refreshCdnUrls(this.#rest, [...unsigned.keys()])
    } catch (error) {
      throw storeError(error, 'Signing CDN URLs')
    }
    const byBlob = new Map<number, CdnUrl>()
    for (const [url, blobId] of unsigned) {
      const fresh = signed.get(url)
      if (fresh) byBlob.set(blobId, fresh)
    }
    return byBlob
  }

  async #attempt(blobId: number): Promise<{ channel: StorageChannel; nonce: string }> {
    const now = Date.now()
    for (const [id, attempt] of this.#attempts) {
      if (now - attempt.at > NONCE_KEPT_MS) this.#attempts.delete(id)
    }
    const known = this.#attempts.get(blobId)
    if (known) return known
    const attempt = {
      channel: await this.#leastBusyChannel(),
      nonce: randomBytes(12).toString('base64url'),
      at: now,
    }
    this.#attempts.set(blobId, attempt)
    return attempt
  }

  /** The enabled channel with the fewest posts in flight, taking turns among equals. */
  async #leastBusyChannel(): Promise<StorageChannel> {
    const enabled = (await this.#channelList()).filter((channel) => channel.enabled)
    const busy = (channel: StorageChannel) => this.#inFlight.get(channel.id) ?? 0
    const least = Math.min(...enabled.map(busy))
    const candidates = enabled.filter((channel) => busy(channel) === least)
    const channel = candidates[this.#turn++ % candidates.length]
    if (!channel) {
      throw new BlobStoreError(
        'No storage channel takes new blobs. Run `dfs setup`, or enable one on Admin → Channels.',
        { retryable: true },
      )
    }
    return channel
  }

  /** Any registered channel by its `storage_channels.id`, disabled ones included. */
  async #channel(id: string): Promise<StorageChannel> {
    const found = (await this.#channelList()).find((channel) => channel.id === id)
    if (found) return found
    const reloaded = (await this.#channelList(true)).find((channel) => channel.id === id)
    if (reloaded) return reloaded
    throw new BlobStoreError(`Storage channel ${id} isn't registered.`, { retryable: false })
  }

  async #channelList(reload = false): Promise<StorageChannel[]> {
    const now = Date.now()
    if (reload || !this.#channels || now - this.#channels.loadedAt > CHANNELS_FRESH_MS) {
      this.#channels = { list: await this.#loadChannels(), loadedAt: now }
    }
    return this.#channels.list
  }

  async #deleteMessage(discordChannelId: string, messageId: string): Promise<void> {
    await this.#rest.delete(Routes.channelMessage(discordChannelId, messageId))
  }
}

/** Rate limits, server errors and network trouble pass; Discord refusing a request doesn't. */
function storeError(error: unknown, doing: string): BlobStoreError {
  if (error instanceof DiscordAPIError) {
    return new BlobStoreError(`${doing}: ${discordProblem(error) ?? error.message}`, {
      retryable: error.status === 429 || error.status >= 500,
      cause: error,
    })
  }
  const reason = error instanceof Error ? error.message : String(error)
  return new BlobStoreError(`${doing} failed: ${reason}`, { retryable: true, cause: error })
}
