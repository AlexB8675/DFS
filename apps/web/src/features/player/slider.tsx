import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// The player's sliders, the seek bar and the volume: dragged with any
// pointer, and given values by the player's keys rather than their own, so
// a key does the same wherever the focus is (§10.4).

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
  className,
}: SliderProps) {
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
          'relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-[height] group-hover/slider:h-1.5',
          dragging && 'h-1.5',
        )}
      >
        {under}
        <div
          className="absolute inset-y-0 left-0 bg-white"
          style={{ width: `${String(value * 100)}%` }}
        />
      </div>
      <div
        className={cn(
          'pointer-events-none absolute size-3 -translate-x-1/2 rounded-full bg-white shadow transition-transform',
          dragging
            ? 'scale-125'
            : 'scale-0 group-hover/slider:scale-100 group-focus-visible/slider:scale-100',
        )}
        style={{ left: `${String(value * 100)}%` }}
      />
    </div>
  )
}
