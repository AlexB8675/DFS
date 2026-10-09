import { useEffect, useRef } from 'react'
import { apiFetch } from '@/lib/api/client'

// Where a user stopped a video, kept on the server (DESIGN.md §10.4): every
// 10 s while it plays, on pause, and on leaving it (the viewer closing or
// moving on, the page hidden), the last with `keepalive` so it outlives the
// page. The first 10 s aren't kept, and finishing it (the last 5%) clears it.

const EVERY_MS = 10_000
/** Less than this in isn't worth coming back to. */
export const RESUME_FROM_MS = 10_000
/** Past this share of it, it is finished. */
export const FINISHED_AT = 0.95

interface ResumeOptions {
  /** The file's path: `/files/:id`. */
  base: string
  video: HTMLVideoElement | null
  versionId: string | null
  /** Where the server says the user stopped, for knowing whether there is one to clear. */
  savedMs: number | null
}

/** Keeps the position as it plays; `startOver` clears it, once the player is back at the start. */
export function useResume({ base, video, versionId, savedMs }: ResumeOptions): {
  startOver: () => void
} {
  /**
   * What the server holds now, as far as this player knows: what
   * /playback said, until this player saves or clears it.
   */
  const saved = useRef<number | null | undefined>(undefined)

  useEffect(() => {
    if (!video || !versionId) return
    if (saved.current === undefined) saved.current = savedMs
    const save = (keepalive = false) => {
      // Before it has played, its time says nothing yet: leaving then keeps what was saved.
      if (video.played.length === 0) return
      const ms = Math.round(video.currentTime * 1000)
      const duration = video.duration
      const finished =
        video.ended ||
        (Number.isFinite(duration) && duration > 0 && ms >= duration * 1000 * FINISHED_AT)
      if (finished || ms < RESUME_FROM_MS) {
        if (saved.current === null) return
        saved.current = null
        void apiFetch(`${base}/position`, { method: 'DELETE', keepalive }).catch(() => undefined)
        return
      }
      if (typeof saved.current === 'number' && Math.abs(saved.current - ms) < 1000) return
      saved.current = ms
      void apiFetch(`${base}/position`, {
        method: 'PUT',
        json: { versionId, positionMs: ms },
        keepalive,
      }).catch(() => undefined)
    }
    const onStop = () => {
      save()
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') save(true)
    }
    const onPageHide = () => {
      save(true)
    }
    const timer = window.setInterval(() => {
      if (!video.paused) save()
    }, EVERY_MS)
    video.addEventListener('pause', onStop)
    video.addEventListener('ended', onStop)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.clearInterval(timer)
      video.removeEventListener('pause', onStop)
      video.removeEventListener('ended', onStop)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      save(true)
    }
  }, [base, savedMs, video, versionId])

  return {
    startOver: () => {
      saved.current = null
      void apiFetch(`${base}/position`, { method: 'DELETE' }).catch(() => undefined)
    },
  }
}
