import { useEffect, useRef } from 'react'
import { apiFetch } from '@/lib/api/client'
import type { FilePlace } from '@/lib/file-place'
import { useLinkPositions } from './link-positions'
import { positionChange } from './resume-rules'

// Where a viewer stopped a video (DESIGN.md §10.4): on the server for a
// drive's file, and in the browser for a link's (`link-positions.ts`). Kept
// every 10 s while it plays, on pause, and on leaving it (the viewer closing
// or moving on, the page hidden), the last with `keepalive` so it outlives
// the page. Every video starts at the beginning: while the offer to resume
// stands, the position it offers is kept, unless the video is finished.
// Otherwise the first 10 s aren't kept, and finishing it (the last 5%)
// clears it (`resume-rules.ts`).

const EVERY_MS = 10_000

interface ResumeOptions {
  place: FilePlace
  /** A video, or the audio bar's element. */
  video: HTMLMediaElement | null
  versionId: string | null
  /** Where the viewer stopped as /playback said, for knowing whether there is one to clear. */
  savedMs: number | null
  /** The offer to resume it stands: what it offers stays kept. */
  offering: boolean
}

/** Keeps the position as it plays. */
export function useResume({ place, video, versionId, savedMs, offering }: ResumeOptions): void {
  /**
   * What is kept now, as far as this player knows: what /playback said,
   * until this player saves or clears it.
   */
  const saved = useRef<number | null | undefined>(undefined)
  /** `offering`, for saves made after the effect began: on pause, on leaving. */
  const holding = useRef(offering)
  useEffect(() => {
    holding.current = offering
  }, [offering])
  // The strings, not the place: a viewer may build its place anew each time it draws.
  const { path, token } = place

  useEffect(() => {
    if (!video || !versionId) return
    const at = { path, token }
    if (saved.current === undefined) saved.current = savedMs
    const save = (keepalive = false) => {
      // Before it has played, its time says nothing yet: leaving then keeps what was saved.
      if (video.played.length === 0) return
      const ms = Math.round(video.currentTime * 1000)
      const change = positionChange(ms, video.duration * 1000, video.ended)
      if (change === 'none' || (change === 'keep' && holding.current)) return
      if (change === 'clear') {
        if (saved.current === null) return
        saved.current = null
        clearPosition(at, keepalive)
        return
      }
      if (typeof saved.current === 'number' && Math.abs(saved.current - ms) < 1000) return
      saved.current = ms
      savePosition(at, versionId, ms, keepalive)
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
  }, [path, savedMs, token, video, versionId])
}

/** Keeps where the viewer stopped, in the version they played. */
function savePosition(place: FilePlace, versionId: string, positionMs: number, keepalive: boolean) {
  if (place.token !== null) {
    useLinkPositions.getState().keep(place.path, versionId, positionMs)
    return
  }
  void apiFetch(`${place.path}/position`, {
    method: 'PUT',
    json: { versionId, positionMs },
    keepalive,
  }).catch(() => undefined)
}

function clearPosition(place: FilePlace, keepalive: boolean) {
  if (place.token !== null) {
    useLinkPositions.getState().forget(place.path)
    return
  }
  void apiFetch(`${place.path}/position`, { method: 'DELETE', keepalive }).catch(() => undefined)
}
