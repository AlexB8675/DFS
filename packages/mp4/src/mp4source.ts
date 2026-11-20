import { chooseTracks, playTrack } from './choose.ts'
import type { PlayTrack } from './choose.ts'
import { codecNames } from './codecs.ts'
import { Mp4Error } from './errors.ts'
import { sliceTable } from './frames.ts'
import type { FrameTable } from './frames.ts'
import type { Movie, TrackHeader } from './movie.ts'
import type { Chunk, SoundOffer } from './source.ts'
import { frameAtOrAfter, keyframeAtOrBefore, pictureEnd, presentationSeconds } from './timing.ts'
import type { FragmentTrack } from './write.ts'

// An MP4 as a source (DESIGN.md §10.4, D45): the same five things that a Matroska
// file gives the player's engine (`source.ts`), made from the reader that exists,
// `readMovie` and the frame tables. Nothing here reads the file or keeps state: an
// index is a function of the movie and the file's size, and a cursor is the id of
// the sound and the next frame of each track, which the caller carries.
//
// The index is `chooseTracks`'s, with one difference that D45 asks for: the
// player may choose among the sounds. The picture is held to the rules exactly as
// `chooseTracks` holds it. The first sound is too, and a first sound that fails is
// no longer a reason to refuse the file but the first offer, as its refusal, with
// the sentence `chooseTracks` gives; a first sound with no frames is no sound at
// all and is not offered. The sounds after the first are offered by their names
// alone (`codecNames` of their one description), and not expanded: only the sound
// that plays has its frames in memory, and `mp4Sound` expands another when the
// player chooses it.
//
// A cursor names the sound it plays by its id, and the index holds only the one
// sound that plays: to play another, the caller makes an index with that sound
// (`{ ...index, sound: mp4Sound(index, id) }`), so that the source stays pure.

/** The sentence that a sound's refusal begins with, as `playTrack` has it. */
const SOUND = "The sound track can't be played: "

/** What opening an MP4 gives. */
export interface Mp4Index {
  container: 'mp4'
  /** The movie the index was made from, which `mp4Sound` expands a later sound from. */
  movie: Movie
  /** The size of the file the tracks were held to. */
  fileSize: number
  video: PlayTrack
  /** The sound that plays: the first sound track, when it can and has frames (D45), else none. */
  sound: PlayTrack | null
  /** Every sound track of the file, in the order of its `moov`, with what the player needs to offer it or to say why it can't. A first sound with no frames is left out. */
  sounds: readonly SoundOffer[]
  /** The end of the picture, in seconds (`pictureEnd`). */
  durationSeconds: number
}

/** Where reading goes on in an MP4: the sound that plays, by its id, and the next frame of each track. */
export interface Mp4Cursor {
  container: 'mp4'
  /** The id of the sound that plays, or null for none. */
  sound: number | null
  /** The next frame of the picture and of the sound to give out. */
  videoFrame: number
  soundFrame: number
}

/** The offer of a sound that plays. */
function offerOf(track: PlayTrack): SoundOffer {
  return {
    id: track.header.id,
    language: track.header.language,
    codecNames: track.codecNames,
    codec: track.codec,
  }
}

/**
 * The offer of a sound after the first: made from the names of its one
 * description alone, which is the cheapest of `playTrack`'s rules after those
 * that look at the track's header, so that no frame is expanded. The rules are
 * `playTrack`'s, in its order and with its sentences: a `problem`, no description
 * or several, and a codec that no browser takes, each said after "The sound track
 * can't be played: ". What is wrong with its frames, where they are kept or its
 * edit list is found when the player chooses it (`mp4Sound`).
 */
function laterOffer(track: TrackHeader): SoundOffer {
  const base = { id: track.id, language: track.language }
  try {
    if (track.problem !== null) throw new Mp4Error('damaged', track.problem)
    const [only, ...more] = track.entries
    if (!only) throw new Mp4Error('damaged', 'The track has no sample description.')
    if (more.length > 0) {
      throw new Mp4Error(
        'several-descriptions',
        `The track has ${track.entries.length} sample descriptions, and the player's buffer is set up from only one.`,
      )
    }
    const names = codecNames(only)
    return { ...base, codecNames: names, codec: names[0] }
  } catch (error) {
    if (!(error instanceof Mp4Error)) throw error
    return { ...base, refusal: new Mp4Error(error.reason, SOUND + error.message) }
  }
}

