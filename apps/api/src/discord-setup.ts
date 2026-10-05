import { registerStorageChannels, type Database } from '@dfs/db'
import { ensureDiscordLayout, type DiscordRest } from '@dfs/storage'

export interface SetupReport {
  /** What changed in Discord; empty when everything was in place. */
  changes: string[]
  /** Channels newly registered in `storage_channels`. */
  registered: string[]
}

/**
 * `dfs setup` (DESIGN.md §4): makes sure this environment's category and
 * channels exist in Discord, then registers them in `storage_channels`, the
 * only channels the bot posts to, reads or deletes from (D25). Running it
 * again changes nothing.
 */
export async function setUpDiscord(
  db: Database,
  rest: DiscordRest,
  discord: { guildId: string; categoryName: string },
): Promise<SetupReport> {
  const layout = await ensureDiscordLayout(rest, discord.guildId, discord.categoryName)
  const registered = await registerStorageChannels(db, layout.channels, 'dfs setup')
  return { changes: layout.changes, registered }
}
