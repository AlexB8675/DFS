import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { MasterKeys } from '@dfs/crypto'
import type { Database } from '@dfs/db'
import { messagesAfter, parseBlobMessage, type DiscordRest } from '@dfs/storage'
import { foldJournal, settle, type Settled } from './fold.ts'
import type { CategoryChannel, JournalSource } from './journal-source.ts'
import { readJournal } from './read-journal.ts'
import { assertEmpty, writeRecovered } from './write.ts'

// `dfs recover` (DESIGN.md §8): rebuilds an empty database from the journal
// and the key file alone, with no snapshot, by replaying every batch from
// the first. It reads Discord, or the local blob store, and never changes
// either; it writes only into a new, migrated, empty database.

export interface RecoverOptions {
  /** The database to fill: migrated, and empty. */
  db: Database
  keys: MasterKeys
  source: JournalSource
  /** Which database's journal, when the source holds several. */
  instanceId?: string
  /** The category's channels, registered again; none with the local blob store. */
  channels: readonly CategoryChannel[]
  /** The highest blob ID already posted, so new blobs never take one (see `highestPostedBlob`). */
  blobIdFloor: (instanceId: string) => Promise<number>
}

export interface RecoveryReport {
  instanceId: string
  source: string
  batches: number
  records: number
  /** Batches found twice, read once. */
  duplicates: number[]
  counts: {
    users: number
    nodes: number
    versions: number
    blobs: number
    shares: number
    auditEntries: number
  }
  settled: Settled
}

export async function recover(options: RecoverOptions): Promise<RecoveryReport> {
  // Before reading anything: a database in use is never written to.
  await assertEmpty(options.db)
  const journal = await readJournal(options.keys, options.source, {
    instanceId: options.instanceId,
  })
  const state = foldJournal(journal.entries)
  const settled = settle(state)
  await writeRecovered(options.db, {
    state,
    instanceId: journal.instanceId,
    batches: journal.batches,
    channels: options.channels,
    blobIdFloor: await options.blobIdFloor(journal.instanceId),
  })
  return {
    instanceId: journal.instanceId,
    source: options.source.describe,
    batches: journal.batches.length,
    records: journal.entries.length,
    duplicates: journal.duplicates,
    counts: {
      users: state.users.size,
      nodes: state.nodes.size,
      versions: state.versions.size,
      blobs: state.blobs.size,
      shares: state.shares.size,
      auditEntries: state.audit.size,
    },
    settled,
  }
}

/**
 * The highest blob ID this database posted to the category's data channels
 * (`dfs1 b=… i=…`), journaled or not: a blob posted just before the database
 * was lost may never have reached the journal.
 */
export async function highestPostedBlob(
  rest: DiscordRest,
  channels: readonly CategoryChannel[],
  instanceId: string,
): Promise<number> {
  let highest = 0
  for (const channel of channels) {
    if (channel.kind !== 'data') continue
    let after = '0'
    for (;;) {
      const page = await messagesAfter(rest, channel.discordChannelId, after)
      if (page.length === 0) break
      for (const message of page) {
        const blob = parseBlobMessage(message.content)
        if (blob?.instanceId === instanceId) highest = Math.max(highest, blob.blobId)
      }
      after = page.at(-1)?.id ?? after
    }
  }
  return highest
}

/** The highest blob ID among `LocalBlobStore`'s files. */
export async function highestLocalBlob(root: string): Promise<number> {
  let highest = 0
  let shards: string[]
  try {
    shards = await readdir(root)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return 0
    throw error
  }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue
    for (const name of await readdir(path.join(root, shard))) {
      const match = /^(\d+)\.bin$/.exec(name)
      if (match?.[1]) highest = Math.max(highest, Number(match[1]))
    }
  }
  return highest
}
