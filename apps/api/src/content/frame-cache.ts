import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from '@dfs/crypto'
import type { Metrics } from '@dfs/db'
import type { FastifyBaseLogger } from 'fastify'

// The frame cache (DESIGN.md §6.2): frames read back from Discord, kept on the
// API's disk so reading them again costs no CDN request. Frames are
// ciphertext, so the cache is as safe as the CDN. It is keyed by each frame's
// SHA-256: frames never change, so an entry stays right even when compaction
// moves its frame to another pack. Least recently used frames go first.
//
// Segments of format 2 frames (§7.3) are kept on their own too, when only
// part of a frame was read: a PDF's pages or ffmpeg's reads come back to the
// same few, and each would otherwise be another request to Discord. Their
// own tags check them when they are opened, so the cache doesn't. A whole
// frame kept replaces its segments.

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

/** A frame being fetched, and how many callers wait for it. */
interface Loading {
  frame: Promise<Uint8Array>
  controller: AbortController
  waiting: number
}

export class FrameCache {
  readonly #dir: string
  readonly #maxBytes: number
  readonly #log: Pick<FastifyBaseLogger, 'warn'> | undefined
  readonly #metrics: Metrics | undefined
  /** Frames on disk, by SHA-256 in hex, least recently used first, with their sizes. */
  readonly #entries = new Map<string, number>()
  #bytes = 0
  /** Frames on their way to the disk, readable already. */
  readonly #writing = new Map<string, Uint8Array>()
  #writingBytes = 0
  readonly #writes = new Set<Promise<void>>()
  /** Fetches under way, so readers of the same frame share one. */
  readonly #loading = new Map<string, Loading>()
  /** Segments kept on their own, by their frame's key: so a whole frame kept can drop them. */
  readonly #segmentsOf = new Map<string, Set<string>>()
  #segmentCount = 0
  readonly #ready: Promise<void>
  /** Since start, for measuring. */
  readonly stats = { hits: 0, misses: 0 }

