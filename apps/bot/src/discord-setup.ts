import { registerStorageChannels, type Database } from '@dfs/db'
import { ensureDiscordLayout, type DiscordRest } from '@dfs/storage'

// Setting up this environment's Discord channels from the bot (DESIGN.md §4):
// `/dfs setup` in Discord and Admin → Storage do the same as `dfs setup` on
// the server, and say what they did in the same words.

/**
 * Makes sure the category and its channels exist, private to the bot, and
 * registers them; returns what it did, a line per change.
 */
export async function setUpDiscord(
  db: Database,
  rest: DiscordRest,
  discord: { guildId: string; categoryName: string },
  details: string,
): Promise<string[]> {
  const layout = await ensureDiscordLayout(rest, discord.guildId, discord.categoryName)
  const registered = await registerStorageChannels(db, layout.channels, details)
  const lines = [...layout.changes]
  if (registered.length > 0) lines.push(`registered ${registered.join(', ')} for storage`)
  if (lines.length === 0)
    lines.push(`“${discord.categoryName}” and its channels were already set up`)
  return lines
}

export function capitalized(line: string): string {
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`
}
