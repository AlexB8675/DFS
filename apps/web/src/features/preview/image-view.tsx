import { Minus, Plus } from 'lucide-react'
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type Ref,
} from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { ViewHandle } from './view-handle'
import { canPan, clampView, fitScale, zoomAt, type Point, type Size, type View } from './zoom'

interface ImageViewProps {
  src: string
  alt: string
  /** An SVG: it grows to fill the screen, since it stays sharp. */
  vector: boolean
  ref?: Ref<ViewHandle>
  /** A swipe on a touch screen: 1 for the next file, -1 for the previous. */
  onSwipe: (direction: 1 | -1) => void
  /** The browser couldn't draw it. */
  onError: () => void
}

/** A swipe is this many pixels across, and more across than down. */
const SWIPE_PX = 50
const DOUBLE_TAP_MS = 300
const STEP = 1.25

interface Gesture {
  /** Where each finger or the mouse is, from the stage's centre. */
  pointers: Map<number, Point>
  /** The view and pointers when the pointers last changed. */
  start: { view: View; points: Point[] } | null
  moved: boolean
  lastTap: { at: number; point: Point } | null
}

/**
 * An image fitted to the screen (§10.3), or at 1:1, zoomed around the
 * pointer by the wheel or a pinch and panned by a drag; double-click or
 * double-tap switches between the two. At fitting size, a swipe moves on.
 */
