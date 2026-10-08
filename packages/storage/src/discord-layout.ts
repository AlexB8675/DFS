import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  Routes,
  type APIOverwrite,
  type APIUser,
} from 'discord-api-types/v10'
import { DiscordAPIError } from '@discordjs/rest'
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
  const overwrites = privateTo(bot.id, guildId)
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

/** Discord's limit on the channels in one category. */
const CATEGORY_LIMIT = 50

/**
 * Admin → Storage: adds a data channel to this environment's category, named
 * after the last one (`storage-04` after `storage-03`), private to the bot
 * like the others. The category must exist: `dfs setup` makes it.
 */
export async function createDataChannel(
  rest: DiscordRest,
  guildId: string,
  categoryName: string,
): Promise<DiscordChannel> {
  const existing = (await rest.get(Routes.guildChannels(guildId))) as Channel[]
  const categories = existing.filter(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === categoryName,
  )
  const [category] = categories
  if (!category || categories.length > 1) {
    throw new ChannelRefusedError(
      category
        ? `The server has ${String(categories.length)} categories named “${categoryName}”. Rename or delete all but one first.`
        : `There is no “${categoryName}” category yet. Check the Discord layout first, which makes it.`,
    )
  }
  const inside = existing.filter((channel) => channel.parent_id === category.id)
  if (inside.length >= CATEGORY_LIMIT) {
    throw new ChannelRefusedError(
      `“${categoryName}” already holds ${String(CATEGORY_LIMIT)} channels, as many as Discord allows in a category.`,
    )
  }
  const numbers = inside
    .map((channel) => /^storage-(\d+)$/.exec(channel.name)?.[1])
    .filter((digits) => digits !== undefined)
    .map(Number)
  const name = `storage-${String(Math.max(-1, ...numbers) + 1).padStart(2, '0')}`
  const bot = (await rest.get(Routes.user())) as APIUser
  const channel = (await rest.post(Routes.guildChannels(guildId), {
    body: {
      name,
      type: ChannelType.GuildText,
      parent_id: category.id,
      topic: DATA_TOPIC,
      permission_overwrites: privateTo(bot.id, guildId),
    },
    reason: 'dfs: Admin → Storage',
  })) as Channel
  return { discordChannelId: channel.id, name, kind: 'data' }
}

/** A channel registered by hand that isn't one this environment may use. */
export class ChannelRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelRefusedError'
  }
}

/**
 * Deletes a channel and every message in it, for `dfs reset-storage`: only
 * ever one registered for this environment. `false` when it was gone already.
 */
export async function deleteChannel(rest: DiscordRest, discordChannelId: string): Promise<boolean> {
  try {
    await rest.delete(Routes.channel(discordChannelId))
    return true
  } catch (error) {
    if (error instanceof DiscordAPIError && error.status === 404) return false
    throw error
  }
}

/** Whether a channel is still there. One the bot may no longer see counts as there. */
export async function channelExists(rest: DiscordRest, discordChannelId: string): Promise<boolean> {
  try {
    await rest.get(Routes.channel(discordChannelId))
    return true
  } catch (error) {
    if (error instanceof DiscordAPIError && error.status === 404) return false
    throw error
  }
}

/**
 * Checks a channel an admin registers by its ID (Admin → Channels): a text
 * channel of this server, inside this environment's category, so development
 * can't take production's channels (D25). Makes it private to the bot like
 * the channels `dfs setup` makes, and returns its name.
 */
export async function adoptChannel(
  rest: DiscordRest,
  guildId: string,
  categoryName: string,
  discordChannelId: string,
): Promise<{ name: string; changes: string[] }> {
  const channel = (await rest.get(Routes.channel(discordChannelId)).catch((error: unknown) => {
    if (error instanceof DiscordAPIError && (error.status === 404 || error.code === 50001))
      return null
    throw error
  })) as (Channel & { guild_id?: string }) | null
  if (channel?.guild_id !== guildId || channel.type !== ChannelType.GuildText) {
    throw new ChannelRefusedError('That isn’t a text channel of this server the bot can see.')
  }
  const parent = channel.parent_id
    ? ((await rest.get(Routes.channel(channel.parent_id))) as Channel)
    : null
  if (parent?.type !== ChannelType.GuildCategory || parent.name !== categoryName) {
    throw new ChannelRefusedError(
      `That channel isn’t in the “${categoryName}” category, which this environment keeps to. Move it there first.`,
    )
  }
  const bot = (await rest.get(Routes.user())) as APIUser
  const changes: string[] = []
  await keepPrivate(rest, channel, privateTo(bot.id, guildId), changes, 'dfs channel')
  return { name: channel.name, changes }
}

/**
 * The IDs of the channels inside this environment's category: the only ones
 * it posts new blobs to, or reads history from (D25).
 */
export async function channelsInCategory(
  rest: DiscordRest,
  guildId: string,
  categoryName: string,
): Promise<Set<string>> {
  const channels = (await rest.get(Routes.guildChannels(guildId))) as Channel[]
  const categories = new Set(
    channels
      .filter(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name === categoryName,
      )
      .map((channel) => channel.id),
  )
  return new Set(
    channels
      .filter((channel) => channel.parent_id && categories.has(channel.parent_id))
      .map((channel) => channel.id),
  )
}

/**
 * DFS's two overwrites (DESIGN.md §4). The bot's own access comes first: once
 * @everyone is denied View Channel, the bot could no longer reach a channel
 * to fix it. @everyone's role has the server's ID.
 */
function privateTo(botId: string, guildId: string): APIOverwrite[] {
  return [
    { id: botId, type: OverwriteType.Member, allow: String(BOT_CHANNEL_PERMISSIONS), deny: '0' },
    {
      id: guildId,
      type: OverwriteType.Role,
      allow: '0',
      deny: String(PermissionFlagsBits.ViewChannel),
    },
  ]
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
