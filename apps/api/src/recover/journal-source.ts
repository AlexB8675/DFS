import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { DiscordChannelKind } from '@dfs/storage'
import { messagesAfter, parseJournalMessage, type DiscordRest } from '@dfs/storage'

// Where recovery finds the journal (DESIGN.md §8): #dfs-journal in this
// environment's Discord category, or the folder beside the local blob store.
// Both only read: recovery never posts, edits or deletes anything.

/** A sealed journal batch as found, before it is opened. */
export interface FoundBatch {
  batchNo: number
  bytes: Uint8Array
  /** What its Discord message said about it, when it came from Discord. */
  message?: {
    instanceId: string
    firstId: number
    lastId: number
    discordChannelId: string
    messageId: string
    attachmentId: string
  }
}

export interface JournalSource {
  /** Where it reads, for the report. */
  readonly describe: string
  /** Every batch found, in no particular order: the reader sorts and checks them. */
  batches: () => AsyncIterable<FoundBatch> | Iterable<FoundBatch>
}

/** The journal as `LocalJournalStore` writes it: `<root>/journal/j<number>.bin`. */
export class LocalJournalSource implements JournalSource {
  readonly #folder: string
  readonly describe: string

  constructor(root: string) {
    this.#folder = path.join(root, 'journal')
    this.describe = `the journal folder ${this.#folder}`
  }

  async *batches(): AsyncIterable<FoundBatch> {
    let names: string[]
    try {
      names = await readdir(this.#folder)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const match = /^j(\d+)\.bin$/.exec(name)
      if (!match?.[1]) continue
      const bytes = await readFile(path.join(this.#folder, name))
      yield { batchNo: Number(match[1]), bytes: new Uint8Array(bytes) }
    }
  }
}

/** Discord's channel types (`ChannelType`) this reads. */
const GUILD_TEXT = 0
const GUILD_CATEGORY = 4

/** A channel of the environment's category, as recovery registers it again. */
export interface CategoryChannel {
  discordChannelId: string
  name: string
  kind: DiscordChannelKind
}

/**
 * The text channels of the category named `categoryName`, with the kind each
 * name says (§4): what `storage_channels` held, rebuilt from Discord.
 */
export async function categoryChannels(
  rest: DiscordRest,
  guildId: string,
  categoryName: string,
): Promise<CategoryChannel[]> {
  const channels = (await rest.get(`/guilds/${guildId}/channels`)) as {
    id: string
    type: number
    name: string
    parent_id?: string | null
  }[]
  const categories = new Set(
    channels
      .filter((channel) => channel.type === GUILD_CATEGORY && channel.name === categoryName)
      .map((channel) => channel.id),
  )
  return channels
    .filter(
      (channel) =>
        channel.type === GUILD_TEXT &&
        channel.parent_id !== undefined &&
        channel.parent_id !== null &&
        categories.has(channel.parent_id),
    )
    .map((channel) => ({
      discordChannelId: channel.id,
      name: channel.name,
      kind:
        channel.name === 'dfs-journal'
          ? 'journal'
          : channel.name === 'dfs-backups'
            ? 'backup'
            : channel.name === 'dfs-log'
              ? 'log'
              : 'data',
    }))
}

export interface DiscordJournalSourceOptions {
  rest: DiscordRest
  /** The journal channels to read: those of kind `journal` in the category. */
  channels: readonly CategoryChannel[]
  /** Downloads an attachment by its signed URL; `fetch` itself outside tests. */
  fetch?: typeof fetch
}

/** Every journal message in the category's journal channels, oldest first, with its attachment. */
export class DiscordJournalSource implements JournalSource {
  readonly #options: DiscordJournalSourceOptions
  readonly describe: string

  constructor(options: DiscordJournalSourceOptions) {
    this.#options = options
    const names = options.channels.filter((channel) => channel.kind === 'journal')
    this.describe = `Discord, ${names.map((channel) => `#${channel.name}`).join(', ') || 'no journal channel'}`
  }

  async *batches(): AsyncIterable<FoundBatch> {
    const { rest } = this.#options
    const download = this.#options.fetch ?? fetch
    for (const channel of this.#options.channels) {
      if (channel.kind !== 'journal') continue
      let after = '0'
      for (;;) {
        const page = await messagesAfter(rest, channel.discordChannelId, after)
        if (page.length === 0) break
        for (const message of page) {
          const said = parseJournalMessage(message.content)
          const [attachment] = message.attachments
          if (!said || !attachment) continue
          const response = await download(attachment.url)
          if (!response.ok) {
            throw new Error(
              `Journal batch ${String(said.batchNo)} (message ${message.id}) couldn’t be downloaded: ${String(response.status)}.`,
            )
          }
          const bytes = new Uint8Array(await response.arrayBuffer())
          if (bytes.length !== attachment.size) {
            throw new Error(
              `Journal batch ${String(said.batchNo)} came ${String(bytes.length)} bytes long, not ${String(attachment.size)}.`,
            )
          }
          yield {
            batchNo: said.batchNo,
            bytes,
            message: {
              instanceId: said.instanceId,
              firstId: said.firstId,
              lastId: said.lastId,
              discordChannelId: channel.discordChannelId,
              messageId: message.id,
              attachmentId: attachment.id,
            },
          }
        }
        after = page.at(-1)?.id ?? after
      }
    }
  }
}