  constructor(options: {
    dir: string
    maxBytes: number
    log?: Pick<FastifyBaseLogger, 'warn'>
    metrics?: Metrics
  }) {
    this.#dir = options.dir
    this.#maxBytes = options.maxBytes
    this.#log = options.log
    this.#metrics = options.metrics
    // Finds what earlier runs cached, in the background: until then, it misses.
    this.#ready = this.#scan().catch((error: unknown) => {
      this.#log?.warn({ err: error }, 'could not read the frame cache; starting it empty')
    })
  }

  /** Resolves once the frames earlier runs cached are known. */
  ready(): Promise<void> {
    return this.#ready
  }

  /** Bytes of frames on disk. */
  get bytes(): number {
    return this.#bytes
  }

  /** Whole frames on disk, leaving out segments kept on their own. */
  get frames(): number {
    return this.#entries.size - this.#segmentCount
  }

  /**
   * Admin → System: lets every frame go, after those on their way to the disk
   * are written. Frames read later are cached again. Returns the bytes freed.
   */
  async clear(): Promise<number> {
    await this.ready()
    await this.idle()
    const freed = this.#bytes
    const keys = [...this.#entries.keys()]
    this.#entries.clear()
    this.#segmentsOf.clear()
    this.#segmentCount = 0
    this.#bytes = 0
    // A file a download has open on Windows stays until the next start finds it.
    for (const key of keys) await rm(this.#file(key), { force: true }).catch(() => undefined)
    return freed
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
   * Once `signal` aborts, this caller stops waiting, rejecting with its
   * reason; the fetch gives up (through the signal it was given) once every
   * caller has, and what it gave up on isn't cached.
   */
  async load(
    frameSha256: Uint8Array,
    fetch: (signal: AbortSignal) => Promise<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const key = Buffer.from(frameSha256).toString('hex')
    const cached = await this.#read(key)
    if (cached) {
      if (Buffer.from(await sha256(cached)).equals(frameSha256)) {
        this.stats.hits += 1
        this.#metrics?.record('cache.hits')
        return cached
      }
      this.#forget(key)
    }
    this.stats.misses += 1
    this.#metrics?.record('cache.misses')
    signal?.throwIfAborted()
    let loading = this.#loading.get(key)
    if (!loading) {
      const controller = new AbortController()
      const started: Loading = { frame: fetch(controller.signal), controller, waiting: 0 }
      void started.frame.then(
        (frame) => {
          if (this.#loading.get(key) === started) this.#loading.delete(key)
          this.put(frameSha256, frame)
        },
        () => {
          if (this.#loading.get(key) === started) this.#loading.delete(key)
        },
      )
      this.#loading.set(key, started)
      loading = started
    }
    return this.#wait(key, loading, signal)
  }

  /** `loading`'s frame, unless `signal` aborts first; the last caller to leave stops the fetch. */
  async #wait(key: string, loading: Loading, signal: AbortSignal | undefined): Promise<Uint8Array> {
    loading.waiting += 1
    const aborted = Promise.withResolvers<never>()
    const giveUp = () => {
      aborted.reject(signal?.reason as Error)
    }
    signal?.addEventListener('abort', giveUp, { once: true })
    try {
      return await Promise.race([loading.frame, aborted.promise])
    } finally {
      signal?.removeEventListener('abort', giveUp)
      loading.waiting -= 1
      // Stopping a fetch that has finished does nothing.
      if (signal?.aborted && loading.waiting === 0) {
        // Nobody wants it now: a reader that comes later starts afresh.
        if (this.#loading.get(key) === loading) this.#loading.delete(key)
        loading.controller.abort()
      }
    }
  }

  /**
   * Keeps a frame whose SHA-256 has been checked, in place of any segments of
   * it kept on their own. Skipped when too much waits for the disk.
   */
  put(frameSha256: Uint8Array, frame: Uint8Array): void {
    const key = Buffer.from(frameSha256).toString('hex')
    if (this.#entries.has(key) || this.#writing.has(key)) return
    if (!this.#keep(key, frame)) return
    for (const segment of this.#segmentsOf.get(key) ?? []) this.#forget(segment)
  }

  /** Whether a segment of a frame is kept on its own, as far as the cache knows. */
  hasSegment(frameSha256: Uint8Array, index: number): boolean {
    const key = segmentKey(frameSha256, index)
    return this.#entries.has(key) || this.#writing.has(key)
  }

  /** A segment kept on its own, unchecked: `null` if it is gone (evicted since), which is a miss. */
  segment(frameSha256: Uint8Array, index: number): Promise<Uint8Array | null> {
    return this.#read(segmentKey(frameSha256, index))
  }

  /** Keeps a segment of a frame read in part. Skipped when too much waits for the disk. */
  putSegment(frameSha256: Uint8Array, index: number, bytes: Uint8Array): void {
    const key = segmentKey(frameSha256, index)
    if (this.#entries.has(key) || this.#writing.has(key)) return
    this.#keep(key, bytes)
  }

  /** Lets a segment go that failed its tag: it is fetched again. */
  forgetSegment(frameSha256: Uint8Array, index: number): void {
    this.#forget(segmentKey(frameSha256, index))
  }

  /** Counts a read served from the cache, or one fetched instead, in the stats and metrics. */
  counted(hit: boolean): void {
    if (hit) {
      this.stats.hits += 1
      this.#metrics?.record('cache.hits')
    } else {
      this.stats.misses += 1
      this.#metrics?.record('cache.misses')
    }
  }

  /** Writes `bytes` under `key` in the background; `false` if too much waits for the disk. */
  #keep(key: string, bytes: Uint8Array): boolean {
    if (bytes.length > this.#maxBytes || this.#writingBytes + bytes.length > MAX_WRITING_BYTES) {
      return false
    }
    this.#writing.set(key, bytes)
    this.#writingBytes += bytes.length
    const write = this.#write(key, bytes).finally(() => {
      this.#writing.delete(key)
      this.#writingBytes -= bytes.length
      this.#writes.delete(write)
    })
    this.#writes.add(write)
    return true
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
      this.#track(key)
    }
    await this.#evict()
  }

  async #evict(): Promise<void> {
    for (const [key, size] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) return
      this.#entries.delete(key)
      this.#bytes -= size
      this.#untrack(key)
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
    this.#untrack(key)
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
      this.#track(key)
    }
    await this.#evict()
  }

  /** Notes a segment's key under its frame's. */
  #track(key: string): void {
    const frame = frameOfSegment(key)
    if (!frame) return
    let segments = this.#segmentsOf.get(frame)
    if (!segments) {
      segments = new Set()
      this.#segmentsOf.set(frame, segments)
    }
    if (!segments.has(key)) this.#segmentCount += 1
    segments.add(key)
  }

  #untrack(key: string): void {
    const frame = frameOfSegment(key)
    if (!frame) return
    const segments = this.#segmentsOf.get(frame)
    if (segments?.delete(key)) this.#segmentCount -= 1
    if (segments?.size === 0) this.#segmentsOf.delete(frame)
  }

  #file(key: string): string {
    return path.join(this.#dir, key.slice(0, 2), `${key}.frame`)
  }
}

/** A segment's key: its frame's, and its index. */
function segmentKey(frameSha256: Uint8Array, index: number): string {
  return `${Buffer.from(frameSha256).toString('hex')}-${String(index)}`
}

/** The frame a segment's key belongs to; `null` for a whole frame's key. */
function frameOfSegment(key: string): string | null {
  const dash = key.indexOf('-')
  return dash < 0 ? null : key.slice(0, dash)
}