/**
 * The index of a movie in a file of `fileSize` bytes: the picture and the sound
 * that plays, held to the rules of `chooseTracks`, and an offer for each sound.
 *
 * - The picture throws what `chooseTracks` throws (a `fileSize` that is not a
 *   count of bytes is a RangeError, a movie with no picture `no-picture`, a picture
 *   that can't be played its reason), before any sound is looked at.
 * - The first sound track plays when it can. When it can't, its refusal is the
 *   first offer, the `Mp4Error` that `chooseTracks` would have thrown, and nothing
 *   plays; when it has no frames it is left out of the offers and nothing plays.
 * - The sound tracks after it are offered by `codecNames` alone (`laterOffer`), and
 *   are never expanded here.
 * - The duration is the picture's end (`pictureEnd`).
 */
export function mp4Index(movie: Movie, fileSize: number): Mp4Index {
  // The picture is `chooseTracks`'s, asked of the movie without its sound tracks, so that its rules and its sentences are the same ones and cannot drift.
  const { video } = chooseTracks(
    { ...movie, tracks: movie.tracks.filter((track) => track.kind !== 'audio') },
    fileSize,
  )

  const [first, ...later] = movie.tracks.filter((track) => track.kind === 'audio')
  let sound: PlayTrack | null = null
  const sounds: SoundOffer[] = []
  if (first !== undefined) {
    try {
      const played = playTrack(first, movie.timescale, fileSize, 'sound')
      // A sound with no frames is no sound: a SourceBuffer with nothing appended to it would stall the video at 0.
      if (played.table.count > 0) {
        sound = played
        sounds.push(offerOf(played))
      }
    } catch (error) {
      if (!(error instanceof Mp4Error)) throw error
      sounds.push({ id: first.id, language: first.language, refusal: error })
    }
  }
  for (const track of later) sounds.push(laterOffer(track))

  return {
    container: 'mp4',
    movie,
    fileSize,
    video,
    sound,
    sounds,
    durationSeconds: pictureEnd(video),
  }
}

/**
 * A sound track of the file, expanded into its frames and held to the rules as the
 * first sound is: the track for `{ ...index, sound: mp4Sound(index, id) }`, when the
 * player chooses it. It is refused as `playTrack` refuses it (an `Mp4Error` said
 * after "The sound track can't be played: "). An id that is not one of the file's
 * sound tracks is a RangeError, the caller's mistake.
 */
export function mp4Sound(index: Mp4Index, id: number): PlayTrack {
  const track = index.movie.tracks.find((one) => one.kind === 'audio' && one.id === id)
  if (track === undefined) {
    throw new RangeError(`${id} is not the id of a sound track of this file.`)
  }
  return playTrack(track, index.movie.timescale, index.fileSize, 'sound')
}

/**
 * The sound that plays, when `id` is its id, and null for none. Any other id is a
 * RangeError, whose sentence says what to do: the index holds only one sound's
 * frames.
 */
function chosenSound(index: Mp4Index, id: number | null): PlayTrack | null {
  if (id === null) return null
  if (index.sound?.header.id !== id) {
    throw new RangeError(
      `${id} is not the sound that this index plays. To play another sound of the file, make an index with that sound: { ...index, sound: mp4Sound(index, ${id}) }.`,
    )
  }
  return index.sound
}

/** A cursor at the start of the file, for the sound that plays or none. */
export function mp4Start(index: Mp4Index, sound: number | null): Mp4Cursor {
  chosenSound(index, sound)
  return { container: 'mp4', sound, videoFrame: 0, soundFrame: 0 }
}

/**
 * The cursor for a seek to `seconds`, made at once, for no read is needed to find a
 * frame in tables that are held. The picture goes to the keyframe to decode from
 * (`keyframeAtOrBefore`). The sound goes to the last frame decoded at or before the
 * time that keyframe is shown, so that the sound covers the picture's first frame
 * (step 5's M1): the first frame decoded at or after that time when it is decoded
 * at exactly that time, and else the one before it, never below the first. A time
 * that is no number is a RangeError, as is a sound that the index does not play.
 */
export function mp4Seek(index: Mp4Index, seconds: number, sound: number | null): Mp4Cursor {
  if (Number.isNaN(seconds)) throw new RangeError(`${seconds} is not a time.`)
  const track = chosenSound(index, sound)
  const { video } = index
  const videoFrame = keyframeAtOrBefore(video.table, video.timing, video.keyframes, seconds)
  let soundFrame = 0
  if (track !== null) {
    const shown = presentationSeconds(video.table, video.timing, videoFrame)
    const { table, timing } = track
    const first = frameAtOrAfter(table, timing, shown)
    // The decode time as the tables work it out (`decodeSeconds`), the same expression so that the two agree to the last bit.
    const decoded =
      first < table.count ? (table.dts[first] ?? 0) / table.timescale + timing.offsetSeconds : NaN
    soundFrame = decoded === shown ? first : Math.max(first - 1, 0)
  }
  return { container: 'mp4', sound, videoFrame, soundFrame }
}

