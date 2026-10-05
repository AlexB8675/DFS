import type { Config } from '@dfs/config'
import { registerStorageChannels, type Database } from '@dfs/db'
import {
  discordProblem,
  ensureDiscordLayout,
  type DiscordRest,
  type DiscordRestClient,
} from '@dfs/storage'
import {
  ApplicationCommandOptionType,
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionType,
  MessageFlags,
  PermissionFlagsBits,
  type API,
  type APIInteraction,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from '@discordjs/core'
import { WebSocketManager } from '@discordjs/ws'
import type { FastifyBaseLogger } from 'fastify'
import { alertLost, markLost } from './lost.ts'
import { dataChannels } from './storage.ts'

// The bot's connection to Discord's gateway (DESIGN.md §11), production only
// (D25): it watches for storage messages deleted by hand (§6.5) and answers
// `/dfs setup`. Only the leading bot connects. Deletions while it is offline
// aren't replayed; the scrubber (M4) finds those.

export interface GatewayDeps {
  config: Config
  db: Database
  rest: DiscordRest
  log: FastifyBaseLogger
}

/** `/dfs`, for server administrators only. */
export const COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
  {
    name: 'dfs',
    description: 'DFS administration',
    default_member_permissions: String(PermissionFlagsBits.Administrator),
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'setup',
        description:
          'Create this environment’s category and channels, private to the bot, and register them',
      },
    ],
  },
]

/** After a failed connection, the next try comes this much later. */
const RECONNECT_MS = 30_000
/** How long the registered data channels are trusted before they are read again. */
const CHANNELS_FRESH_MS = 60_000

/**
 * Connects in the background, and tries again after a failure, so a problem
 * with the gateway never holds up storing blobs. Once connected, the
 * connection resumes on its own.
 */
export function keepGateway(deps: GatewayDeps & { rest: DiscordRestClient }): {
  stop: () => Promise<void>
} {
  let stopped = false
  let connected: { stop: () => Promise<void> } | null = null
  let retry: NodeJS.Timeout | null = null
  const connect = () => {
    startGateway(deps).then(
      async (gateway) => {
        if (stopped) await gateway.stop()
        else connected = gateway
      },
      (error: unknown) => {
        deps.log.warn({ err: error }, 'could not connect to the gateway; trying again shortly')
        if (!stopped) retry = setTimeout(connect, RECONNECT_MS)
      },
    )
  }
  connect()
  return {
    stop: async () => {
      stopped = true
      if (retry) clearTimeout(retry)
      await connected?.stop()
    },
  }
}

export async function startGateway(
  deps: GatewayDeps & { rest: DiscordRestClient },
): Promise<{ stop: () => Promise<void> }> {
  const { config, rest, log } = deps
  const guildId = config.discord.guildId
  const dataChannels = new DataChannelIds(deps.db)
  const gateway = new WebSocketManager({
    token: config.discord.botToken ?? '',
    // Message deletions need GuildMessages, but not the content intent (§11).
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
    rest,
  })
  const client = new Client({ rest, gateway })
  // Every deletion in the server arrives; only data channels can hold blobs.
  const onDeleted = async (channelId: string, messageIds: readonly string[]) => {
    if (await dataChannels.has(channelId)) await deleted(deps, channelId, messageIds)
  }
  client.on(GatewayDispatchEvents.MessageDelete, ({ data }) => {
    if (data.guild_id === guildId) void onDeleted(data.channel_id, [data.id])
  })
  client.on(GatewayDispatchEvents.MessageDeleteBulk, ({ data }) => {
    if (data.guild_id === guildId) void onDeleted(data.channel_id, data.ids)
  })
  client.once(GatewayDispatchEvents.Ready, ({ data, api }) => {
    if (!guildId) return
    api.applicationCommands.bulkOverwriteGuildCommands(data.application.id, guildId, COMMANDS).then(
      () => {
        log.info('gateway connected; /dfs registered')
      },
      (error: unknown) => {
        log.warn({ err: error }, 'could not register /dfs')
      },
    )
  })
  client.on(GatewayDispatchEvents.InteractionCreate, ({ data, api }) => {
    void runCommand(deps, data, api).catch((error: unknown) => {
      log.warn({ err: error }, 'answering a command failed')
    })
  })
  await gateway.connect()
  return {
    stop: async () => {
      await gateway.destroy()
    },
  }
}

/** The Discord IDs of the registered data channels, read again every minute. */
class DataChannelIds {
  readonly #db: Database
  #ids: Promise<Set<string>> | null = null
  #readAt = 0

  constructor(db: Database) {
    this.#db = db
  }

  async has(discordChannelId: string): Promise<boolean> {
    if (!this.#ids || Date.now() - this.#readAt > CHANNELS_FRESH_MS) {
      this.#readAt = Date.now()
      this.#ids = dataChannels(this.#db).then(
        (channels) => new Set(channels.map((channel) => channel.discordChannelId)),
        (error: unknown) => {
          // Read again on the next event; until then, check every deletion.
          this.#ids = null
          throw error
        },
      )
    }
    try {
      return (await this.#ids).has(discordChannelId)
    } catch {
      return true
    }
  }
}

/** Messages deleted in one of the server's channels: any of this environment's blobs among them are lost. */
export async function deleted(
  deps: GatewayDeps,
  discordChannelId: string,
  messageIds: readonly string[],
): Promise<void> {
  try {
    const report = await markLost(deps.db, discordChannelId, messageIds)
    if (report) await alertLost(deps.db, deps.rest, report, deps.log)
  } catch (error) {
    deps.log.error({ err: error, discordChannelId }, 'could not record deleted storage messages')
  }
}

/** Answers `/dfs setup`, for an administrator of this environment's server. */
export async function runCommand(
  deps: GatewayDeps,
  interaction: APIInteraction,
  api: Pick<API, 'interactions'>,
): Promise<void> {
  const { config, db, rest } = deps
  if (interaction.type !== InteractionType.ApplicationCommand || interaction.data.name !== 'dfs') {
    return
  }
  const { guildId, categoryName } = config.discord
  if (interaction.guild_id !== guildId || !guildId) return
  // Server admins can change who may see a command, so this is checked here too.
  const permissions = BigInt(interaction.member?.permissions ?? '0')
  if ((permissions & PermissionFlagsBits.Administrator) === 0n) {
    await api.interactions.reply(interaction.id, interaction.token, {
      content: 'Only server administrators can run /dfs.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  // Creating channels can take longer than Discord waits for a first answer.
  await api.interactions.defer(interaction.id, interaction.token, { flags: MessageFlags.Ephemeral })
  let content: string
  try {
    const layout = await ensureDiscordLayout(rest, guildId, categoryName)
    const registered = await registerStorageChannels(db, layout.channels, '/dfs setup')
    content = [
      ...layout.changes.map((change) => `• ${change}`),
      registered.length > 0 ? `Registered for storage: ${registered.join(', ')}.` : '',
      layout.changes.length === 0 && registered.length === 0
        ? `“${categoryName}” and its channels were already set up.`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  } catch (error) {
    content = `Setup failed: ${discordProblem(error) ?? (error instanceof Error ? error.message : String(error))}`
  }
  await api.interactions.editReply(interaction.application_id, interaction.token, { content })
}
