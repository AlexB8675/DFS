import { firstBox, Reader } from './boxes.ts'
import { codecNames, initEntry } from './codecs.ts'
import { Mp4Error } from './errors.ts'
import { frameTable } from './frames.ts'
import type { FrameTable } from './frames.ts'
import type { Movie, SampleEntry, TrackHeader } from './movie.ts'
import { keyframeIndexes, trackTiming } from './timing.ts'
import type { TrackTiming } from './timing.ts'

// The picture and the sound a video plays (DESIGN.md §10.4, D45). Only these two
// tracks are held to the rules, and only these two are expanded into frames: the
// other tracks of a file (more sound, subtitles, a timecode) are not played, so
// a problem in one of them is nothing to the file. What the player's buffer
// (Media Source) can't take from the two that are chosen is a reason to play
// the video elsewhere, and is refused here with that reason.
//
// A track's timing is worked out twice: its edit list is checked before the
// frames are expanded (an edit list that can't be placed is a reason that costs
// nothing to find), and placed once the frames are there, because where the media
// edit starts depends on when the first frame is shown (see `trackTiming`).
//
// The size of the file is given, and each chosen track's frames are held to it
// (`frameTable`): they can't number more than a track may have, nor add up to, or
// end, past the end of the file.

/** A track ready to play: its header, frames, timing, codec names and the entry its init segment carries. */
export interface PlayTrack {
  header: TrackHeader
  table: FrameTable
  timing: TrackTiming
  /** The names that Media Source can be asked about, the RFC 6381 one first: the browser is asked about each in turn. */
  codecNames: readonly string[]
  /** The RFC 6381 string, which is the first of `codecNames`. */
  codec: string
  /** The sample entry for the init segment's `stsd`: the track's own, or an ISO version 0 one made from a sound entry of QuickTime's or of ISO's version 1. */
  entry: Uint8Array
  /** The indexes of the frames that can be decoded from, in decode order. */
  keyframes: Uint32Array
}

/**
 * When the first frame of the table is shown, in the track's ticks: the least
 * `dts + cts`, which is not the first frame's when the frames are shown in
 * another order than they are decoded. Undefined for a table of no frames.
 */
function firstPresented(table: FrameTable): number | undefined {
  let first = Infinity
  for (let i = 0; i < table.count; i += 1) {
    first = Math.min(first, (table.dts[i] ?? 0) + (table.cts[i] ?? 0))
  }
  return table.count === 0 ? undefined : first
}

/**
 * Refuses a picture whose media edit starts after its first frame is shown (in
 * the track's ticks, the edit's `mediaTime` against the least `dts + cts`), as
 * a cut made without re-encoding leaves it (`ffmpeg -ss … -c copy`, and so
 * LosslessCut): the frames from the keyframe before the cut are kept, behind
 * an edit that starts at the cut. The frames before it would be shown before 0,
 * where Media Source drops them, and every frame after them up to the next
 * keyframe with them (it needs a random access point again), so the picture
 * would never start. The comparison is exact: a frame one tick early is
 * dropped as a frame a second early is. `trackTiming` has accepted the list,
 * so the media edit is its last edit; no edit list, or no frame, is nothing to
 * check. Playing such a cut, from a later start, is the player's to decide (step 5).
 */
function refuseCut(track: TrackHeader, first: number | undefined): void {
  const media = track.edits?.at(-1)
  if (!media || first === undefined || media.mediaTime <= first) return
  const seconds = Number(((media.mediaTime - first) / track.timescale).toFixed(3))
  throw new Mp4Error(
    'edit-list',
    `The track's edit list starts ${seconds} s after its first frame is shown, as a cut made without re-encoding leaves it, and the player's buffer would drop the frames before the cut and every frame after them up to the next keyframe.`,
  )
}

/**
 * Refuses a track whose frames are kept in another file, as a QuickTime
 * reference movie keeps them: its tables place the frames in that file, and
 * read against this one they would play garbage. The sample description names
 * one of the track's data references by its 1-based index, in the 16 bits after
 * the entry's 6 reserved bytes (bytes 14 and 15 of an entry with an ordinary
 * header), and the reference is not flagged as this same file and holds a
 * location (a `url `'s string, an alias's record). A reference with none, even
 * with the flag clear, can only mean this file: writers get the flag wrong. An
 * index of 0 or past the list, or a track with no `dref`, names no reference,
 * and the data is taken to be in the file, as FFmpeg and mp4box read such a file.
 */