/** The sound the cursor plays, or null for none; a cursor that is not one of this index (a sound it does not play, or a frame that the tables of the tracks that play do not have) is a RangeError, the caller's mistake. */
function checkCursor(index: Mp4Index, cursor: Mp4Cursor): PlayTrack | null {
  const track = chosenSound(index, cursor.sound)
  const counts: [number, number][] = [[cursor.videoFrame, index.video.table.count]]
  if (track !== null) counts.push([cursor.soundFrame, track.table.count])
  for (const [frame, count] of counts) {
    if (!Number.isInteger(frame) || frame < 0 || frame > count) {
      throw new RangeError(`Frame ${frame} is not one of the ${count} frames of the track.`)
    }
  }
  return track
}

/**
 * Where to read the file next: the least offset of the next frame of each track,
 * for the frames are not in the file in the order they are decoded, and a track
 * that is done is left out. Null when both are done (a sound that does not play is
 * not waited for).
 */
export function mp4Next(index: Mp4Index, cursor: Mp4Cursor): number | null {
  const track = checkCursor(index, cursor)
  let least: number | null = null
  const tables: [FrameTable, number][] = [[index.video.table, cursor.videoFrame]]
  if (track !== null) tables.push([track.table, cursor.soundFrame])
  for (const [table, frame] of tables) {
    if (frame >= table.count) continue
    const offset = table.offsets[frame] ?? 0
    if (least === null || offset < least) least = offset
  }
  return least
}

/**
 * Where each track reads next: the offset of the next frame of the picture and of
 * the sound that plays, each null when that track is done (and the sound's null
 * when none plays). `mp4Next` is the least of the two. A file whose sound lies
 * apart from its picture needs both, for reading at the least alone only ever
 * advances the track that comes first.
 */
export function mp4Nexts(
  index: Mp4Index,
  cursor: Mp4Cursor,
): { video: number | null; audio: number | null } {
  const track = checkCursor(index, cursor)
  const next = (table: FrameTable, frame: number): number | null =>
    frame < table.count ? (table.offsets[frame] ?? 0) : null
  return {
    video: next(index.video.table, cursor.videoFrame),
    audio: track === null ? null : next(track.table, cursor.soundFrame),
  }
}

/** How many frames from `from` lie whole inside the chunk, up to the first that does not. */
function wholeIn(table: FrameTable, from: number, chunk: Chunk): number {
  const end = chunk.start + chunk.bytes.length
  let to = from
  while (to < table.count) {
    const offset = table.offsets[to] ?? 0
    if (offset < chunk.start || offset + (table.sizes[to] ?? 0) > end) break
    to += 1
  }
  return to
}

/**
 * The frames that the chunk completes, and the cursor to go on with: from the next
 * frame of the picture, and of the sound that plays, each frame is taken while
 * its bytes lie inside the chunk, and the track stops at the first that does
 * not (a frame after it, though inside, waits: they are given in decode order).
 * Each track that took any gives a slice of its table (`sliceTable`, views, not
 * copies), the picture first. Nothing is skipped in an MP4, so `skipped` is empty.
 * The cursor given is never changed. A chunk that holds no frame whole gives
 * nothing and a cursor where it was: the caller reads more from where `mp4Next` says.
 */
export function mp4Frames(
  index: Mp4Index,
  cursor: Mp4Cursor,
  chunk: Chunk,
): { frames: FragmentTrack[]; cursor: Mp4Cursor; skipped: [] } {
  const track = checkCursor(index, cursor)
  const frames: FragmentTrack[] = []
  const videoTo = wholeIn(index.video.table, cursor.videoFrame, chunk)
  if (videoTo > cursor.videoFrame) {
    frames.push({
      header: { id: index.video.header.id },
      table: sliceTable(index.video.table, cursor.videoFrame, videoTo),
    })
  }
  let soundTo = cursor.soundFrame
  if (track !== null) {
    soundTo = wholeIn(track.table, cursor.soundFrame, chunk)
    if (soundTo > cursor.soundFrame) {
      frames.push({
        header: { id: track.header.id },
        table: sliceTable(track.table, cursor.soundFrame, soundTo),
      })
    }
  }
  return {
    frames,
    cursor: { container: 'mp4', sound: cursor.sound, videoFrame: videoTo, soundFrame: soundTo },
    skipped: [],
  }
}