export function ImageView({ src, alt, vector, ref, onSwipe, onError }: ImageViewProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture>({ pointers: new Map(), start: null, moved: false, lastTap: null })
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const [natural, setNatural] = useState<Size | null>(null)
  /** `null` while it fits the screen, so it keeps fitting as the window changes. */
  const [zoom, setZoom] = useState<View | null>(null)

  // Measured before the first paint, so the image never shows at the wrong
  // scale; then whenever the window changes.
  useLayoutEffect(() => {
    const element = stageRef.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setStage({ width, height })
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  // An SVG with only a viewBox has no size of its own in some browsers: the stage's, then.
  const image = natural && natural.width > 0 && natural.height > 0 ? natural : stage
  const fit = fitScale(image, stage, vector)
  const fitted: View = { scale: fit, x: 0, y: 0 }
  const view = zoom ? clampView(zoom, image, stage) : fitted
  const pannable = canPan(view, image, stage)

  /** Zooms by `factor` around `point`; back near fitting, it fits again. */
  function zoomBy(from: View, factor: number, point: Point): View | null {
    const next = zoomAt(from, factor, point, image, stage, fit)
    return Math.abs(next.scale - fit) < 0.001 ? null : next
  }

  /** Fitting ↔ 1:1 (or twice the fit, for what fits at 1:1 already), around `point`. */
  function toggle(point: Point) {
    if (zoom) {
      setZoom(null)
      return
    }
    const target = fit < 1 ? 1 : fit * 2
    setZoom(zoomBy(fitted, target / fit, point))
  }

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      setZoom(zoomBy(view, STEP, { x: 0, y: 0 }))
    },
    zoomOut: () => {
      setZoom(zoomBy(view, 1 / STEP, { x: 0, y: 0 }))
    },
    reset: () => {
      setZoom(null)
    },
  }))

  // The wheel zooms. React's wheel handlers can't stop the page from zooming
  // with Ctrl (a trackpad's pinch), so this one is added by hand.
  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
      const factor = Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.002))
      const point = fromCentre(element, event)
      setZoom((current) => {
        const next = zoomAt(current ?? fitted, factor, point, image, stage, fit)
        return Math.abs(next.scale - fit) < 0.001 ? null : next
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
    }
  })

  function begin(points: Map<number, Point>, from: View) {
    gesture.current.start = points.size > 0 ? { view: from, points: [...points.values()] } : null
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { pointers } = gesture.current
    pointers.set(event.pointerId, fromCentre(event.currentTarget, event))
    gesture.current.moved = false
    begin(pointers, view)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const { pointers, start } = gesture.current
    if (!pointers.has(event.pointerId) || !start) return
    pointers.set(event.pointerId, fromCentre(event.currentTarget, event))
    const points = [...pointers.values()]
    const [a, b] = points
    const [a0, b0] = start.points
    if (!a || !a0) return
    if (b && b0) {
      // A pinch: zoom around where the fingers began, then follow them.
      const from = midpoint(a0, b0)
      const to = midpoint(a, b)
      const zoomed = zoomAt(start.view, distance(a, b) / distance(a0, b0), from, image, stage, fit)
      setZoom(
        clampView(
          { ...zoomed, x: zoomed.x + to.x - from.x, y: zoomed.y + to.y - from.y },
          image,
          stage,
        ),
      )
      gesture.current.moved = true
      return
    }
    const dx = a.x - a0.x
    const dy = a.y - a0.y
    if (Math.abs(dx) + Math.abs(dy) > 4) gesture.current.moved = true
    if (canPan(start.view, image, stage)) {
      setZoom(
        clampView({ ...start.view, x: start.view.x + dx, y: start.view.y + dy }, image, stage),
      )
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const { pointers, start, moved } = gesture.current
    const point = pointers.get(event.pointerId)
    if (!point) return
    pointers.delete(event.pointerId)
    const single = start?.points.length === 1 ? start.points[0] : undefined
    if (single && event.pointerType !== 'mouse' && !canPan(start?.view ?? view, image, stage)) {
      const dx = point.x - single.x
      const dy = point.y - single.y
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        onSwipe(dx < 0 ? 1 : -1)
      }
    }
    // A double tap: the mouse has double-click instead.
    if (single && !moved && event.pointerType === 'touch') {
      const { lastTap } = gesture.current
      const now = event.timeStamp
      if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && distance(lastTap.point, point) < 30) {
        gesture.current.lastTap = null
        toggle(point)
      } else {
        gesture.current.lastTap = { at: now, point }
      }
    }
    begin(pointers, view)
  }

  const percent = Math.round(view.scale * 100)
  return (
    <div className="relative size-full">
      <div
        ref={stageRef}
        className={cn(
          'absolute inset-0 touch-none overflow-hidden select-none',
          pannable ? 'cursor-grab active:cursor-grabbing' : fit < 1 && 'cursor-zoom-in',
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={(event) => {
          toggle(fromCentre(event.currentTarget, event))
        }}
      >
        {!natural && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Spinner className="size-6" />
          </div>
        )}
        <img
          src={src}
          alt={alt}
          draggable={false}
          decoding="async"
          className={cn(
            'absolute top-1/2 left-1/2 max-w-none object-contain',
            !natural && 'opacity-0',
          )}
          style={{
            width: image.width * view.scale,
            height: image.height * view.scale,
            transform: `translate(calc(-50% + ${String(view.x)}px), calc(-50% + ${String(view.y)}px))`,
          }}
          onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget
            setNatural({ width, height })
          }}
          onError={onError}
        />
      </div>
      {natural && (
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-xl bg-background/80 p-1 shadow-lg ring-1 ring-foreground/10 backdrop-blur-sm max-sm:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            disabled={view.scale <= Math.min(fit, 1) + 0.001}
            onClick={() => {
              setZoom(zoomBy(view, 1 / STEP, { x: 0, y: 0 }))
            }}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-16 tabular-nums"
            aria-label={zoom ? 'Fit to screen' : 'Actual size'}
            title={zoom ? 'Fit to screen' : 'Actual size'}
            onClick={() => {
              toggle({ x: 0, y: 0 })
            }}
          >
            {percent}%
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            onClick={() => {
              setZoom(zoomBy(view, STEP, { x: 0, y: 0 }))
            }}
          >
            <Plus />
          </Button>
        </div>
      )}
    </div>
  )
}

function fromCentre(element: Element, event: { clientX: number; clientY: number }): Point {
  const rect = element.getBoundingClientRect()
  return {
    x: event.clientX - rect.left - rect.width / 2,
    y: event.clientY - rect.top - rect.height / 2,
  }
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
