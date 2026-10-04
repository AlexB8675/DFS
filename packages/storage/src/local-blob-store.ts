import { rm } from 'node:fs/promises'
import path from 'node:path'
import { BlobStoreError, type BlobLocation, type BlobStore, type StoredBlob } from './blob-store.ts'
import { readRange, writeFileDurably } from './files.ts'

const NOWHERE: BlobLocation = { channelId: null, messageId: null, attachmentId: null }

/**
 * Blobs as files under a directory (`BLOB_STORE=local`), for development and
 * tests without Discord. Files are spread over 256 subdirectories, so no
 * single directory grows to millions of entries.
 */
export class LocalBlobStore implements BlobStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  async put(id: number, data: Uint8Array): Promise<BlobLocation> {
    await writeFileDurably(this.#file(id), data)
    return NOWHERE
  }

  async read(blob: StoredBlob, offset: number, length: number): Promise<Uint8Array> {
    try {
      return await readRange(this.#file(blob.id), offset, length)
    } catch (error) {
      throw new BlobStoreError(`Blob ${String(blob.id)} can't be read.`, {
        retryable: false,
        cause: error,
      })
    }
  }

  async delete(blob: StoredBlob): Promise<void> {
    await rm(this.#file(blob.id), { force: true })
  }

  #file(id: number): string {
    const shard = (id % 256).toString(16).padStart(2, '0')
    return path.join(this.#root, shard, `${String(id)}.bin`)
  }
}
