// The audio tracks a browser lists of a file it plays (`video.audioTracks`):
// Safari's, in direct play (DESIGN.md §6.7). Other browsers play the default.

export interface AudioTrack {
  id: string
  label: string
  language: string
  enabled: boolean
}

export interface AudioTrackList {
  readonly length: number
  [index: number]: AudioTrack | undefined
}

/** The element's audio tracks, where the browser lists them. */
export function audioTracksOf(video: HTMLVideoElement): AudioTrack[] | null {
  const list = (video as unknown as { audioTracks?: AudioTrackList }).audioTracks
  if (!list) return null
  return Array.from({ length: list.length }, (_, i) => list[i]).filter(
    (track): track is AudioTrack => track !== undefined,
  )
}

/** Plays the track with this ID, and no other. */
export function chooseAudioTrack(video: HTMLVideoElement, id: string): void {
  for (const track of audioTracksOf(video) ?? []) track.enabled = track.id === id
}
