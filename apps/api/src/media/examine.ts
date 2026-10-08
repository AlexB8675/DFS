import type { MasterKeys } from '@dfs/crypto'
import { mediaInfo, type Executor } from '@dfs/db'
import { mediaInfoSchema, mediaKind, type MediaInfo } from '@dfs/shared'
import { eq } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { MediaUnavailableError, type MediaClient } from './client.ts'
import { mediaToken } from './token.ts'

// Examining audio and video (DESIGN.md §6.7): once per version, right after
// its upload completes, while its frames are still in staging and cost
// nothing from Discord, or else when first played. What the media service
// finds is kept, including that a file holds nothing ffmpeg reads; a service
// that didn't answer is asked again next time.

/** What examining a version found: its media info, or why there is none. */
export interface Examined {
  info: MediaInfo | null
  problem: string | null
}

/** Examinations after uploads at once; one asked for by a player doesn't wait for these. */
const AFTER_UPLOAD_AT_ONCE = 2

export class MediaExaminer {
  readonly client: MediaClient
  readonly #db: Executor
  readonly #keys: Pick<MasterKeys, 'sign'>
  readonly #log: FastifyBaseLogger
  /** Examinations under way, by version, so those who ask at once share one. */
  readonly #examining = new Map<string, Promise<Examined>>()
  readonly #queued: string[] = []
  #running = 0

  constructor(options: {
    client: MediaClient
    db: Executor
    keys: Pick<MasterKeys, 'sign'>
    log: FastifyBaseLogger
  }) {
    this.client = options.client
    this.#db = options.db
    this.#keys = options.keys
    this.#log = options.log
  }

  /**
   * What the version holds: kept from before, or examined now. Throws a
   * `MediaUnavailableError` if the media service can't say now.
   */
  async examined(versionId: string): Promise<Examined> {
    return (await this.kept(versionId)) ?? this.examine(versionId)
  }

  /** What examining the version found before, if it was. */
  async kept(versionId: string): Promise<Examined | null> {
    const [row] = await this.#db
      .select({ info: mediaInfo.info, problem: mediaInfo.problem })
      .from(mediaInfo)
      .where(eq(mediaInfo.versionId, versionId))
    if (!row) return null
    // Kept by an earlier API: read within today's bounds, or examined again.
    const info = row.info === null ? null : mediaInfoSchema.safeParse(row.info)
    if (info && !info.success) return null
    return { info: info?.data ?? null, problem: row.problem }
  }

  /** Examines the version, once however many ask, and keeps what is found. */
  examine(versionId: string): Promise<Examined> {
    let examining = this.#examining.get(versionId)
    if (!examining) {
      examining = this.#examine(versionId).finally(() => {
        this.#examining.delete(versionId)
      })
      this.#examining.set(versionId, examining)
    }
    return examining
  }

  /**
   * After an upload completes: examines the version in the background if
   * it is audio or video, a few at a time. Best effort: one that fails is
   * examined when first played.
   */
  afterUpload(file: { versionId: string; name: string; mimeType: string | null; size: number }) {
    if (file.size === 0 || !mediaKind(file.name, file.mimeType)) return
    this.#queued.push(file.versionId)
    this.#next()
  }

  #next(): void {
    while (this.#running < AFTER_UPLOAD_AT_ONCE) {
      const versionId = this.#queued.shift()
      if (!versionId) return
      this.#running += 1
      this.examine(versionId)
        .catch((error: unknown) => {
          this.#log.info(
            { err: error, versionId },
            'could not examine an uploaded file; it will be when played',
          )
        })
        .finally(() => {
          this.#running -= 1
          this.#next()
        })
    }
  }

  async #examine(versionId: string): Promise<Examined> {
    const token = await mediaToken(this.#keys, versionId)
    const result = await this.client.probe(versionId, token)
    const examined: Examined = result.ok
      ? { info: result.info, problem: null }
      : { info: null, problem: result.reason }
    try {
      await this.#db
        .insert(mediaInfo)
        .values({ versionId, info: examined.info, problem: examined.problem })
        .onConflictDoNothing()
    } catch (error) {
      // The version went meanwhile (a newer one pruned it): nothing to keep.
      if ((error as { code?: unknown }).code !== '23503') throw error
    }
    return examined
  }
}

export { MediaUnavailableError }
