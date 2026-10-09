import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { EMPTY_QUEUE, type Queue } from './queue'

// What the audio bar keeps (DESIGN.md §10.4): its queue, shuffle, repeat
// and speed, in the browser, so they come back after a reload, with the
// user whose drive the queue's files are from; and, for this page only,
// why the track can't play and the offer to resume it. Where the track has
// got to is kept apart (`engine.ts`), as it changes every few seconds.

export type Repeat = 'off' | 'all' | 'one'

/** Why the track playing stopped, with what the bar offers. */
export interface AudioProblem {
  /** The queue entry it is about. */
  key: string
  message: string
  /** `download`: its codec; `retry`: a read failed; `none`: it is gone. */
  offer: 'download' | 'retry' | 'none'
}

interface AudioState {
  queue: Queue
  shuffle: boolean
  repeat: Repeat
  /** 0.5 to 3. */
  speed: number
  /** The user whose drive the queue's drive files are from; another signing in doesn't get them. */
  ownerId: string | null
  /** The queue entry the element holds; `null` until one is loaded, as after a reload. */
  loaded: string | null
  problem: AudioProblem | null
  /** Where the track stopped last time, in seconds, offered until resumed or played past. */
  resume: { key: string; seconds: number } | null
  /** On a computer, the queue's panel; on a phone, the full view. */
  panel: 'queue' | 'full' | null
}

export const useAudioStore = create<AudioState>()(
  persist(
    (): AudioState => ({
      queue: EMPTY_QUEUE,
      shuffle: false,
      repeat: 'off',
      speed: 1,
      ownerId: null,
      loaded: null,
      problem: null,
      resume: null,
      panel: null,
    }),
    {
      name: 'dfs.audio',
      version: 1,
      partialize: ({ queue, shuffle, repeat, speed, ownerId }) => ({
        queue,
        shuffle,
        repeat,
        speed,
        ownerId,
      }),
    },
  ),
)
