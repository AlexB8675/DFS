import type { LiveEventPayload, LiveEventType } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { Executor } from './journal.ts'

// Live events (DESIGN.md §6.1): a change that the UI shows calls `pg_notify`
// in the transaction that makes it, so the event goes out only if the change
// commits. Every API instance LISTENs and forwards events to its own SSE
// clients for that user.

export const EVENTS_CHANNEL = 'dfs_events'

/** What travels through NOTIFY: the event, and whose it is. */
export interface ChannelEvent<
  T extends Exclude<LiveEventType, 'ping'> = Exclude<LiveEventType, 'ping'>,
> {
  userId: string
  type: T
  payload: LiveEventPayload<T>
}

/** Postgres refuses NOTIFY payloads of 8000 bytes or more; stay well under. */
const MAX_PAYLOAD_BYTES = 7500

export async function notifyEvent(tx: Executor, event: ChannelEvent): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)})`)
}

/**
 * Sends `nodes.synced` for many files, split into as few notifications as fit
 * under the payload limit (about 60 files each).
 */
export async function notifySynced(
  tx: Executor,
  userId: string,
  nodes: LiveEventPayload<'nodes.synced'>['nodes'],
): Promise<void> {
  let batch: typeof nodes = []
  let size = 0
  for (const node of nodes) {
    const entry = JSON.stringify(node).length + 1
    if (batch.length > 0 && size + entry > MAX_PAYLOAD_BYTES - 200) {
      await notifyEvent(tx, { userId, type: 'nodes.synced', payload: { nodes: batch } })
      batch = []
      size = 0
    }
    batch.push(node)
    size += entry
  }
  if (batch.length > 0) {
    await notifyEvent(tx, { userId, type: 'nodes.synced', payload: { nodes: batch } })
  }
}
