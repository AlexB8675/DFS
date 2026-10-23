import { codecString, initEntry } from './codecs.ts'
import { Mp4Error } from './errors.ts'
import { frameTable } from './frames.ts'
import type { FrameTable } from './frames.ts'
import type { Movie, TrackHeader } from './movie.ts'
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

/** A track ready to play: its header, frames, timing, codec string and the entry its init segment carries. */
export interface PlayTrack {
  header: TrackHeader
  table: FrameTable
  timing: TrackTiming
  /** The RFC 6381 string that Media Source is asked about. */
  codec: string
  /** The sample entry for the init segment's `stsd`: the track's own, or an ISO one made from a QuickTime sound entry. */
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
 * One chosen track, checked from the cheapest rule to the dearest, and the first
 * that fails is the reason: its `problem`; one sample description; a codec
 * string (and the entry that carries it) and an edit list that can be placed,
 * both read from a few bytes; and only then its frames, which a sound in PCM
 * (refused above, as an unsupported codec) can number in millions. A picture
 * with no keyframe has nowhere to start decoding. The edit list is placed with
 * the time the first frame is shown: the media edit starts there if it begins
 * earlier, as FFmpeg has it (the writers meant the first frame at the edit's
 * start; 154 of the 192 pictures with an edit list in the corpus begin it before
 * their first frame, by up to 0.198 s).
 */
function playTrack(
  track: TrackHeader,
  movieTimescale: number,
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
    const codec = codecString(only)
    const entry = initEntry(only)
    trackTiming(track, movieTimescale)
    const table = frameTable(track)
    const timing = trackTiming(track, movieTimescale, firstPresented(table))
    const keyframes = keyframeIndexes(table)
    if (what === 'picture' && keyframes.length === 0) {
      throw new Mp4Error('damaged', 'The track has no keyframe to decode from.')
    }
    return { header: track, table, timing, codec, entry, keyframes }
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
 * when both fail.
 */
export function chooseTracks(movie: Movie): { video: PlayTrack; audio: PlayTrack | null } {
  const picture = movie.tracks.find((track) => track.kind === 'video')
  if (!picture) {
    throw new Mp4Error('no-picture', 'The file has no picture track, so there is nothing to play.')
  }
  const video = playTrack(picture, movie.timescale, 'picture')
  const sound = movie.tracks.find((track) => track.kind === 'audio')
  const audio = sound ? playTrack(sound, movie.timescale, 'sound') : null
  // A sound with no frames is no sound: a SourceBuffer with nothing appended to it would stall the video at 0.
  return { video, audio: audio && audio.table.count > 0 ? audio : null }
}
