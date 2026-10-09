import type { Executor } from '@dfs/db'
import {
  coverFileRank,
  MAX_AUDIO_QUEUE,
  MAX_COVER_BYTES,
  MEDIA_EXTENSION_KINDS,
  mediaKind,
  playOrder,
  type AudioQueue,
  type AudioTrack,
  type MediaTags,
} from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { DownloadableFile } from '../content/send.ts'
import { VISIBLE, type NodeRow } from '../nodes/read.ts'

// What the audio bar asks besides the player's routes (DESIGN.md §6.7,
// §10.4): a folder's audio files in play order, for its queue, and the
// picture beside an audio file when its tags hold none.

/** Audio names, for the database to look among a folder's files; `mediaKind` decides. */
const AUDIO_NAME = `\\.(${Object.entries(MEDIA_EXTENSION_KINDS)
  .filter(([, kind]) => kind === 'audio')
  .map(([extension]) => extension.slice(1))
  .join('|')})$`

/** A deep folder's files read to find its audio: past this, the queue says it was cut short. */
const MAX_READ = 20_000
/** Folders this deep below the one asked about aren't searched. */
const MAX_DEPTH = 32

/** An audio file as the database has it, with where it sits below the folder asked about. */
interface QueuedFile {
  id: string
  name: string
  mime_type: string | null
  version_id: string
  /** The folders between the one asked about and the file: `[]` for its own files. */
  path: string[]
  duration_ms: number | null
  tags: Partial<MediaTags> | null
  has_cover: boolean | null
  /** A picture beside it makes a cover (`coverBeside`). */
  cover_beside: boolean
}

/** The names `coverFileRank` takes, for the database. */
const COVER_NAME = '^(cover|folder|front)\\.(jpe?g|png|webp)$'

/**
 * A folder's audio files, or everything below it (`deep`), in play order, at
 * most `MAX_AUDIO_QUEUE`: those uploaded and visible, with what the media
 * info kept for their current versions says of them.
 */
export async function audioQueue(
  db: Executor,
  folderId: string,
  deep: boolean,
): Promise<AudioQueue> {
  const { rows } = await db.execute<QueuedFile & Record<string, unknown>>(sql`
    WITH RECURSIVE tree AS (
      SELECT id, ARRAY[]::text[] AS path FROM nodes WHERE id = ${folderId}
      UNION ALL
      SELECT child.id, tree.path || child.name
      FROM nodes child JOIN tree ON child.parent_id = tree.id
      WHERE ${deep}::boolean AND child.kind = 'folder' AND child.deleted_at IS NULL
        AND child.trashed_via IS NULL AND cardinality(tree.path) < ${MAX_DEPTH}
    )
    SELECT n.id, n.name, n.mime_type, version.id AS version_id, tree.path,
      (info.info ->> 'durationMs')::float8 AS duration_ms, info.info -> 'tags' AS tags,
      (info.info ->> 'hasCover')::boolean AS has_cover,
      EXISTS (
        SELECT 1 FROM nodes picture
        JOIN file_versions shown ON shown.id = picture.current_version_id
        WHERE picture.parent_id = n.parent_id AND picture.kind = 'file'
          AND picture.deleted_at IS NULL AND picture.trashed_via IS NULL
          AND shown.state IN ('syncing', 'stored')
          AND shown.size_bytes BETWEEN 1 AND ${MAX_COVER_BYTES}
          AND lower(picture.name) ~ ${COVER_NAME}) AS cover_beside
    FROM tree
    JOIN nodes n ON n.parent_id = tree.id
    JOIN file_versions version ON version.id = n.current_version_id
    LEFT JOIN media_info info ON info.version_id = version.id
    WHERE n.kind = 'file' AND ${VISIBLE} AND version.state IN ('syncing', 'stored')
      AND (n.mime_type LIKE 'audio/%'
        OR (coalesce(n.mime_type, '') NOT LIKE 'video/%' AND lower(n.name) ~ ${AUDIO_NAME}))
    LIMIT ${MAX_READ + 1}`)
  const files = playOrder(
    rows
      .filter((row) => mediaKind(row.name, row.mime_type) === 'audio')
      .map((row) => ({ ...row, disc: row.tags?.disc ?? null, track: row.tags?.track ?? null })),
  )
  return {
    items: files.slice(0, MAX_AUDIO_QUEUE).map(toTrack),
    truncated: files.length > MAX_AUDIO_QUEUE || rows.length > MAX_READ,
  }
}

function toTrack(file: QueuedFile): AudioTrack {
  return {
    id: file.id,
    name: file.name,
    versionId: file.version_id,
    durationMs: file.duration_ms === null ? null : Math.round(file.duration_ms),
    title: file.tags?.title ?? null,
    artist: file.tags?.artist ?? null,
    album: file.tags?.album ?? null,
    hasCover: file.has_cover === true || file.cover_beside,
  }
}

/**
 * The picture beside an audio file to show as its cover (§6.7): `cover`,
 * `folder` or `front`, a JPEG, PNG or WebP, uploaded, visible and not too
 * large; `null` without one.
 */
export async function coverBeside(
  db: Executor,
  audio: Pick<NodeRow, 'owner_id' | 'parent_id'>,
): Promise<DownloadableFile | null> {
  if (!audio.parent_id) return null
  const { rows } = await db.execute<DownloadableFile & Record<string, unknown>>(sql`
    SELECT n.name, n.mime_type,
      version.id AS version_id, version.size_bytes::float8 AS size_bytes, version.chunk_size,
      version.chunk_count, version.wrapped_dek, version.key_id
    FROM nodes n JOIN file_versions version ON version.id = n.current_version_id
    WHERE n.parent_id = ${audio.parent_id} AND n.owner_id = ${audio.owner_id} AND n.kind = 'file'
      AND ${VISIBLE} AND version.state IN ('syncing', 'stored')
      AND version.size_bytes BETWEEN 1 AND ${MAX_COVER_BYTES}
      AND lower(n.name) ~ ${COVER_NAME}`)
  const ranked = rows
    .map((file) => ({ file, rank: coverFileRank(file.name) }))
    .filter((found): found is { file: DownloadableFile; rank: number } => found.rank !== null)
    .sort((a, b) => a.rank - b.rank)
  return ranked[0]?.file ?? null
}
