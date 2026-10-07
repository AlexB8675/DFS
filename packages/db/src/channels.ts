import { auditLog, storageChannels } from './schema.ts'
import type { Database } from './client.ts'
import { appendJournal, auditRecords } from './journal.ts'

// Registering the Discord channels an environment stores in (DESIGN.md §4),
// for `dfs setup` in the CLI and `/dfs setup` in the bot alike.

export interface ChannelToRegister {
  discordChannelId: string
  name: string
  kind: 'data' | 'journal' | 'backup' | 'log'
}

/**
 * Registers these channels, each once: one already registered stays as it
 * is. Returns the names of those newly registered, each noted in the audit
 * log with `details`.
 */
export async function registerStorageChannels(
  db: Database,
  channels: readonly ChannelToRegister[],
  details: string,
): Promise<string[]> {
  if (channels.length === 0) return []
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(storageChannels)
      .values(
        channels.map(({ discordChannelId, name, kind }) => ({ discordChannelId, name, kind })),
      )
      .onConflictDoNothing({ target: storageChannels.discordChannelId })
      .returning({ name: storageChannels.name })
    if (rows.length > 0) {
      const entries = await tx
        .insert(auditLog)
        .values(
          rows.map(({ name }) => ({
            userId: null,
            action: 'channel.created',
            meta: { target: name, details },
          })),
        )
        .returning()
      await appendJournal(tx, auditRecords(entries))
    }
    return rows.map(({ name }) => name)
  })
}
