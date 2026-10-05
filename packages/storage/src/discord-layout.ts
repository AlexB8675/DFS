import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  Routes,
  type APIOverwrite,
  type APIUser,
} from 'discord-api-types/v10'
import { BOT_CHANNEL_PERMISSIONS, type DiscordRest } from './discord.ts'

// The channels `dfs setup` makes (DESIGN.md §4): one category per environment
// (D25), holding the data channels and the journal, backup and log channels,
// all hidden from everyone but the bot.

export type DiscordChannelKind = 'data' | 'journal' | 'backup' | 'log'

export interface DiscordChannel {
  discordChannelId: string
  name: string
  kind: DiscordChannelKind
}

export interface DiscordLayout {
  categoryId: string
  /** In the order of DESIGN.md §4: the data channels, then journal, backups and log. */
  channels: DiscordChannel[]
  /** What this run changed in Discord; empty when everything was in place. */
  changes: string[]
}

const DATA_TOPIC = 'DFS storage. Only the bot posts here; deleting a message loses data.'

const LAYOUT: readonly { name: string; kind: DiscordChannelKind; topic: string }[] = [
  { name: 'storage-00', kind: 'data', topic: DATA_TOPIC },
  { name: 'storage-01', kind: 'data', topic: DATA_TOPIC },
  { name: 'storage-02', kind: 'data', topic: DATA_TOPIC },
  { name: 'storage-03', kind: 'data', topic: DATA_TOPIC },
  { name: 'dfs-journal', kind: 'journal', topic: 'DFS metadata journal, for disaster recovery.' },
  { name: 'dfs-backups', kind: 'backup', topic: 'DFS backup pointers, for disaster recovery.' },
  { name: 'dfs-log', kind: 'log', topic: 'DFS events and alerts.' },
]

/** The fields of a guild channel this reads. */
interface Channel {
  id: string
  type: ChannelType
  name: string
  parent_id?: string | null
  permission_overwrites?: APIOverwrite[]
}

/**
 * Makes sure the server has the category named `categoryName` with DFS's
 * channels in it, private to the bot: creates what is missing, and restores
 * the two permission overwrites DFS relies on if they were loosened. Only
 * channels inside that category count, so another environment's channels are
 * never touched. Running it again changes nothing.
 */
export async function ensureDiscordLayout(
  rest: DiscordRest,
  guildId: string,
  categoryName: string,
): Promise<DiscordLayout> {
  const bot = (await rest.get(Routes.user())) as APIUser
  const existing = (await rest.get(Routes.guildChannels(guildId))) as Channel[]
  const reason = 'dfs setup'
  // The bot's own access comes first: once @everyone is denied View Channel,
  // the bot could no longer reach a channel to fix it. @everyone's role has
  // the server's ID.
  const overwrites: APIOverwrite[] = [
    { id: bot.id, type: OverwriteType.Member, allow: String(BOT_CHANNEL_PERMISSIONS), deny: '0' },
    {
      id: guildId,
      type: OverwriteType.Role,
      allow: '0',
      deny: String(PermissionFlagsBits.ViewChannel),
    },
  ]
  const changes: string[] = []

  const categories = existing.filter(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === categoryName,
  )
  if (categories.length > 1) {
    throw new Error(
      `The server has ${String(categories.length)} categories named “${categoryName}”. Rename or delete all but one, then run this again.`,
    )
  }
  let category = categories[0]
  if (category) {
    await keepPrivate(rest, category, overwrites, changes, reason)
  } else {
    category = (await rest.post(Routes.guildChannels(guildId), {
      body: {
        name: categoryName,
        type: ChannelType.GuildCategory,
        permission_overwrites: overwrites,
      },
      reason,
    })) as Channel
    changes.push(`created the category “${categoryName}”`)
  }

  const categoryId = category.id
  const channels: DiscordChannel[] = []
  for (const { name, kind, topic } of LAYOUT) {
    const found = existing.filter(
      (channel) => channel.parent_id === categoryId && channel.name === name,
    )
    let channel = found[0]
    if (found.length > 1 || (channel && channel.type !== ChannelType.GuildText)) {
      throw new Error(
        `“${categoryName}” must hold exactly one text channel named #${name}. Rename or delete the others, then run this again.`,
      )
    }
    if (channel) {
      await keepPrivate(rest, channel, overwrites, changes, reason)
    } else {
      channel = (await rest.post(Routes.guildChannels(guildId), {
        body: {
          name,
          type: ChannelType.GuildText,
          parent_id: categoryId,
          topic,
          // Given explicitly, rather than trusting the channel to copy its category's.
          permission_overwrites: overwrites,
        },
        reason,
      })) as Channel
      changes.push(`created #${name}`)
    }
    channels.push({ discordChannelId: channel.id, name, kind })
  }
  return { categoryId, channels, changes }
}

/** Puts back any of DFS's overwrites on `channel` that were loosened, keeping other bits. */
async function keepPrivate(
  rest: DiscordRest,
  channel: Channel,
  wanted: readonly APIOverwrite[],
  changes: string[],
  reason: string,
): Promise<void> {
  for (const want of wanted) {
    const have = channel.permission_overwrites?.find((overwrite) => overwrite.id === want.id)
    const allow = (BigInt(have?.allow ?? 0) & ~BigInt(want.deny)) | BigInt(want.allow)
    const deny = (BigInt(have?.deny ?? 0) & ~BigInt(want.allow)) | BigInt(want.deny)
    if (have && BigInt(have.allow) === allow && BigInt(have.deny) === deny) continue
    await rest.put(Routes.channelPermission(channel.id, want.id), {
      body: { type: want.type, allow: String(allow), deny: String(deny) },
      reason,
    })
    const where =
      channel.type === ChannelType.GuildCategory
        ? `the category “${channel.name}”`
        : `#${channel.name}`
    changes.push(
      want.type === OverwriteType.Member
        ? `let the bot into ${where}`
        : `hid ${where} from everyone`,
    )
  }
}
