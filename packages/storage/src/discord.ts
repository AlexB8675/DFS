import { DiscordAPIError, REST, type RequestData } from '@discordjs/rest'
import { PermissionFlagsBits } from 'discord-api-types/v10'

// Talking to Discord's REST API (DESIGN.md §11): `@discordjs/rest` handles the
// rate-limit buckets and retries on 429. Code that calls Discord takes the
// small `DiscordRest` interface instead of the class, so tests can stand in
// for Discord.

export type DiscordRoute = `/${string}`

/** The part of `REST` DFS uses. */
export interface DiscordRest {
  get: (route: DiscordRoute, options?: RequestData) => Promise<unknown>
  post: (route: DiscordRoute, options?: RequestData) => Promise<unknown>
  put: (route: DiscordRoute, options?: RequestData) => Promise<unknown>
  delete: (route: DiscordRoute, options?: RequestData) => Promise<unknown>
}

/**
 * `timeoutMs` bounds each request; the bot raises it, since posting a 10 MiB
 * attachment on a slow uplink takes longer than the 15 s default.
 */
/** The REST client itself, which the bot's gateway connection also uses. */
export type DiscordRestClient = REST

export function createDiscordRest(
  token: string,
  options: { timeoutMs?: number } = {},
): DiscordRestClient {
  return new REST({ version: '10', timeout: options.timeoutMs ?? 15_000 }).setToken(token)
}

/** What the bot may do in DFS's channels (DESIGN.md §4). */
export const BOT_CHANNEL_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageMessages

const SETUP_PERMISSIONS =
  'View Channels, Send Messages, Attach Files, Read Message History, Manage Messages, Manage Channels and Manage Roles'

/**
 * Says in plain words what went wrong when Discord refused a request, or
 * `null` for any other error. Uses only Discord's code and message, which
 * never hold the token.
 */
export function discordProblem(error: unknown): string | null {
  if (!(error instanceof DiscordAPIError)) return null
  if (error.status === 401) {
    return 'Discord refused the bot token. Check DISCORD_BOT_TOKEN, or reset the token in the Developer Portal (Application → Bot).'
  }
  switch (error.code) {
    case 10004:
      return 'Discord doesn’t know the server in DISCORD_GUILD_ID, or the bot isn’t in it.'
    case 50001:
      return 'The bot can’t see that server or channel. Check that it is in the server and that its role can view channels.'
    case 50013:
      return `The bot lacks a permission it needs. Its role needs ${SETUP_PERMISSIONS}.`
    default:
      return `Discord answered ${String(error.status)}: ${error.message}`
  }
}
