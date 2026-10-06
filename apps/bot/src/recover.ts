import { appendJournal, notifySynced, uuidArray, type Database } from '@dfs/db'
import { isFresh, type BlobStore, type StoredBlob } from '@dfs/storage'
import { sql } from 'drizzle-orm'

// Recovering a lost blob (Admin → Storage, DESIGN.md §6.5). A message deleted
// in Discord takes its attachment with it. Discord still signs new links to
// it, but its CDN answers those with 404; only a link that read the
// attachment before the deletion keeps serving it, from the CDN's cache, for
// a while. So this is a best effort that works for blobs read lately: the
// blob's last signed link is tried first, then a new one. When either
// serves it, the blob is checked frame by frame, posted again, and its files
// are readable as before.

interface LostBlob extends Record<string, unknown> {
  id: number
  state: string
  kind: 'solo' | 'pack'
  size_bytes: number
  frame_count: number
  sha256: Buffer | null
  channel_id: string | null
  message_id: string | null
  attachment_id: string | null
  cdn_url: string | null
  cdn_url_expires_ms: number | null
}

export interface RecoverDeps {
  db: Database
  store: BlobStore
}

/** Recovers a lost blob, or throws saying why it can't. Returns what it did. */
export async function recoverBlob(deps: RecoverDeps, blobId: number): Promise<string> {
  const { db, store } = deps
  if (!store.signUrls) throw new Error('Recovering a blob needs Discord storage.')
  const blob = await lostBlob(db, blobId)
  const where: StoredBlob = {
    id: blob.id,
    channelId: blob.channel_id,
    messageId: blob.message_id,
    attachmentId: blob.attachment_id,
  }
  const gone = `Discord no longer serves blob ${String(blobId)}: it keeps a deleted attachment only briefly, and only if it was read lately. Its files stay lost.`
  const last =
    blob.cdn_url && blob.cdn_url_expires_ms !== null
      ? { url: blob.cdn_url, expiresAt: new Date(blob.cdn_url_expires_ms) }
      : null
  // The link that read it before, if it hasn't expired; then a new one.
  const links = async function* () {
    if (isFresh(last)) yield last
    const signed = (await store.signUrls?.([where]))?.get(blob.id)
    if (signed) yield signed
  }
  let data: Uint8Array | null = null
  let failure: unknown = null
  for await (const url of links()) {
    try {
      data = await store.read({ ...where, url }, 0, blob.size_bytes)
      break
    } catch (error) {
      failure = error
    }
  }
  if (!data) throw new Error(gone, { cause: failure })
  await check(db, blob, data)

  // Purged while it was read: nothing to bring back.
  if ((await lostBlob(db, blobId).catch(() => null)) === null) {
    return `Blob ${String(blobId)} was let go while it was read; nothing to recover.`
  }
  const { location, url: signed } = await store.put(
    { id: blob.id, kind: blob.kind, frameCount: blob.frame_count },
    () => Promise.resolve(data),
  )

  const files = await db.transaction(async (tx) => {
    // The blob row first, then its versions in ID order, as storing does.
    const { rows: stored } = await tx.execute<{ discord_channel_id: string | null }>(sql`
      UPDATE blobs SET state = 'stored', lost_at = NULL, stored_at = now(),
        channel_id = ${location.channelId}, message_id = ${location.messageId},
        attachment_id = ${location.attachmentId},
        cdn_url = ${signed?.url ?? null}, cdn_url_expires_at = ${signed?.expiresAt ?? null}
      WHERE id = ${blobId} AND state = 'lost'
      RETURNING (SELECT discord_channel_id FROM storage_channels
        WHERE storage_channels.id = blobs.channel_id) AS discord_channel_id`)
    // Purged at the last moment: the new message is an orphan the reconciler deletes.
    const [record] = stored
    if (!record) return null
    await tx.execute(sql`
      SELECT id FROM file_versions
      WHERE id IN (SELECT version_id FROM chunks WHERE blob_id = ${blobId})
      ORDER BY id FOR NO KEY UPDATE`)
    // A version comes back once none of its frames is in a blob still lost.
    const { rows: versions } = await tx.execute<{ id: string; state: 'stored' | 'syncing' }>(sql`
      UPDATE file_versions version SET state = CASE
          WHEN version.chunks_stored >= version.chunk_count THEN 'stored'::version_state
          ELSE 'syncing'::version_state END
      WHERE version.id IN (SELECT version_id FROM chunks WHERE blob_id = ${blobId})
        AND version.state = 'lost'
        AND NOT EXISTS (
          SELECT 1 FROM chunks chunk JOIN blobs other ON other.id = chunk.blob_id
          WHERE chunk.version_id = version.id AND other.state = 'lost')
      RETURNING version.id, version.state::text AS state`)
    await appendJournal(tx, [
      {
        kind: 'blob.stored',
        record: {
          id: blobId,
          kind: blob.kind,
          sizeBytes: blob.size_bytes,
          sha256: blob.sha256?.toString('hex') ?? null,
          discordChannelId: record.discord_channel_id,
          messageId: location.messageId,
          attachmentId: location.attachmentId,
        },
      },
    ])
    if (versions.length === 0) return 0
    // Only files whose current version this is show the change.
    const states = new Map(versions.map((version) => [version.id, version.state]))
    const { rows: shown } = await tx.execute<{
      user_id: string
      id: string
      parent_id: string
      version_id: string
    }>(sql`
      SELECT owner_id AS user_id, id, parent_id, current_version_id AS version_id FROM nodes
      WHERE current_version_id = ANY(${uuidArray([...states.keys()])}) AND parent_id IS NOT NULL`)
    const byOwner = new Map<
      string,
      { id: string; parentId: string; syncState: 'stored' | 'syncing' }[]
    >()
    for (const row of shown) {
      const files = byOwner.get(row.user_id) ?? []
      files.push({
        id: row.id,
        parentId: row.parent_id,
        syncState: states.get(row.version_id) ?? 'syncing',
      })
      byOwner.set(row.user_id, files)
    }
    for (const [userId, files] of byOwner) await notifySynced(tx, userId, files)
    return versions.length
  })
  if (files === null)
    return `Blob ${String(blobId)} was let go while it was posted again; nothing to recover.`
  return `Recovered blob ${String(blobId)}: ${String(files)} ${files === 1 ? 'version is' : 'versions are'} readable again.`
}

