import { playStreamed, type EngineStats } from '@dfs/player/page'
import type { TimelineEventInput } from '@dfs/shared'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { makeStoreWorker } from '../play-store'
import { afterPrevious } from './after-previous'
import { LastStats } from './last-stats'
import { failureOf, type PlayFailure } from './play-failure'

/** The stats of one play, with what the play was started with. */
interface PlayStats {
  video: HTMLVideoElement
  url: string
  startAt: number
  stats: EngineStats
}

/**
 * Plays `url` on `video` through the streaming engine while `enabled` and the play has its
 * `playId` (§10.4). The engine plays by `autoplay()`, which it reads each time it would start or
 * resume play, and it pauses the element itself while it holds for the network. It calls
 * `onFailed` when the play fails before any frame showed, so the player can offer another player
 * instead; a failure after the first frame is in the stats (`phase: 'failed'`). A new `video`,
 * `url`, `playId` or `startAt` ends the play and starts another; `autoplay`, `onFailed` and
 * `onEvent` do not. `onEvent` is given what the engine does, for the play's timeline (§16), until
 * the play is over. `stats` is the play's latest numbers, or null before the first. `latestStats`
 * gives the same numbers at once, as the engine sent them, and keeps them when the play's own
 * failure ends it, until another play starts (§10.4): a handler of that failure, a toggle and the
 * report read it, as `stats` follows a render behind and is null once the play is over.
 */
export function useBufferedPlay(input: {
  video: HTMLVideoElement | null
  url: string
  playId: string | null
  enabled: boolean
  startAt: number
  autoplay: () => boolean
  onFailed: (failure: PlayFailure) => void
  onEvent?: (event: TimelineEventInput) => void
}): { stats: EngineStats | null; latestStats: () => EngineStats | null } {
  const { video, url, playId, enabled, startAt } = input
  const [latest, setLatest] = useState<PlayStats | null>(null)
  // The previous play's end, which a new one on the element waits for (it never rejects).
  const previous = useRef<Promise<void>>(Promise.resolve())
  const last = useRef(new LastStats<EngineStats>())
  const latestStats = useCallback(() => last.current.get(), [])

  // The latest `autoplay`, `onFailed` and `onEvent`, which the play reads when it needs them.
  const wantsPlay = useEffectEvent(() => input.autoplay())
  const failed = useEffectEvent((failure: PlayFailure) => {
    input.onFailed(failure)
  })
  const record = useEffectEvent((event: TimelineEventInput) => {
    input.onEvent?.(event)
  })

  useEffect(() => {
    if (!enabled || !video || !playId) return
    const controller = new AbortController()
    const { signal } = controller
    const setLast = last.current.start()

    // A play that is closing would clear the source of the one that follows it on the element,
    // so the new play starts when the old one has settled (§10.4).
    previous.current = afterPrevious(previous.current, signal, () =>
      playStreamed({
        video,
        url,
        playId,
        makeWorker: makeStoreWorker,
        signal,
        startAt,
        autoplay: () => wantsPlay(),
        // Nothing after the play is over: a read it aborted ends in silence, and a new play's
        // events are not mixed with its.
        onEvent: (event) => {
          if (!signal.aborted) record(event)
        },
        onStats: (stats) => {
          if (signal.aborted) return
          setLast(stats)
          setLatest({ video, url, startAt, stats })
        },
      }).catch((error: unknown) => {
        // It rejects only before the first frame, and a viewer who leaves is no failure.
        if (!signal.aborted) failed(failureOf(error))
      }),
    )

    // Leaving stops the play (the engine closes its store) and lets go of a `blob:` source.
    return () => {
      controller.abort()
      if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src)
      video.removeAttribute('src')
      video.load()
      setLatest(null)
    }
  }, [video, url, playId, enabled, startAt])

  // Stats belong to the play that made them: a play that has ended shows none.
  const current =
    enabled &&
    latest !== null &&
    latest.video === video &&
    latest.url === url &&
    latest.startAt === startAt
      ? latest.stats
      : null
  return { stats: current, latestStats }
}
