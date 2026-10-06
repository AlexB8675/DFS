import path from 'node:path'
import { Routes, type APIMessage } from 'discord-api-types/v10'
import { BlobStoreError, type BlobLocation } from './blob-store.ts'
import { storeError } from './discord-blob-store.ts'
import type { DiscordRest } from './discord.ts'
import { writeFileDurably } from './files.ts'

// Where journal batches go (DESIGN.md §8): #dfs-journal in Discord, or a
// folder beside the local blob store, which needs no Discord.

/** What a store is told about a batch it stores: its message names it (§4). */
export interface JournalBatchToStore {
  batchNo: number
  /** The journal IDs it holds, first and last. */
  firstId: number
  lastId: number
}

export interface JournalStore {
  /** Stores a sealed batch, durably, and says where it went. */
  put: (batch: JournalBatchToStore, data: Uint8Array) => Promise<BlobLocation>
}

/** A journal message's content: `dfs1 j=5521 ids=9120004-9125003 i=3fa9c1d2e0b4`. */
export function journalMessage(batch: JournalBatchToStore, instanceId: string): string {
  return `dfs1 j=${String(batch.batchNo)} ids=${String(batch.firstId)}-${String(batch.lastId)} i=${instanceId}`
}

export function journalFilename(batchNo: number): string {
  return `j${String(batchNo)}.bin`
}

/** A registered journal channel (`storage_channels`, kind `journal`). */
export interface JournalChannel {
  id: string
  discordChannelId: string
}

export interface DiscordJournalStoreOptions {
  rest: DiscordRest
  /** The journal channel to post to, inside this environment's category, if one is registered. */
  channel: () => Promise<JournalChannel | null>
  /** This database's instance ID, which every message carries (§4). */
  instanceId: () => Promise<string>
}

/**
 * Journal batches as attachments in #dfs-journal, one per message. A batch's
 * nonce comes from its number and the database, so a retry within Discord's
 * few minutes gets the message already posted instead of a second one.
 */
export class DiscordJournalStore implements JournalStore {
  readonly #options: DiscordJournalStoreOptions

  constructor(options: DiscordJournalStoreOptions) {
    this.#options = options
  }

  async put(batch: JournalBatchToStore, data: Uint8Array): Promise<BlobLocation> {
    const doing = `Posting journal batch ${String(batch.batchNo)}`
    const channel = await this.#options.channel()
    if (!channel) {
      throw new BlobStoreError(
        `${doing}: no #dfs-journal channel is registered in this environment's category. Run dfs setup.`,
        { retryable: true },
      )
    }
    const instanceId = await this.#options.instanceId()
    const content = journalMessage(batch, instanceId)
    const filename = journalFilename(batch.batchNo)
    let message: APIMessage
    try {
      message = (await this.#options.rest.post(Routes.channelMessages(channel.discordChannelId), {
        body: {
          content,
          nonce: `j${String(batch.batchNo)}-${instanceId}`.slice(0, 25),
          enforce_nonce: true,
          attachments: [{ id: 0, filename }],
        },
        files: [{ name: filename, data, contentType: 'application/octet-stream' }],
      })) as APIMessage
    } catch (error) {
      throw storeError(error, doing)
    }
    const [attachment, ...others] = message.attachments
    if (message.content !== content || !attachment || others.length > 0) {
      throw new BlobStoreError(`${doing}: Discord answered with another message.`, {
        retryable: true,
      })
    }
    if (attachment.size !== data.length) {
      throw new BlobStoreError(
        `${doing}: Discord kept ${String(attachment.size)} of its ${String(data.length)} bytes.`,
        { retryable: true },
      )
    }
    return { channelId: channel.id, messageId: message.id, attachmentId: attachment.id }
  }
}

/** Journal batches as files in `<root>/journal`, for the local blob store. */
export class LocalJournalStore implements JournalStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  async put(batch: JournalBatchToStore, data: Uint8Array): Promise<BlobLocation> {
    await writeFileDurably(path.join(this.#root, 'journal', journalFilename(batch.batchNo)), data)
    return { channelId: null, messageId: null, attachmentId: null }
  }
}
