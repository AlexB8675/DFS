import { playbackPositions, type Executor } from '@dfs/db'
import {
  decodeSubtitles,
  MAX_SUBTITLE_FILE_BYTES,
  splitExtension,
  subtitleFileOf,
  subtitleFormat,
  toWebVtt,
  type SubtitleFile,
} from '@dfs/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { readVersion } from '../content/reader.ts'
import { ApiError } from '../errors.ts'
import { VISIBLE, type NodeRow } from '../nodes/read.ts'
import { downloadableFile, versionChanged } from '../routes/content.ts'

// What the players need besides the file (DESIGN.md §10.4): where each user
// stopped, and the subtitle files beside a video, as WebVTT.

/** The names of subtitle files, for the database to look among a folder's files. */
const SUBTITLE_NAME = String.raw`\.(srt|vtt|ass|ssa)$`

/** The video whose subtitles these are: its owner, folder and name. */
type Video = Pick<NodeRow, 'owner_id' | 'parent_id' | 'name'>

/** Subtitle files beside a video, by its name (§6.7): uploaded, visible, and not too large. */
export async function subtitleFilesBeside(db: Executor, video: Video): Promise<SubtitleFile[]> {
  if (!video.parent_id) return []
  const prefix = splitExtension(video.name).base.toLowerCase()
  const { rows } = await db.execute<{ id: string; name: string }>(sql`
    SELECT n.id, n.name FROM nodes n JOIN file_versions version ON version.id = n.current_version_id
    WHERE n.parent_id = ${video.parent_id} AND n.owner_id = ${video.owner_id} AND n.kind = 'file'
      AND ${VISIBLE} AND version.state IN ('syncing', 'stored')
      AND version.size_bytes <= ${MAX_SUBTITLE_FILE_BYTES}
      AND starts_with(lower(n.name), ${prefix}) AND lower(n.name) ~ ${SUBTITLE_NAME}
    ORDER BY n.name
    LIMIT 100`)
  return rows.flatMap((row) => {
    const said = subtitleFileOf(video.name, row.name)
    return said ? [{ id: row.id, name: row.name, ...said }] : []
  })
}

/** A subtitle file beside the video, as WebVTT; a 404 for any other file. */
export async function subtitleFileAsWebVtt(
  app: FastifyInstance,
  video: Video,
  fileId: string,
): Promise<string> {
  const beside = (await subtitleFilesBeside(app.db, video)).find((file) => file.id === fileId)
  const format = beside && subtitleFormat(beside.name)
  if (!beside || !format) throw new ApiError(404, 'not_found', 'There are no such subtitles.')
  const file = await downloadableFile(app.db, beside.id)
  const pieces: Uint8Array[] = []
  for await (const piece of readVersion(app, file, 0, file.size_bytes - 1)) pieces.push(piece)
  return toWebVtt(decodeSubtitles(Buffer.concat(pieces), beside.language), format)
}

/** Where the user stopped in this version of the file, if they did. */
export async function savedPosition(
  db: Executor,
  userId: string,
  nodeId: string,
  versionId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ positionMs: playbackPositions.positionMs })
    .from(playbackPositions)
    .where(
      and(
        eq(playbackPositions.nodeId, nodeId),
        eq(playbackPositions.userId, userId),
        eq(playbackPositions.versionId, versionId),
      ),
    )
  return row?.positionMs ?? null
}

/** Keeps where the user stopped, in the version they played. */
export async function savePosition(
  db: Executor,
  position: { userId: string; nodeId: string; versionId: string; positionMs: number },
): Promise<void> {
  try {
    await db
      .insert(playbackPositions)
      .values(position)
      .onConflictDoUpdate({
        target: [playbackPositions.nodeId, playbackPositions.userId],
        set: {
          versionId: position.versionId,
          positionMs: position.positionMs,
          updatedAt: sql`now()`,
        },
      })
  } catch (error) {
    // The version went meanwhile: a newer one replaced it.
    if ((error as { code?: unknown }).code === '23503') throw versionChanged()
    throw error
  }
}

export async function clearPosition(db: Executor, userId: string, nodeId: string): Promise<void> {
  await db
    .delete(playbackPositions)
    .where(and(eq(playbackPositions.nodeId, nodeId), eq(playbackPositions.userId, userId)))
}
