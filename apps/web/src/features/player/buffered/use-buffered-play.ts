import type { TimelineEventInput } from '@dfs/shared'
import { useEffect, useEffectEvent, useState } from 'react'
import { playBuffered, type BufferedStats } from './buffered-player'

/** The stats of one play, with what the play was started with. */
interface PlayStats {
  video: HTMLVideoElement
  url: string
  startAt: number
  stats: BufferedStats
}

/**
 * Runs `playBuffered` on `video` while `enabled` (§10.4). It plays once the
 * source has its metadata if `autoplay`, since setting a source cancels a
 * pending `play()`. It calls `onFailed` when the play fails before any frame
 * showed, so the player can offer another player instead. A new `video`, `url` or
 * `startAt` ends the play and starts another; `autoplay`, `onFailed` and `onEvent`
 * do not. `onEvent` is given what the engine does, for the play's timeline (§16),
 * until the play is over. `stats` is the play's latest numbers, or null before the first.
 */
export function useBufferedPlay(input: {
  video: HTMLVideoElement | null
  url: string
  enabled: boolean
  startAt: number
  autoplay: boolean
  onFailed: (message: string) => void
  onEvent?: (event: TimelineEventInput) => void
}): { stats: BufferedStats | null } {
  const { video, url, enabled, startAt } = input
  const [latest, setLatest] = useState<PlayStats | null>(null)

  // The latest `autoplay`, `onFailed` and `onEvent`, which the play reads when it needs them.
  const shouldPlay = useEffectEvent(() => input.autoplay)
  const failed = useEffectEvent((message: string) => {
    input.onFailed(message)
  })
  const record = useEffectEvent((event: TimelineEventInput) => {
    input.onEvent?.(event)
  })

  useEffect(() => {
    if (!enabled || !video) return
    const controller = new AbortController()
    const { signal } = controller

    // Whether the video has shown a frame, which a failure after it doesn't take back.
    let frameShown = false
    let reported = false
    video.addEventListener(
      'loadeddata',
      () => {
        frameShown = true
      },
      { signal },
    )
    // Setting the source cancels a pending play, so the video plays once it has its metadata.
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (shouldPlay()) void video.play().catch(() => undefined)
      },
      { once: true, signal },
    )

    void playBuffered({
      video,
      url,
      startAt,
      signal,
      // Nothing after the play is over: a read it aborted ends in silence, and a new play's
      // events are not mixed with its.
      onEvent: (event) => {
        if (!signal.aborted) record(event)
      },
      onStats: (stats) => {
        if (signal.aborted) return
        setLatest({ video, url, startAt, stats })
        if (stats.phase !== 'failed' || reported) return
        if (frameShown || video.readyState >= 2) return
        reported = true
        failed(stats.error ?? 'Buffered play failed.')
      },
    }).catch((error: unknown) => {
      // A browser without what the play needs rejects it before it can report a failure itself.
      if (signal.aborted || reported) return
      if (frameShown || video.readyState >= 2) return
      reported = true
      failed(error instanceof Error ? error.message : String(error))
    })

    // Leaving stops the play and lets go of the object URL `playBuffered` gave the element.
    return () => {
      controller.abort()
      if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src)
      video.removeAttribute('src')
      video.load()
      setLatest(null)
    }
  }, [video, url, enabled, startAt])

  // Stats belong to the play that made them: a play that has ended shows none.
  const current =
    enabled &&
    latest !== null &&
    latest.video === video &&
    latest.url === url &&
    latest.startAt === startAt
      ? latest.stats
      : null
  return { stats: current }
}
