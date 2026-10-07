import type { Config } from '@dfs/config'
import type { Database } from '@dfs/db'
import { discordProblem, type DiscordRest, type DiscordRestClient } from '@dfs/storage'
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
import { capitalized, setUpDiscord } from './discord-setup.ts'

// The bot's connection to Discord's gateway (DESIGN.md §11), production only
// (D25): it answers `/dfs setup`. Only the leading bot connects. It doesn't
// watch for deleted messages: only the bot reaches the channels (D31).

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
  const gateway = new WebSocketManager({
    token: config.discord.botToken ?? '',
    // Commands arrive with any intents; Guilds is the least there is.
    intents: GatewayIntentBits.Guilds,
    rest,
  })
  const client = new Client({ rest, gateway })
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
    const done = await setUpDiscord(db, rest, { guildId, categoryName }, '/dfs setup')
    content = done.map((line) => `• ${capitalized(line)}.`).join('\n')
  } catch (error) {
    content = `Setup failed: ${discordProblem(error) ?? (error instanceof Error ? error.message : String(error))}`
  }
  await api.interactions.editReply(interaction.application_id, interaction.token, { content })
}
