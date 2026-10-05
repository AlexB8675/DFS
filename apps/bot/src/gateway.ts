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

export async function startGateway(
  deps: GatewayDeps & { rest: DiscordRestClient },
): Promise<{ stop: () => Promise<void> }> {
  const { config, rest, log } = deps
  const guildId = config.discord.guildId
  const gateway = new WebSocketManager({
    token: config.discord.botToken ?? '',
    // Message deletions need GuildMessages, but not the content intent (§11).
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
    rest,
  })
  const client = new Client({ rest, gateway })
  client.on(GatewayDispatchEvents.MessageDelete, ({ data }) => {
    if (data.guild_id === guildId) void deleted(deps, data.channel_id, [data.id])
  })
  client.on(GatewayDispatchEvents.MessageDeleteBulk, ({ data }) => {
    if (data.guild_id === guildId) void deleted(deps, data.channel_id, data.ids)
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
