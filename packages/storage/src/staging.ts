import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { readRange, writeFileDurably } from './files.ts'

/**
 * The staging volume shared by the API and the bot (DESIGN.md §6.1): frames
 * the API received, until their blobs are stored. The database keeps paths
 * relative to it, so both services find the same file whatever their mount.
 */
export class Staging {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  /** Where a received chunk's frame goes, relative to the staging root. */
  framePath(versionId: string, index: number): string {
    return path.posix.join('frames', versionId, `${String(index)}.dfs`)
  }

  /** Where a sealed pack of small frames goes until it is stored (§6.6). */
  packPath(): string {
    return path.posix.join('packs', `${randomUUID()}.bin`)
  }

  /** Writes a frame durably, so a part acknowledged to the client survives a crash. */
  async write(relativePath: string, data: Uint8Array): Promise<void> {
    await writeFileDurably(this.#resolve(relativePath), data)
  }

  async read(relativePath: string): Promise<Uint8Array> {
    const bytes = await readFile(this.#resolve(relativePath))
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  /** The files under `packs/`, with when each was written: for sweeping what a crash left. */
  async packFiles(): Promise<{ path: string; writtenAt: number }[]> {
    let names: string[]
    try {
      names = await readdir(this.#resolve('packs'))
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return []
      throw error
    }
    const files: { path: string; writtenAt: number }[] = []
    for (const name of names) {
      const relativePath = path.posix.join('packs', name)
      const stats = await stat(this.#resolve(relativePath)).catch(() => null)
      if (stats?.isFile()) files.push({ path: relativePath, writtenAt: stats.mtimeMs })
    }
    return files
  }

  /** One frame out of a staged pack. */
  async readRange(relativePath: string, offset: number, length: number): Promise<Uint8Array> {
    return readRange(this.#resolve(relativePath), offset, length)
  }

  async remove(relativePath: string): Promise<void> {
    await rm(this.#resolve(relativePath), { force: true })
  }

  /** Drops every staged frame of a version (a cancelled or expired upload). */
  async removeVersion(versionId: string): Promise<void> {
    await rm(this.#resolve(path.posix.join('frames', versionId)), { recursive: true, force: true })
  }

  #resolve(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath)
    // Paths come from the database, but never let one escape the staging root.
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Staged path outside staging: ${relativePath}`)
    }
    return resolved
  }
}