function refuseExternal(track: TrackHeader, entry: SampleEntry): void {
  const references = track.dataReferences
  if (!references) return
  const whole = firstBox(entry.bytes, 0, entry.bytes.length)
  if (!whole) throw new Mp4Error('damaged', `The '${entry.type}' sample description holds no box.`)
  const reader = new Reader(entry.bytes, whole.body, whole.end)
  reader.skip(6) // reserved
  const named = reader.u16()
  const reference = named === 0 ? undefined : references[named - 1]
  if (reference && !reference.selfContained && reference.location) {
    throw new Mp4Error(
      'external-data',
      `its frames are in another file (data reference '${reference.type}'), which the player can't read.`,
    )
  }
}

/**
 * One chosen track, checked from the cheapest rule to the dearest, and the first
 * that fails is the reason: its `problem`; one sample description; the codec
 * names (and the entry that carries them); where its frames are kept (not in
 * another file, `refuseExternal`) and an edit list that can be placed, both read
 * from a few bytes; and only then its frames, which a sound in PCM (refused
 * above, as an unsupported codec) can number in millions. A picture
 * with no keyframe has nowhere to start decoding. The edit list is placed with
 * the time the first frame is shown: the media edit starts there if it begins
 * earlier, as FFmpeg has it (the writers meant the first frame at the edit's
 * start; 154 of the 192 pictures with an edit list in the corpus begin it before
 * their first frame, by up to 0.198 s). A picture whose edit begins after its
 * first frame is refused (`refuseCut`): a cut made without re-encoding would
 * never start in the player's buffer. The frames are held to the file they are
 * in, `fileSize` bytes: a track whose frames don't lie inside it is `damaged`.
 */
function playTrack(
  track: TrackHeader,
  movieTimescale: number,
  fileSize: number,
  what: 'picture' | 'sound',
): PlayTrack {
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
    const entry = initEntry(only)
    refuseExternal(track, only)
    trackTiming(track, movieTimescale)
    const table = frameTable(track, fileSize)
    const first = firstPresented(table)
    const timing = trackTiming(track, movieTimescale, first)
    if (what === 'picture') refuseCut(track, first)
    const keyframes = keyframeIndexes(table)
    if (what === 'picture' && keyframes.length === 0) {
      throw new Mp4Error('damaged', 'The track has no keyframe to decode from.')
    }
    return { header: track, table, timing, codecNames: names, codec: names[0], entry, keyframes }
  } catch (error) {
    // Only what is wrong with the file is said again, with the track it is in: anything else is a bug here.
    if (!(error instanceof Mp4Error)) throw error
    throw new Mp4Error(error.reason, `The ${what} track can't be played: ${error.message}`)
  }
}

/**
 * The first picture track and the first sound track of a movie, in the order of
 * its `moov`, each held to the rules (`playTrack`), and no other track
 * expanded. A track is the first of its kind whatever is wrong with it: a first
 * picture that can't be read refuses the file, and isn't passed over for a
 * second. A file with no picture track is refused as `no-picture`; a file with
 * no sound track plays without sound (`audio` is null), but a first sound track
 * that fails the rules refuses it too: a sound the browser can't play is a
 * reason to play elsewhere (D45), unless it has no frames, which makes it no
 * sound at all. The picture is checked first, so its reason is the one given
 * when both fail. Each track's frames must lie inside the file, `fileSize`
 * bytes (the caller has it, as it had for `locateMoov`): more frames than a track
 * may have, a constant sample size that adds up to more than the file, or a chunk
 * that ends past it, is `damaged`. A `fileSize` that isn't a count of bytes is a
 * RangeError, the caller's mistake and not the file's, whatever the movie.
 */
export function chooseTracks(
  movie: Movie,
  fileSize: number,
): { video: PlayTrack; audio: PlayTrack | null } {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`${fileSize} is not a size that a file has.`)
  }
  const picture = movie.tracks.find((track) => track.kind === 'video')
  if (!picture) {
    throw new Mp4Error('no-picture', 'The file has no picture track, so there is nothing to play.')
  }
  const video = playTrack(picture, movie.timescale, fileSize, 'picture')
  const sound = movie.tracks.find((track) => track.kind === 'audio')
  const audio = sound ? playTrack(sound, movie.timescale, fileSize, 'sound') : null
  // A sound with no frames is no sound: a SourceBuffer with nothing appended to it would stall the video at 0.
  return { video, audio: audio && audio.table.count > 0 ? audio : null }
}
