import { openObject, sealObject, subtitlesContext, type MasterKeys } from '@dfs/crypto'
import { mediaSubtitles, type Executor } from '@dfs/db'
import type { SubtitleTrack } from '@dfs/shared'
import { and, eq } from 'drizzle-orm'

// Text subtitles extracted from inside files (DESIGN.md §6.7), kept in the
// database: each sealed as a journal object is, under a data key of its own
// bound to its version and stream, since a stolen dump must hold no content
// (§7.4). One that couldn't be extracted keeps why, so it isn't tried again.

/** A subtitle stream as kept: its WebVTT, or why there is none. */
export type KeptSubtitles = { vtt: string } | { problem: string }

/** The stream as kept, if it was extracted. */
export async function keptSubtitles(
  db: Executor,
  keys: MasterKeys,
  versionId: string,
  streamIndex: number,
): Promise<KeptSubtitles | null> {
  const [row] = await db
    .select({ sealed: mediaSubtitles.sealed, problem: mediaSubtitles.problem })
    .from(mediaSubtitles)
    .where(
      and(eq(mediaSubtitles.versionId, versionId), eq(mediaSubtitles.streamIndex, streamIndex)),
    )
  if (!row) return null
  if (row.sealed === null) return { problem: row.problem ?? 'These subtitles can’t be read.' }
  const { plaintext } = await openObject(keys, row.sealed, subtitlesContext(versionId, streamIndex))
  return { vtt: new TextDecoder().decode(plaintext) }
}

/** The version's streams already kept, by index. */
export async function keptStreams(db: Executor, versionId: string): Promise<Set<number>> {
  const rows = await db
    .select({ streamIndex: mediaSubtitles.streamIndex })
    .from(mediaSubtitles)
    .where(eq(mediaSubtitles.versionId, versionId))
  return new Set(rows.map((row) => row.streamIndex))
}

/** Keeps what was extracted, sealed; one kept already stays as it is. */
export async function keepSubtitles(
  db: Executor,
  keys: MasterKeys,
  versionId: string,
  tracks: readonly SubtitleTrack[],
): Promise<void> {
  if (!tracks.length) return
  const rows = await Promise.all(
    tracks.map(async (track) => ({
      versionId,
      streamIndex: track.index,
      sealed:
        track.vtt === null
          ? null
          : Buffer.from(
              await sealObject(
                keys,
                new TextEncoder().encode(track.vtt),
                subtitlesContext(versionId, track.index),
              ),
            ),
      problem: track.vtt === null ? (track.problem ?? 'These subtitles can’t be read.') : null,
    })),
  )
  try {
    await db.insert(mediaSubtitles).values(rows).onConflictDoNothing()
  } catch (error) {
    // The version went meanwhile (a newer one pruned it): nothing to keep.
    if ((error as { code?: unknown }).code !== '23503') throw error
  }
}
