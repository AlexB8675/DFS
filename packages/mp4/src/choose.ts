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
 * One chosen track, checked from the cheapest rule to the dearest, and the first
 * that fails is the reason: its `problem`; one sample description; a codec
 * string (and the entry that carries it) and an edit list that can be placed,
 * both read from a few bytes; and only then its frames, which a sound in PCM
 * (refused above, as an unsupported codec) can number in millions. A picture
 * with no keyframe has nowhere to start decoding.
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
    const timing = trackTiming(track, movieTimescale)
    const table = frameTable(track)
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
 * reason to play elsewhere (D45). The picture is checked first, so its reason is
 * the one given when both fail.
 */
export function chooseTracks(movie: Movie): { video: PlayTrack; audio: PlayTrack | null } {
  const picture = movie.tracks.find((track) => track.kind === 'video')
  if (!picture) {
    throw new Mp4Error('no-picture', 'The file has no picture track, so there is nothing to play.')
  }
  const video = playTrack(picture, movie.timescale, 'picture')
  const sound = movie.tracks.find((track) => track.kind === 'audio')
  return { video, audio: sound ? playTrack(sound, movie.timescale, 'sound') : null }
}
