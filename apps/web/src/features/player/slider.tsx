import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// The player's sliders, the seek bar and the volume: dragged with any
// pointer, and moved by the arrow keys, Page Up and Down, Home and End while
// focused, which the player's own keys then leave alone (§10.4).

interface SliderProps {
  /** From 0 to 1. */
  value: number
  label: string
  /** What a screen reader says the value is: “12:34 of 1:45:00”. */
  valueText: string
  /** While dragging, with each move. */
  onChange: (value: number) => void
  /** Once let go. */
  onCommit?: (value: number) => void
  /** Under the pointer, for a time or a chapter above it; `null` when it leaves. */
  onHover?: (value: number | null) => void
  /** Drawn under the played part: what has loaded, say. */
  under?: ReactNode
  /** Gaps in the bar, from 0 to 1: where chapters start. */
  marks?: readonly number[]
  /** An arrow key's move, from 0 to 1: the seek bar's 5 s, the volume's 5%. */
  step: number
  /** White over a picture; the theme's colours in the audio bar. */
  tone?: 'picture' | 'theme'
  className?: string
}

export function Slider({
  value,
  label,
  valueText,
  onChange,
  onCommit,
  onHover,
  under,
  marks = [],
  step,
  tone = 'picture',
  className,
}: SliderProps) {
  const theme = tone === 'theme'
  const track = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  function at(event: PointerEvent<HTMLDivElement>): number {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  }

  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={valueText}
      tabIndex={0}
      className={cn(
        'group/slider relative flex h-5 cursor-pointer touch-none items-center',
        className,
      )}
      onKeyDown={(event) => {
        // Shift+← and → move between files, as everywhere in the viewer.
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        const moves: Record<string, number> = {
          ArrowLeft: -step,
          ArrowDown: -step,
          ArrowRight: step,
          ArrowUp: step,
          PageDown: -10 * step,
          PageUp: 10 * step,
          Home: -1,
          End: 1,
        }
        const move = moves[event.key]
        if (move === undefined) return
        event.preventDefault()
        event.stopPropagation()
        const next = Math.min(1, Math.max(0, value + move))
        onChange(next)
        onCommit?.(next)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        onChange(at(event))
      }}
      onPointerMove={(event) => {
        if (dragging) onChange(at(event))
        if (event.pointerType === 'mouse' || dragging) onHover?.(at(event))
      }}
      onPointerUp={(event) => {
        if (!dragging) return
        setDragging(false)
        onCommit?.(at(event))
        if (event.pointerType !== 'mouse') onHover?.(null)
      }}
      onPointerCancel={() => {
        setDragging(false)
        onHover?.(null)
      }}
      onPointerLeave={(event) => {
        if (!dragging && event.pointerType === 'mouse') onHover?.(null)
      }}
    >
      <div
        ref={track}
        className={cn(
          'relative h-1 w-full overflow-hidden rounded-full transition-[height] group-hover/slider:h-1.5',
          theme ? 'bg-foreground/15' : 'bg-white/25',
          dragging && 'h-1.5',
        )}
      >
        {under}
        <div
          className={cn('absolute inset-y-0 left-0', theme ? 'bg-foreground' : 'bg-white')}
          style={{ width: `${String(value * 100)}%` }}
        />
        {marks.map((mark) => (
          <div
            key={mark}
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-black/80"
            style={{ left: `${String(mark * 100)}%` }}
          />
        ))}
      </div>
      <div
        className={cn(
          'pointer-events-none absolute size-3 -translate-x-1/2 rounded-full shadow transition-transform',
          theme ? 'bg-foreground' : 'bg-white',
          dragging
            ? 'scale-125'
            : 'scale-0 group-hover/slider:scale-100 group-focus-visible/slider:scale-100',
        )}
        style={{ left: `${String(value * 100)}%` }}
      />
    </div>
  )
}
