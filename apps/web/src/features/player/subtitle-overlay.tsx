import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

// Subtitles drawn by the player (DESIGN.md §10.4), above its controls when
// they show, rather than by the browser, which would put them under them.
// The track is WebVTT the API made: `getCueAsHTML` gives its text, italics
// and bold as elements, and nothing that runs.

interface SubtitleOverlayProps {
  /** The chosen track, loaded as `hidden`; `null` for none. */
  track: TextTrack | null
  /** The controls show: the subtitles move up out of their way. */
  raised: boolean
}

interface Shown {
  /** The cues at the top (`line:0`, an ASS `\an8`), and the rest. */
  top: DocumentFragment[]
  bottom: DocumentFragment[]
}

export function SubtitleOverlay({ track, raised }: SubtitleOverlayProps) {
  const [shown, setShown] = useState<Shown>({ top: [], bottom: [] })

  useEffect(() => {
    if (!track) return
    const update = () => {
      const next: Shown = { top: [], bottom: [] }
      for (const cue of Array.from(track.activeCues ?? [])) {
        if (!(cue instanceof VTTCue)) continue
        ;(cue.line === 0 ? next.top : next.bottom).push(cue.getCueAsHTML())
      }
      setShown(next)
    }
    track.addEventListener('cuechange', update)
    update()
    return () => {
      track.removeEventListener('cuechange', update)
      setShown({ top: [], bottom: [] })
    }
  }, [track])

  return (
    <>
      <Cues cues={shown.top} className="top-[6%]" />
      <Cues
        cues={shown.bottom}
        className={cn('transition-[bottom] duration-200', raised ? 'bottom-24' : 'bottom-[6%]')}
      />
    </>
  )
}

function Cues({ cues, className }: { cues: DocumentFragment[]; className: string }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Copies: a fragment empties into the first place it is put.
    box.current?.replaceChildren(
      ...cues.map((cue) => {
        const line = document.createElement('span')
        line.className =
          'inline-block rounded bg-black/70 px-[0.4em] py-[0.1em] whitespace-pre-line'
        line.append(cue.cloneNode(true))
        return line
      }),
    )
  }, [cues])
  return (
    <div
      ref={box}
      aria-live="off"
      className={cn(
        'pointer-events-none absolute inset-x-[5%] flex flex-col items-center gap-1 text-center text-[clamp(14px,2.8cqw,44px)] leading-snug text-white [&_i]:italic [&_b]:font-bold [&_u]:underline',
        cues.length === 0 && 'hidden',
        className,
      )}
    />
  )
}
