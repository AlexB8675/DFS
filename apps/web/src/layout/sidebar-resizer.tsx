import { useRef, type PointerEvent } from 'react'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, usePreferences } from '@/lib/preferences'

const KEYBOARD_STEP = 16

/** A drag handle on the sidebar's edge. Also works with the arrow keys. */
export function SidebarResizer() {
  const width = usePreferences((state) => state.sidebarWidth)
  const setWidth = usePreferences((state) => state.setSidebarWidth)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    setWidth(drag.current.startWidth + event.clientX - drag.current.startX)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-primary/60 focus-visible:after:bg-primary"
      onPointerDown={(event) => {
        drag.current = { startX: event.clientX, startWidth: width }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={() => {
        drag.current = null
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') setWidth(width - KEYBOARD_STEP)
        if (event.key === 'ArrowRight') setWidth(width + KEYBOARD_STEP)
      }}
    />
  )
}
