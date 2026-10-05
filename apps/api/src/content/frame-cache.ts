import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from '@dfs/crypto'
import type { FastifyBaseLogger } from 'fastify'

// The frame cache (DESIGN.md §6.2): frames read back from Discord, kept on the
// API's disk so reading them again costs no CDN request. Frames are
// ciphertext, so the cache is as safe as the CDN. It is keyed by each frame's
// SHA-256: frames never change, so an entry stays right even when compaction
// moves its frame to another pack. Least recently used frames go first.

/** Frames waiting to reach the disk; past this, new ones aren't cached. */
const MAX_WRITING_BYTES = 64 * 1024 * 1024

/**
 * Memory for frames in flight that no request is waiting on yet: read-ahead
 * and whole packs fetched for archives. Whoever can't get room does without,
 * so memory stays bounded however many downloads run at once.
 */
export class MemoryBudget {
  readonly #limit: number
  #used = 0

  constructor(limitBytes: number) {
    this.#limit = limitBytes
  }

  /** Takes `bytes` if they fit, and returns how to give them back; `null` if they don't. */
  tryTake(bytes: number): (() => void) | null {
    if (this.#used + bytes > this.#limit) return null
    this.#used += bytes
    let given = false
    return () => {
      if (given) return
      given = true
      this.#used -= bytes
    }
  }
}

export class FrameCache {
  readonly #dir: string
  readonly #maxBytes: number
  readonly #log: Pick<FastifyBaseLogger, 'warn'> | undefined
  /** Frames on disk, by SHA-256 in hex, least recently used first, with their sizes. */
  readonly #entries = new Map<string, number>()
  #bytes = 0
  /** Frames on their way to the disk, readable already. */
  readonly #writing = new Map<string, Uint8Array>()
  #writingBytes = 0
  readonly #writes = new Set<Promise<void>>()
  /** Fetches under way, so readers of the same frame share one. */
  readonly #loading = new Map<string, Promise<Uint8Array>>()
  readonly #ready: Promise<void>
  /** Since start, for measuring. */
  readonly stats = { hits: 0, misses: 0 }

  constructor(options: { dir: string; maxBytes: number; log?: Pick<FastifyBaseLogger, 'warn'> }) {
    this.#dir = options.dir
    this.#maxBytes = options.maxBytes
    this.#log = options.log
    // Finds what earlier runs cached, in the background: until then, it misses.
    this.#ready = this.#scan().catch((error: unknown) => {
      this.#log?.warn({ err: error }, 'could not read the frame cache; starting it empty')
    })
  }

  /** Resolves once the frames earlier runs cached are known. */
  ready(): Promise<void> {
    return this.#ready
  }

  /** Whether a frame is cached, as far as the cache knows without reading it. */
  has(frameSha256: Uint8Array): boolean {
    const key = Buffer.from(frameSha256).toString('hex')
    return this.#entries.has(key) || this.#writing.has(key)
  }

  /** Resolves once the frames on their way to the disk are written. */
  async idle(): Promise<void> {
    while (this.#writes.size > 0) await Promise.all(this.#writes)
  }

  /**
   * The frame with this SHA-256: from the cache if it holds a good copy, or
   * from `fetch`, which must check what it returns, once however many ask.
   */
  async load(frameSha256: Uint8Array, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const key = Buffer.from(frameSha256).toString('hex')
    const cached = await this.#read(key)
    if (cached) {
      if (Buffer.from(await sha256(cached)).equals(frameSha256)) {
        this.stats.hits += 1
        return cached
      }
      this.#forget(key)
    }
    this.stats.misses += 1
    let loading = this.#loading.get(key)
    if (!loading) {
      loading = fetch()
      void loading.then(
        (frame) => {
          this.#loading.delete(key)
          this.put(frameSha256, frame)
        },
        () => this.#loading.delete(key),
      )
      this.#loading.set(key, loading)
    }
    return loading
  }

  /** Keeps a frame whose SHA-256 has been checked. Skipped when too much waits for the disk. */
  put(frameSha256: Uint8Array, frame: Uint8Array): void {
    const key = Buffer.from(frameSha256).toString('hex')
    if (this.#entries.has(key) || this.#writing.has(key)) return
    if (frame.length > this.#maxBytes || this.#writingBytes + frame.length > MAX_WRITING_BYTES) {
      return
    }
    this.#writing.set(key, frame)
    this.#writingBytes += frame.length
    const write = this.#write(key, frame).finally(() => {
      this.#writing.delete(key)
      this.#writingBytes -= frame.length
      this.#writes.delete(write)
    })
    this.#writes.add(write)
  }

  async #read(key: string): Promise<Uint8Array | null> {
    const writing = this.#writing.get(key)
    if (writing) return writing
    if (!this.#entries.has(key)) return null
    try {
      const bytes = await readFile(this.#file(key))
      // Most recently used now.
      const size = this.#entries.get(key)
      if (size !== undefined) {
        this.#entries.delete(key)
        this.#entries.set(key, size)
      }
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } catch {
      // Evicted meanwhile, or unreadable: a miss.
      this.#forget(key)
      return null
    }
  }

  async #write(key: string, frame: Uint8Array): Promise<void> {
    await this.#ready
    const file = this.#file(key)
    // No fsync: a cache may lose its newest frames in a crash, and a torn file
    // fails its check and is fetched again. The rename keeps it whole.
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(temporary, frame)
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      this.#log?.warn({ err: error }, 'could not cache a frame')
      return
    }
    if (!this.#entries.has(key)) {
      this.#entries.set(key, frame.length)
      this.#bytes += frame.length
    }
    await this.#evict()
  }

  async #evict(): Promise<void> {
    for (const [key, size] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) return
      this.#entries.delete(key)
      this.#bytes -= size
      // On Windows, a file another request has open can't go yet: a later
      // start finds it again.
      await rm(this.#file(key), { force: true }).catch(() => undefined)
    }
  }

  #forget(key: string): void {
    const size = this.#entries.get(key)
    if (size === undefined) return
    this.#entries.delete(key)
    this.#bytes -= size
    void rm(this.#file(key), { force: true }).catch(() => undefined)
  }

  async #scan(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    const found: { key: string; size: number; usedAt: number }[] = []
    for (const shard of await readdir(this.#dir)) {
      const directory = path.join(this.#dir, shard)
      const names = await readdir(directory).catch(() => [])
      for (const name of names) {
        const file = path.join(directory, name)
        if (!name.endsWith('.frame')) {
          // A write a crash interrupted.
          await rm(file, { force: true }).catch(() => undefined)
          continue
        }
        const stats = await stat(file).catch(() => null)
        if (stats?.isFile()) {
          found.push({
            key: name.slice(0, -'.frame'.length),
            size: stats.size,
            usedAt: stats.mtimeMs,
          })
        }
      }
    }
    // Writes wait for this scan, so nothing is cached meanwhile.
    found.sort((a, b) => a.usedAt - b.usedAt)
    for (const { key, size } of found) {
      this.#entries.set(key, size)
      this.#bytes += size
    }
    await this.#evict()
  }

  #file(key: string): string {
    return path.join(this.#dir, key.slice(0, 2), `${key}.frame`)
  }
}
