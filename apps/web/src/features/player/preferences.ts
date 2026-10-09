import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SubtitlePreference } from './subtitle-options'

// What the players keep in the browser (DESIGN.md §10.4): the volume and
// mute, the same for every video, and whether subtitles were on, in which
// language, for the next video.

interface PlayerPreferences {
  volume: number
  muted: boolean
  subtitles: SubtitlePreference
  setVolume: (volume: number, muted: boolean) => void
  setSubtitles: (subtitles: SubtitlePreference) => void
}

export const usePlayerPreferences = create<PlayerPreferences>()(
  persist(
    (set) => ({
      volume: 1,
      muted: false,
      subtitles: { on: false, language: null },
      setVolume: (volume, muted) => {
        set({ volume: Math.min(1, Math.max(0, volume)), muted })
      },
      setSubtitles: (subtitles) => {
        set({ subtitles })
      },
    }),
    { name: 'dfs.player', version: 1 },
  ),
)
