// The tracks that play, and the names Media Source is asked for them (DESIGN.md
// §10.4, D45). The index says which picture and which sound a file has
// (`@dfs/mp4`'s `SourceIndex`, an MP4's or a Matroska file's alike); this module
// asks the browser, through a function the caller gives, which of each track's
// names its Media Source takes. It uses no DOM type: `isTypeSupported` is
// `MediaSource.isTypeSupported` in the page and a fake in a test.

import type { MatroskaPlayTrack, Mp4Refusal, PlayTrack, SourceIndex } from '@dfs/mp4'

/** A track the engine plays: the track itself, and the MIME type its SourceBuffer is made with. */
export interface EngineTrack {
  kind: 'video' | 'audio'
  /** `video/mp4; codecs="<name>"` or `audio/mp4; codecs="<name>"`, with the first name of the track's `codecNames` that the browser takes. */
  mime: string
  /** The index's own track: an MP4's has a frame table, a Matroska one has none (the feeder writes its fragments from the tables `framesIn` gives). */
  track: PlayTrack | MatroskaPlayTrack
  /** The id, in the file, of the sound that plays (what `startCursor` and `seekCursor` take), or null when none does. The picture's track and the sound's carry the same one. */
  soundId: number | null
}

/** What is chosen: the picture, and the sound when the file has one that plays. */
export interface ChosenTracks {
  video: EngineTrack
  audio: EngineTrack | null
}

/** Why a play is refused: `codec` when Media Source takes none of a track's names, else the reader's own reason. */
export interface EngineRefusal {
  refusal: string
  reason: Mp4Refusal | 'codec'
}

/** The refusal for a track whose names Media Source takes none of. */
function noName(names: readonly string[]): EngineRefusal {
  return {
    refusal: `This browser's Media Source takes none of ${names.join(', ')}`,
    reason: 'codec',
  }
}

/** The MIME type of the first of `names` that the browser takes, or null when it takes none. */
function firstTaken(
  kind: 'video' | 'audio',
  names: readonly string[],
  isTypeSupported: (mime: string) => boolean,
): string | null {
  for (const name of names) {
    const mime = `${kind}/mp4; codecs="${name}"`
    if (isTypeSupported(mime)) return mime
  }
  return null
}

/**
 * Chooses the picture and the sound that play. A sound that the browser can't
 * decode is a reason to play elsewhere, not to play silent (D45), so a play is
 * refused when:
 * - Media Source takes none of the picture's names, or none of `index.sound`'s
 *   (the first sound that plays, or the one the user chose, for an MP4 and a
 *   Matroska file alike; never `sounds[0]`, which may be another track): reason
 *   `codec`, and the sentence that names them;
 * - the file has no sound that plays and its first offer is one the reader refused:
 *   that refusal's reason and sentence.
 *
 * A file with no sound track, or whose first sound has no frames (`index.sound`
 * null, `sounds[0]` the next one's offer), plays with no sound.
 */
export function chooseEngineTracks(
  index: SourceIndex,
  isTypeSupported: (mime: string) => boolean,
): ChosenTracks | EngineRefusal {
  const videoMime = firstTaken('video', index.video.codecNames, isTypeSupported)
  if (videoMime === null) return noName(index.video.codecNames)

  const sound = index.sound
  if (sound === null) {
    const offer = index.sounds[0]
    if (offer !== undefined && 'refusal' in offer) {
      return { refusal: offer.refusal.message, reason: offer.refusal.reason }
    }
    const video: EngineTrack = { kind: 'video', mime: videoMime, track: index.video, soundId: null }
    return { video, audio: null }
  }

  const soundMime = firstTaken('audio', sound.codecNames, isTypeSupported)
  if (soundMime === null) return noName(sound.codecNames)
  const soundId = sound.header.id
  return {
    video: { kind: 'video', mime: videoMime, track: index.video, soundId },
    audio: { kind: 'audio', mime: soundMime, track: sound, soundId },
  }
}
