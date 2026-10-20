import { useEffect, useState } from 'react'
import { currentDevice } from '../external-players'
import { Timeline, timelineSender } from './recorder'
import { connectionNow } from './watch-element'

/**
 * The timeline of the video the viewer is looking at (§10.4, §16), or `null`
 * where there is none: `base` is the file's path (`/files/:id`, or a link's)
 * and `fileId` the file, both `null` while what is shown isn't a video. The
 * play's clock starts when the viewer begins showing the file, before the
 * video's code loads, so the first answers and the decision where it plays are
 * on it; the timeline closes, with its last batch, when the viewer moves on or
 * closes. One timeline for each file shown: a retry, a new version or a restart
 * is an event in the same play, not another play. The batch goes with
 * `keepalive` as the page hides or leaves.
 */
export function usePlayTimeline(base: string | null, fileId: string | null): Timeline | null {
  const [made, setMade] = useState<{ base: string; fileId: string; timeline: Timeline } | null>(
    null,
  )

  useEffect(() => {
    // `fileId` names the play: the same path with another file is another play.
    if (base === null || fileId === null) return
    const timeline = new Timeline({ playId: crypto.randomUUID(), send: timelineSender(base) })
    timeline.record({
      type: 'opened',
      device: currentDevice(),
      visible: document.visibilityState === 'visible',
      online: navigator.onLine,
      connection: connectionNow(),
    })
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void timeline.flush({ keepalive: true })
    }
    const onLeave = () => {
      void timeline.flush({ keepalive: true })
    }
    // On the window, which `visibilitychange` reaches after the document: the element's own
    // `visibility` event is kept first, and goes in this batch.
    window.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onLeave)
    // The timeline is an external resource this effect opens and closes, which the view reads.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing it is the point
    setMade({ base, fileId, timeline })
    return () => {
      window.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onLeave)
      timeline.close()
      setMade(null)
    }
  }, [base, fileId])

  // Only the timeline of this file: in the render that moves to another, the last one is not it.
  return made !== null && made.base === base && made.fileId === fileId ? made.timeline : null
}
