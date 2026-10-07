import {
  appendJournal,
  bigintArray,
  compactionCandidates,
  compactionGroups,
  type CompactionRule,
  type Database,
  type Executor,
  type JournalRecord,
  type Metrics,
} from '@dfs/db'
import { METRIC_STEPS } from '@dfs/shared'
import { BlobStoreError, type BlobLocation, type BlobStore } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { blobStoredRecord } from './uploader.ts'

// Compaction (DESIGN.md §6.6, D32). A pack whose files were mostly deleted
// still takes a message, and keeps the deleted files' bytes. The leading bot
// merges packs that hold little into a new one: their live frames, still
// ciphertext, are read back and checked, posted as one pack, and moved there
// in one transaction, which journals it. The old messages go to the garbage
// collector, which deletes them once that journal is on Discord (§6.4), so a
// database rebuilt from the journal never points at a message gone.

/** A pack reserved this long ago and never stored was left by a crash: the janitor drops it. */
export const STALE_BUILDING_MS = 60 * 60_000

/**
 * A reservation older than this isn't stored any more. Well inside the hour
 * after which the janitor drops it and the reconciler deletes its message as
 * an orphan, so neither can while the move commits.
 */
const BUILDING_FRESH_MS = 30 * 60_000

/**
 * Whether files were downloaded in the last minute or so: the API adds what
 * it sends to `downloads.bytes` every 5 s, by half minute (§16). Compaction
 * reads whole packs from Discord, over the link those downloads use too.
 */