async function lostBlob(db: Database, blobId: number): Promise<LostBlob> {
  const { rows } = await db.execute<LostBlob>(sql`
    SELECT id::float8 AS id, state::text AS state, kind, size_bytes, frame_count, sha256,
      channel_id, message_id, attachment_id, cdn_url,
      (extract(epoch FROM cdn_url_expires_at) * 1000)::float8 AS cdn_url_expires_ms
    FROM blobs WHERE id = ${blobId}`)
  const [blob] = rows
  if (!blob) throw new Error(`There is no blob ${String(blobId)}.`)
  if (blob.state !== 'lost') throw new Error(`Blob ${String(blobId)} isn’t lost.`)
  return blob
}

/** The bytes read back must be the blob that was stored: its size, every frame, and its hash. */
async function check(db: Database, blob: LostBlob, data: Uint8Array): Promise<void> {
  const broken = `What Discord still serves for blob ${String(blob.id)} isn’t what was stored; nothing was changed.`
  if (data.length !== blob.size_bytes) throw new Error(broken)
  const digest = async (bytes: Uint8Array) =>
    Buffer.from(await crypto.subtle.digest('SHA-256', bytes))
  if (blob.sha256 && !(await digest(data)).equals(blob.sha256)) throw new Error(broken)
  const { rows: frames } = await db.execute<{
    blob_offset: number
    frame_size: number
    frame_sha256: Buffer
  }>(sql`SELECT blob_offset, frame_size, frame_sha256 FROM chunks WHERE blob_id = ${blob.id}`)
  for (const frame of frames) {
    const bytes = data.subarray(frame.blob_offset, frame.blob_offset + frame.frame_size)
    if (bytes.length !== frame.frame_size || !(await digest(bytes)).equals(frame.frame_sha256)) {
      throw new Error(broken)
    }
  }
}
