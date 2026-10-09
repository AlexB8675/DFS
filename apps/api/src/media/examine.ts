import type { MasterKeys } from '@dfs/crypto'
import { mediaInfo, type Executor } from '@dfs/db'
import {
  isTextSubtitles,
  MAX_SUBTITLE_STREAMS,
  mediaInfoSchema,
  mediaKind,
  type MediaInfo,
  type SubtitleTrack,
} from '@dfs/shared'
import { eq } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { MediaUnavailableError, type MediaClient } from './client.ts'
import { keepSubtitles, keptStreams, keptSubtitles, type KeptSubtitles } from './subtitles.ts'
import { mediaToken } from './token.ts'

// Examining audio and video (DESIGN.md §6.7): once per version, right after
// its upload completes, while its frames are still in staging and cost
// nothing from Discord, or else when first played. What the media service
// finds is kept, including that a file holds nothing ffmpeg reads; a service
// that didn't answer is asked again next time. Text subtitles inside the file
// are extracted then too, since an MKV's are spread through all of it, or
// else when first chosen.

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
  readonly #keys: MasterKeys
  readonly #log: FastifyBaseLogger
  /** Examinations under way, by version, so those who ask at once share one. */
  readonly #examining = new Map<string, Promise<Examined>>()
  /** Extractions of subtitles under way, by version, likewise. */
  readonly #extracting = new Map<string, Promise<void>>()
  /**
   * Extractions after uploads, one after another: one reads a whole file,
   * so it doesn't hold a place examinations need.
   */
  #afterUploadExtractions: Promise<void> = Promise.resolve()
  readonly #queued: string[] = []
  #running = 0

  constructor(options: {
    client: MediaClient
    db: Executor
    keys: MasterKeys
    log: FastifyBaseLogger
  }) {
    this.client = options.client
    this.#db = options.db
    this.#keys = options.keys
    this.#log = options.log
  }

  /**
   * The picture in an audio version's tags, copied out by the media service
   * each time it is asked: the browser keeps it, not the server (§6.7).
   * Throws a `MediaUnavailableError` if the media service can't say now.
   */
  async cover(versionId: string): Promise<Buffer | null> {
    return this.client.cover(versionId, await mediaToken(this.#keys, versionId))
  }

  /**
   * What the version holds: kept from before, or examined now. Throws a
   * `MediaUnavailableError` if the media service can't say now.
   */
  async examined(versionId: string): Promise<Examined> {
    return (await this.kept(versionId)) ?? this.examine(versionId)
  }

  /** What examining the version found before, if it was. */
  kept(versionId: string): Promise<Examined | null> {
    return keptExamination(this.#db, versionId)
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
   * A text subtitle stream of the version as WebVTT, or why not: kept, or
   * extracted now with its others. Throws a `MediaUnavailableError` if the
   * media service can't say now.
   */
  async subtitles(versionId: string, info: MediaInfo, streamIndex: number): Promise<KeptSubtitles> {
    const kept = await keptSubtitles(this.#db, this.#keys, versionId, streamIndex)
    if (kept) return kept
    await this.extract(versionId, info)
    return (
      (await keptSubtitles(this.#db, this.#keys, versionId, streamIndex)) ?? {
        problem: 'These subtitles can’t be read.',
      }
    )
  }

  /** Extracts the version's text subtitle streams not kept yet, once however many ask. */
  extract(versionId: string, info: MediaInfo): Promise<void> {
    let extracting = this.#extracting.get(versionId)
    if (!extracting) {
      extracting = this.#extract(versionId, info).finally(() => {
        this.#extracting.delete(versionId)
      })
      this.#extracting.set(versionId, extracting)
    }
    return extracting
  }

  /**
   * After an upload completes: examines the version in the background if
   * it is audio or video, a few at a time, and extracts its subtitles.
   * Best effort: one that fails is examined when first played.
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
        .then(({ info }) => {
          if (info?.streams.some(isTextSubtitles)) this.#extractAfterUpload(versionId, info)
        })
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

  #extractAfterUpload(versionId: string, info: MediaInfo): void {
    this.#afterUploadExtractions = this.#afterUploadExtractions
      .then(() => this.extract(versionId, info))
      .catch((error: unknown) => {
        this.#log.info(
          { err: error, versionId },
          'could not extract an uploaded file’s subtitles; they will be when chosen',
        )
      })
  }

  async #extract(versionId: string, info: MediaInfo): Promise<void> {
    const kept = await keptStreams(this.#db, versionId)
    const streams = info.streams
      .filter((stream) => isTextSubtitles(stream) && !kept.has(stream.index))
      .map((stream) => stream.index)
      .slice(0, MAX_SUBTITLE_STREAMS)
    if (!streams.length) return
    const token = await mediaToken(this.#keys, versionId)
    const result = await this.client.subtitles(versionId, token, streams)
    // Only the streams asked for; one the service left out couldn't be read.
    const tracks: SubtitleTrack[] = streams.map((index) => {
      const track = result.ok ? result.tracks.find((found) => found.index === index) : undefined
      return (
        track ?? {
          index,
          vtt: null,
          problem: result.ok ? 'These subtitles can’t be read.' : result.reason,
        }
      )
    })
    await keepSubtitles(this.#db, this.#keys, versionId, tracks)
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

/**
 * What examining a version found before, if it was: read from the database,
 * so it is served even while the media service is away.
 */
export async function keptExamination(db: Executor, versionId: string): Promise<Examined | null> {
  const [row] = await db
    .select({ info: mediaInfo.info, problem: mediaInfo.problem })
    .from(mediaInfo)
    .where(eq(mediaInfo.versionId, versionId))
  if (!row) return null
  // Kept by an earlier API: read within today's bounds, or examined again.
  const info = row.info === null ? null : mediaInfoSchema.safeParse(row.info)
  if (info && !info.success) return null
  return { info: info?.data ?? null, problem: row.problem }
}

export { MediaUnavailableError }