export async function downloadsUnderWay(db: Executor): Promise<boolean> {
  const { rows } = await db.execute<{ reading: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM metrics
      WHERE name = 'downloads.bytes' AND step = ${METRIC_STEPS.halfMinute}
        AND at >= now() - interval '1 minute' AND sum > 0
    ) AS reading`)
  return rows[0]?.reading ?? false
}

export interface CompactionReport {
  /** New packs stored, one per group merged. */
  groups: number
  /** Old packs merged into them, whose messages go to the garbage collector. */
  packs: number
  /** Bytes on Discord the old packs held beyond the new ones. */
  freedBytes: number
  /** Packs left out because they failed their check, from now until the bot restarts. */
  failures: number
}

export interface CompactorOptions {
  db: Database
  store: BlobStore
  rule: CompactionRule
  /**
   * Whether work that comes first is under way (uploads waiting, files
   * being downloaded): the leader's runs wait for it, and stop before the
   * next pack read when it starts. Compact packs now doesn't wait.
   */
  busy?: () => Promise<boolean>
  log?: Pick<FastifyBaseLogger, 'info' | 'warn'>
  metrics?: Metrics
}

interface PackRow extends Record<string, unknown> {
  id: number
  size_bytes: number
  sha256: Buffer | null
  channel_id: string | null
  message_id: string | null
  attachment_id: string | null
  cdn_url: string | null
  cdn_url_expires_ms: number | null
}

interface FrameRow extends Record<string, unknown> {
  id: number
  version_id: string
  blob_id: number
  blob_offset: number
  frame_size: number
  frame_sha256: Buffer
}

interface MovedRow extends Record<string, unknown> {
  version_id: string
  idx: number
  blob_offset: number
  frame_size: number
  from_blob: number
}

export class Compactor {
  readonly #options: CompactorOptions
  /**
   * Packs that failed their check: logged once, then left out until the bot
   * restarts. Their files fail to download as well, and nothing else would
   * show it (D31); `attempts` and `last_error` are the garbage collector's.
   */
  readonly #broken = new Set<number>()
  /** The run under way: the leader's loop and Compact packs now take turns. */
  #running: Promise<unknown> = Promise.resolve()

  constructor(options: CompactorOptions) {
    this.#options = options
  }

  /**
   * Merges the first group of packs due, as the leader's loop does every
   * minute. `force` merges every group there is, whatever the packs' age:
   * Admin → Storage's Compact packs now, and tests.
   */
  compact({ force = false } = {}): Promise<CompactionReport> {
    const run = this.#running.then(() => this.#compact(force))
    this.#running = run.catch(() => undefined)
    return run
  }

  async #compact(force: boolean): Promise<CompactionReport> {
    const { db, rule, busy } = this.#options
    const report: CompactionReport = { groups: 0, packs: 0, freedBytes: 0, failures: 0 }
    const yields = force || !busy ? () => Promise.resolve(false) : busy
    if (await yields()) return report
    const candidates = await compactionCandidates(db, force ? { ...rule, minAgeDays: 0 } : rule, [
      ...this.#broken,
    ])
    const groups = compactionGroups(candidates, rule.packTargetBytes).map((group) =>
      group.map((pack) => pack.id),
    )
    for (const group of force ? groups : groups.slice(0, 1)) {
      await this.#merge(group, report, yields)
    }
    return report
  }

  /** Merges one group into a new pack, leaving out packs that fail their check. */
  async #merge(
    group: readonly number[],
    report: CompactionReport,
    yields: () => Promise<boolean>,
  ): Promise<void> {
    const { db, store, log, metrics } = this.#options
    // As they are now: a pack emptied meanwhile has gone to the garbage collector.
    const { rows: packs } = await db.execute<PackRow>(sql`
      SELECT id::float8 AS id, size_bytes, sha256, channel_id, message_id, attachment_id,
        cdn_url, (extract(epoch FROM cdn_url_expires_at) * 1000)::float8 AS cdn_url_expires_ms
      FROM blobs WHERE id = ANY(${bigintArray(group)}) AND kind = 'pack' AND state = 'stored'
      ORDER BY id`)
    const { rows: frames } = await db.execute<FrameRow>(sql`
      SELECT id::float8 AS id, version_id, blob_id::float8 AS blob_id, blob_offset, frame_size,
        frame_sha256
      FROM chunks WHERE blob_id = ANY(${bigintArray(packs.map((pack) => pack.id))})
        AND purged_at IS NULL
      ORDER BY id`)
    const framesOf = Map.groupBy(frames, (frame) => frame.blob_id)

    // One pack in memory at a time, and only the live frames of each kept.
    const read = new Map<number, Uint8Array>()
    const merged: PackRow[] = []
    for (const pack of packs) {
      // Nothing is reserved yet: stopping here leaves nothing behind.
      if (await yields()) return
      const live = await this.#readLive(pack, framesOf.get(pack.id) ?? [])
      if (!live) {
        report.failures += 1
        continue
      }
      for (const [id, bytes] of live) read.set(id, bytes)
      merged.push(pack)
    }
    if (merged.length < 2) return

    // In chunk ID order, so files uploaded together stay together.
    const plan: { id: number; from_blob: number; from_offset: number; to_offset: number }[] = []
    const parts: Uint8Array[] = []
    let offset = 0
    for (const frame of frames) {
      const bytes = read.get(frame.id)
      if (!bytes) continue
      plan.push({
        id: frame.id,
        from_blob: frame.blob_id,
        from_offset: frame.blob_offset,
        to_offset: offset,
      })
      parts.push(bytes)
      offset += bytes.length
    }
    if (plan.length === 0) return
    const data = Buffer.concat(parts)
    // Hash on the thread pool, keeping the bot responsive for other work.
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', data))

    // Reserved for the ID its message names; nothing points at it until it is stored.
    const { rows: reserved } = await db.execute<{ id: number }>(sql`
      INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, sha256)
      VALUES ('pack', 'building', ${data.length}, 0, ${plan.length}, ${sha256})
      RETURNING id::float8 AS id`)
    const blobId = reserved[0]?.id
    if (blobId === undefined) throw new Error('The new pack was not recorded.')
    const pack = {
      id: blobId,
      kind: 'pack' as const,
      size_bytes: data.length,
      frame_count: plan.length,
      sha256,
    }

    let posted: BlobLocation | null = null
    let moved: MovedRow[] | null
    try {
      const { location, url } = await store.put(
        { id: blobId, kind: 'pack', frameCount: plan.length },
        () => Promise.resolve(data),
      )
      posted = location
      metrics?.record('discord.posted', data.length)
      moved = await this.#move(pack, merged, plan, location, url)
    } catch (error) {
      await this.#abandon(blobId, posted)
      throw error
    }
    if (!moved) {
      await this.#abandon(blobId, posted)
      return
    }

    const kept = moved.length > 0 ? data.length : 0
    const freed = merged.reduce((total, old) => total + old.size_bytes, 0) - kept
    report.groups += 1
    report.packs += merged.length
    report.freedBytes += freed
    metrics?.record('packs.compacted', merged.length)
    metrics?.record('compaction.freed_bytes', freed)
    log?.info(
      { blobId, packs: merged.map((old) => old.id), frames: moved.length, freedBytes: freed },
      'merged packs that held little into one',
    )
  }

  /**
   * A pack's live frames, by chunk ID, once it is read whole and checked: its
   * size and SHA-256, then each frame's. One that fails is left out, logged,
   * and not tried again until the bot restarts. A store that may answer
   * later (rate limits, timeouts) ends the run, to be tried again.
   */
  async #readLive(
    pack: PackRow,
    frames: readonly FrameRow[],
  ): Promise<Map<number, Uint8Array> | null> {
    const { store, log, metrics } = this.#options
    const broken = (reason: string, error?: unknown) => {
      this.#broken.add(pack.id)
      metrics?.record('compaction.failures')
      log?.warn(
        { err: error, blobId: pack.id, reason },
        'a pack failed its check; compaction leaves it out, and its files may not download',
      )
      return null
    }
    let data: Uint8Array
    try {
      data = await store.read(
        {
          id: pack.id,
          channelId: pack.channel_id,
          messageId: pack.message_id,
          attachmentId: pack.attachment_id,
          url:
            pack.cdn_url && pack.cdn_url_expires_ms !== null
              ? { url: pack.cdn_url, expiresAt: new Date(pack.cdn_url_expires_ms) }
              : null,
        },
        0,
        pack.size_bytes,
      )
    } catch (error) {
      if (error instanceof BlobStoreError && !error.retryable) return broken('unreadable', error)
      throw error
    }
    if (data.length !== pack.size_bytes) {
      return broken(`${String(data.length)} bytes, not ${String(pack.size_bytes)}`)
    }
    if (pack.sha256 && !(await sha256(data)).equals(pack.sha256)) return broken('wrong SHA-256')
    const live = new Map<number, Uint8Array>()
    for (const frame of frames) {
      const end = frame.blob_offset + frame.frame_size
      // A copy, so the pack itself can go.
      const bytes = Buffer.from(data.subarray(frame.blob_offset, end))
      if (end > data.length || !(await sha256(bytes)).equals(frame.frame_sha256)) {
        return broken(`frame ${String(frame.id)} is damaged`)
      }
      live.set(frame.id, bytes)
    }
    return live
  }

  /**
   * Moves the frames into the new pack and stores it, in one transaction:
   * their versions, then the packs by ID (locks.ts). A frame moves only if
   * it is still where it was read; one purged meanwhile stays behind as dead
   * space in the new pack. Returns what moved, or `null` if the reservation
   * was dropped meanwhile.
   */
  async #move(
    pack: Parameters<typeof blobStoredRecord>[0],
    merged: readonly PackRow[],
    plan: readonly { id: number; from_blob: number; from_offset: number; to_offset: number }[],
    location: BlobLocation,
    url: { url: string; expiresAt: Date } | null,
  ): Promise<MovedRow[] | null> {
    const { db } = this.#options
    return db.transaction(async (tx) => {
      // The versions first, as a purge takes them: one under way finishes
      // first, and its frames don't move, or waits and finds them moved.
      await tx.execute(sql`
        SELECT id FROM file_versions
        WHERE id IN (
          SELECT version_id FROM chunks WHERE id = ANY(${bigintArray(plan.map((frame) => frame.id))}))
        ORDER BY id FOR NO KEY UPDATE`)
      await tx.execute(sql`
        SELECT id FROM blobs
        WHERE id = ANY(${bigintArray([...merged.map((old) => old.id), pack.id])})
        ORDER BY id FOR UPDATE`)
      const { rows: fresh } = await tx.execute(sql`
        SELECT id FROM blobs WHERE id = ${pack.id} AND state = 'building'
          AND created_at > now() - make_interval(secs => ${BUILDING_FRESH_MS / 1000})`)
      if (fresh.length === 0) return null

      const { rows: moved } = await tx.execute<MovedRow>(sql`
        UPDATE chunks SET blob_id = ${pack.id}, blob_offset = plan.to_offset
        FROM jsonb_to_recordset(${JSON.stringify(plan)}::jsonb)
          AS plan(id bigint, from_blob bigint, from_offset integer, to_offset integer)
        WHERE chunks.id = plan.id AND chunks.blob_id = plan.from_blob
          AND chunks.blob_offset = plan.from_offset AND chunks.purged_at IS NULL
        RETURNING chunks.version_id, chunks.idx, chunks.blob_offset, chunks.frame_size,
          plan.from_blob::float8 AS from_blob`)
      const movedFrom = Map.groupBy(moved, (row) => row.from_blob)
      const released = merged.map((old) => ({
        id: old.id,
        bytes: (movedFrom.get(old.id) ?? []).reduce((total, row) => total + row.frame_size, 0),
      }))
      // What moved leaves the old packs, which are left with nothing: each
      // goes to the garbage collector, which waits for this transaction's journal.
      await tx.execute(sql`
        UPDATE blobs SET
          live_bytes = blobs.live_bytes - released.bytes,
          state = CASE
            WHEN blobs.live_bytes - released.bytes <= 0 AND blobs.state = 'stored'
              THEN 'deleting'::blob_state
            ELSE blobs.state END,
          released_at = CASE
            WHEN blobs.live_bytes - released.bytes <= 0 AND blobs.state = 'stored' THEN now()
            ELSE blobs.released_at END
        FROM jsonb_to_recordset(${JSON.stringify(released)}::jsonb) AS released(id bigint, bytes integer)
        WHERE blobs.id = released.id`)
      const live = moved.reduce((total, row) => total + row.frame_size, 0)
      // Every frame purged while it was posted: straight to the garbage collector.
      const { rows: stored } = await tx.execute<{ discord_channel_id: string | null }>(sql`
        UPDATE blobs SET live_bytes = ${live},
          state = CASE WHEN ${live}::int > 0 THEN 'stored' ELSE 'deleting' END::blob_state,
          released_at = CASE WHEN ${live}::int > 0 THEN NULL ELSE now() END,
          stored_at = now(), last_verified_at = now(),
          channel_id = ${location.channelId}, message_id = ${location.messageId},
          attachment_id = ${location.attachmentId},
          cdn_url = ${url?.url ?? null}, cdn_url_expires_at = ${url?.expiresAt ?? null}
        WHERE id = ${pack.id}
        RETURNING (SELECT discord_channel_id FROM storage_channels
          WHERE storage_channels.id = blobs.channel_id) AS discord_channel_id`)
      const records: JournalRecord[] = [
        blobStoredRecord(pack, stored[0]?.discord_channel_id ?? null, location),
      ]
      if (moved.length > 0) {
        records.push({
          kind: 'blob.relocated',
          record: {
            id: pack.id,
            chunks: moved.map((row) => ({
              versionId: row.version_id,
              idx: row.idx,
              offset: row.blob_offset,
            })),
          },
        })
      }
      await appendJournal(tx, records)
      return moved
    })
  }

  /**
   * Drops a reservation that wasn't stored, and its message or file. Only
   * once the reservation is dropped can nothing point at it; if that fails,
   * the janitor and the reconciler clean up within the hour.
   */
  async #abandon(blobId: number, posted: BlobLocation | null): Promise<void> {
    const { db, store, log } = this.#options
    try {
      const { rows } = await db.execute(sql`
        UPDATE blobs SET state = 'deleted' WHERE id = ${blobId} AND state = 'building'
        RETURNING id`)
      if (rows.length > 0 && posted) await store.delete({ id: blobId, ...posted })
    } catch (error) {
      log?.warn({ err: error, blobId }, 'could not drop a pack compaction gave up on')
    }
  }
}

/**
 * Drops packs a crash left reserved but never stored (§6.6), and a local
 * store's file of them. Their Discord message, if one was posted, is never
 * recorded, so the reconciler deletes it. Returns how many went.
 */
export async function dropStalePacks(db: Database, store: BlobStore): Promise<number> {
  const { rows } = await db.execute<{ id: number }>(sql`
    UPDATE blobs SET state = 'deleted'
    WHERE state = 'building' AND created_at < now() - make_interval(secs => ${STALE_BUILDING_MS / 1000})
    RETURNING id::float8 AS id`)
  for (const row of rows) {
    await store.delete({ id: row.id, channelId: null, messageId: null, attachmentId: null })
  }
  return rows.length
}

async function sha256(data: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', data))
}
