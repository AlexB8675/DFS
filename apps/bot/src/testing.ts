import { createHash, randomBytes } from 'node:crypto'
import { fileVersions, nodes, users, type Database } from '@dfs/db'
import type { Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import { Packer } from './packer.ts'
import { storeAllStagedBlobs, type UploaderDeps } from './uploader.ts'

/**
 * What the leading bot does over time, done at once: pack every waiting
 * frame, then store every staged blob. Tests only.
 */
export async function settleBlobs(
  deps: UploaderDeps & { sizes: { blobMaxBytes: number; packTargetBytes: number } },
): Promise<void> {
  await sealPacks(deps)
  await storeAllStagedBlobs(deps)
}

/** Packs every waiting frame, leaving the packs in staging for the bot to store. Tests only. */
export async function sealPacks(deps: {
  db: Database
  staging: Staging
  sizes: { blobMaxBytes: number; packTargetBytes: number }
}): Promise<number> {
  const { db, staging, sizes } = deps
  return new Packer({ db, staging, sizes, maxWaitMs: 0 }).sealDue({ force: true })
}

/**
 * Files of one new owner, each a completed upload of one frame waiting in
 * staging, as the API leaves them. Tests only.
 */
export async function uploadedFiles(
  db: Database,
  staging: Staging,
  frameSizes: readonly number[],
): Promise<{ ownerId: string; files: { nodeId: string; versionId: string }[] }> {
  const [owner] = await db
    .insert(users)
    .values({
      username: crypto.randomUUID(),
      displayName: 'Test',
      passwordHash: '-',
      quotaBytes: 1e9,
    })
    .returning()
  if (!owner) throw new Error('No test owner.')
  const [root] = await db
    .insert(nodes)
    .values({ ownerId: owner.id, kind: 'folder', name: '', nameKey: '' })
    .returning()
  if (!root) throw new Error('No test root.')
  const files: { nodeId: string; versionId: string }[] = []
  for (const [index, size] of frameSizes.entries()) {
    const name = `${String(index)}.bin`
    const [node] = await db
      .insert(nodes)
      .values({
        ownerId: owner.id,
        parentId: root.id,
        kind: 'file',
        name,
        nameKey: name,
        sizeBytes: size,
      })
      .returning()
    if (!node) throw new Error('No test node.')
    const [version] = await db
      .insert(fileVersions)
      .values({
        nodeId: node.id,
        versionNo: 1,
        state: 'syncing',
        sizeBytes: size,
        chunkSize: 4096,
        chunkCount: 1,
        wrappedDek: Buffer.alloc(60),
        keyId: 'k1',
        createdBy: owner.id,
      })
      .returning()
    if (!version) throw new Error('No test version.')
    await db
      .update(nodes)
      .set({ currentVersionId: version.id })
      .where(sql`id = ${node.id}`)
    const bytes = new Uint8Array(randomBytes(size))
    const stagedPath = staging.framePath(version.id, 0)
    await staging.write(stagedPath, bytes)
    const hash = createHash('sha256').update(bytes).digest()
    await db.execute(sql`
      INSERT INTO chunks (version_id, idx, plain_size, frame_size, plain_sha256, frame_sha256, staged_path)
      VALUES (${version.id}, 0, ${size}, ${size}, ${hash}, ${hash}, ${stagedPath})`)
    await db.execute(sql`UPDATE users SET used_bytes = used_bytes + ${size} WHERE id = ${owner.id}`)
    files.push({ nodeId: node.id, versionId: version.id })
  }
  return { ownerId: owner.id, files }
}
