// The audio tracks a browser lists of a file it plays (`video.audioTracks`):
// Safari lists a file's sound tracks, and DFS switches between them only in
// Safari's own player, on an iPhone or iPad (DESIGN.md §6.7, §10.4). Through
// the buffer only the first sound track is there, and other browsers play the
// default.

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
