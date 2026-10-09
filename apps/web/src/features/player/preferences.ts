import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// What the players keep in the browser (DESIGN.md §10.4): the volume and
// mute, the same for every video.

interface PlayerPreferences {
  volume: number
  muted: boolean
  setVolume: (volume: number, muted: boolean) => void
}

export const usePlayerPreferences = create<PlayerPreferences>()(
  persist(
    (set) => ({
      volume: 1,
      muted: false,
      setVolume: (volume, muted) => {
        set({ volume: Math.min(1, Math.max(0, volume)), muted })
      },
    }),
    { name: 'dfs.player', version: 1 },
  ),
)
