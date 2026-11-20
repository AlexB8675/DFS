// The tracks that play, and the names Media Source is asked for them (DESIGN.md
// §10.4). The index says which picture and which sound a file has (`@dfs/mp4`'s
// `SourceIndex`, an MP4's or a Matroska file's alike); this module asks the
// browser, through a function the caller gives, which of each track's names its
// Media Source takes. It uses no DOM type: `isTypeSupported` is
// `MediaSource.isTypeSupported` in the page and a fake in a test.

import type { MatroskaPlayTrack, PlayTrack, SourceIndex } from '@dfs/mp4'

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

/** What is chosen: the picture, the sound when one plays, and why none does when the file has one that the browser can't take. */
export interface ChosenTracks {
  video: EngineTrack
  audio: EngineTrack | null
  /** The sentence that says the sound is not played because Media Source takes none of its names; null otherwise (no sound in the file, or the sound plays). */
  soundNote: string | null
}

/** The sentence for a track whose names Media Source takes none of. */
function refusalFor(names: readonly string[]): string {
  return `This browser's Media Source takes none of ${names.join(', ')}`
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
 * Chooses the picture and the sound that play. The picture is the index's; no name of
 * it taken is a refusal. The sound is the index's `sound` (the first that plays, or
 * the one the user chose, for an MP4 and a Matroska file alike); none taken leaves
 * the play without sound, and says why in `soundNote` for the timeline. A file
 * with no sound that plays has none, and no note.
 */
export function chooseEngineTracks(
  index: SourceIndex,
  isTypeSupported: (mime: string) => boolean,
): ChosenTracks | { refusal: string } {
  const videoMime = firstTaken('video', index.video.codecNames, isTypeSupported)
  if (videoMime === null) return { refusal: refusalFor(index.video.codecNames) }

  const sound = index.sound
  const soundMime = sound === null ? null : firstTaken('audio', sound.codecNames, isTypeSupported)
  const soundId = sound !== null && soundMime !== null ? sound.header.id : null

  const video: EngineTrack = { kind: 'video', mime: videoMime, track: index.video, soundId }
  if (sound === null) return { video, audio: null, soundNote: null }
  if (soundMime === null) {
    return { video, audio: null, soundNote: refusalFor(sound.codecNames) }
  }
  return {
    video,
    audio: { kind: 'audio', mime: soundMime, track: sound, soundId },
    soundNote: null,
  }
}
