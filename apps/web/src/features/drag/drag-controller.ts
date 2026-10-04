import type { DriveNode } from '@dfs/shared'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTreeStore } from '@/features/tree/tree-store'
import { MOTION_MS, prefersReducedMotion, themeEasing } from '@/lib/motion'
import { canDrop, scopesOf } from './can-drop'
import { useDragStore } from './drag-store'

// Drag-to-move with the pointer, built for speed: while dragging, nothing
// goes through React except the hovered target changing. One
// requestAnimationFrame loop moves the floating preview with a transform,
// finds the folder under the pointer, and scrolls lists near their edges.
//
// Mouse and pen only: on touch, dragging would fight scrolling, and the Move
// dialog covers touch and keyboard users.

/** How far the pointer moves before a press becomes a drag. */
const THRESHOLD_PX = 5
/** Resting on a folder this long makes it blink, then it springs open. */
const SPRING_BLINK_MS = 700
const SPRING_OPEN_MS = 1150
/** Lists scroll when the pointer is this close to their top or bottom edge. */
const EDGE_PX = 56
const MAX_SCROLL_PX_PER_FRAME = 18

export interface DropTarget {
  id: string
  name: string
}

interface DragHandlers {
  drop: (nodes: readonly DriveNode[], target: DropTarget) => void
  /** Spring-loading: opens a folder mid-drag. */
  open: (folderId: string) => void
}

interface Drag {
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  getNodes: () => DriveNode[]
  /** Where the dragged item was, so a cancelled drag can fly back to it. */
  origin: DOMRect
  started: boolean
  nodes: DriveNode[]
  frame: number
  springTimers: number[]
}

let handlers: DragHandlers | null = null
let overlay: HTMLElement | null = null
let drag: Drag | null = null
/** Bumped per drag, so a finishing animation doesn't clear a newer drag. */
let generation = 0

/** Connects the controller to the app (moving, navigating). Returns an unregister function. */
export function registerDragHandlers(next: DragHandlers): () => void {
  handlers = next
  return () => {
    if (handlers === next) handlers = null
  }
}

/** Ref callback for the floating preview (see DragLayer). */
export function registerOverlay(element: HTMLElement | null): void {
  overlay = element
  if (element && drag) place(drag)
}

/**
 * Call from `onPointerDown` of something draggable. Nothing happens until the
 * pointer moves past a small threshold, so clicks and double-clicks work as
 * before. `getNodes` runs when the drag starts and says what is dragged.
 */
export function beginPointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  getNodes: () => DriveNode[],
): void {
  if (drag || event.button !== 0) return
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    getNodes,
    origin: event.currentTarget.getBoundingClientRect(),
    started: false,
    nodes: [],
    frame: 0,
    springTimers: [],
  }
  // On the window, not the element: the row can unmount mid-drag when the
  // list scrolls or a folder springs open.
  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('blur', cancel)
  window.addEventListener('keydown', handleKey, true)
}

function handleMove(event: PointerEvent): void {
  if (drag?.pointerId !== event.pointerId) return
  // The button was released outside the window, where no pointerup arrives.
  if (event.buttons === 0) {
    finish(false)
    return
  }
  drag.x = event.clientX
  drag.y = event.clientY
  if (!drag.started) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < THRESHOLD_PX) return
    start(drag)
  }
}

function handleUp(event: PointerEvent): void {
  if (drag?.pointerId !== event.pointerId) return
  drag.x = event.clientX
  drag.y = event.clientY
  finish(true)
}

function handleKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !drag?.started) return
  event.preventDefault()
  event.stopPropagation()
  finish(false)
}

function cancel(): void {
  finish(false)
}

function start(current: Drag): void {
  const nodes = current.getNodes()
  if (nodes.length === 0) {
    stopListening()
    drag = null
    return
  }
  generation += 1
  current.started = true
  current.nodes = nodes
  document.documentElement.dataset.dragging = ''
  window.getSelection()?.removeAllRanges()
  overlayCard()
    ?.getAnimations()
    .forEach((animation) => {
      animation.cancel()
    })
  useDragStore.setState({
    nodes,
    ids: new Set(nodes.map((node) => node.id)),
    overId: null,
    overName: null,
    springId: null,
  })
  tick()
}

function tick(): void {
  if (!drag?.started) return
  place(drag)
  const under = document.elementFromPoint(drag.x, drag.y)
  updateTarget(drag, under)
  autoScroll(drag, under)
  drag.frame = requestAnimationFrame(tick)
}

function place(current: Drag): void {
  if (overlay) overlay.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`
}

/** The folder under `under` that would accept the dragged nodes, if any. */
function findTarget(current: Drag, under: Element | null): HTMLElement | null {
  const candidate = under?.closest<HTMLElement>('[data-drop-folder-id]') ?? null
  const id = candidate?.dataset.dropFolderId
  return candidate && id && canDrop(current.nodes, id, scopesOf(candidate)) ? candidate : null
}

function updateTarget(current: Drag, under: Element | null): void {
  const target = findTarget(current, under)

  const targetId = target?.dataset.dropFolderId ?? null
  // Rows remount while scrolling, so compare folder IDs, not elements.
  if (targetId === useDragStore.getState().overId) return
  clearSpring(current)
  useDragStore.setState({
    overId: targetId,
    overName: target?.dataset.dropFolderName ?? null,
    springId: null,
  })
  if (target && targetId) scheduleSpring(current, targetId, target.dataset.dropSpring)
}

function scheduleSpring(current: Drag, folderId: string, mode: string | undefined): void {
  if (mode !== 'open' && mode !== 'expand') return
  current.springTimers.push(
    window.setTimeout(() => {
      useDragStore.setState({ springId: folderId })
    }, SPRING_BLINK_MS),
    window.setTimeout(() => {
      useDragStore.setState({ springId: null })
      if (mode === 'expand') useTreeStore.getState().expand([folderId])
      else handlers?.open(folderId)
    }, SPRING_OPEN_MS),
  )
}

function clearSpring(current: Drag): void {
  current.springTimers.forEach((timer) => {
    window.clearTimeout(timer)
  })
  current.springTimers = []
}

function autoScroll(current: Drag, under: Element | null): void {
  const scroller = under?.closest<HTMLElement>('[data-drag-scroll]')
  if (!scroller) return
  const rect = scroller.getBoundingClientRect()
  const fromTop = current.y - rect.top
  const fromBottom = rect.bottom - current.y
  const speed =
    fromTop < EDGE_PX
      ? -(1 - fromTop / EDGE_PX)
      : fromBottom < EDGE_PX
        ? 1 - fromBottom / EDGE_PX
        : 0
  if (speed !== 0) scroller.scrollTop += speed * MAX_SCROLL_PX_PER_FRAME
}

function finish(drop: boolean): void {
  const current = drag
  if (!current) return
  drag = null
  stopListening()
  cancelAnimationFrame(current.frame)
  clearSpring(current)
  if (!current.started) return

  delete document.documentElement.dataset.dragging
  swallowNextClick()
  // Where the button came up decides, even if no frame ran since the last move.
  const target = drop ? findTarget(current, document.elementFromPoint(current.x, current.y)) : null
  const id = target?.dataset.dropFolderId
  if (target && id && handlers) {
    handlers.drop(current.nodes, { id, name: target.dataset.dropFolderName ?? 'folder' })
    flyTo(target.getBoundingClientRect(), 'into')
  } else {
    flyTo(current.origin, 'back')
  }
}

function stopListening(): void {
  window.removeEventListener('pointermove', handleMove)
  window.removeEventListener('pointerup', handleUp)
  window.removeEventListener('pointercancel', cancel)
  window.removeEventListener('blur', cancel)
  window.removeEventListener('keydown', handleKey, true)
}

/**
 * The preview leaves with a little flourish: it shrinks into the folder it
 * was dropped on, or floats back to where it came from when the drag is
 * cancelled. Then the drag state clears.
 */
function flyTo(rect: DOMRect, mode: 'into' | 'back'): void {
  const card = overlayCard()
  const finished = generation
  const clear = () => {
    if (finished === generation) {
      useDragStore.setState({
        nodes: [],
        ids: new Set(),
        overId: null,
        overName: null,
        springId: null,
      })
    }
  }
  if (!card || prefersReducedMotion()) {
    clear()
    return
  }
  const from = card.getBoundingClientRect()
  const dx =
    mode === 'into'
      ? rect.left + rect.width / 2 - (from.left + from.width / 2)
      : rect.left - from.left
  const dy =
    mode === 'into'
      ? rect.top + rect.height / 2 - (from.top + from.height / 2)
      : rect.top - from.top
  const duration = mode === 'into' ? MOTION_MS.glide : MOTION_MS.spring
  const animation = card.animate(
    [
      { transform: 'none', opacity: 1 },
      {
        transform: `translate(${dx}px, ${dy}px) scale(${mode === 'into' ? 0.25 : 0.9})`,
        opacity: 0,
      },
    ],
    { duration, easing: themeEasing(mode === 'into' ? 'glide' : 'spring'), fill: 'forwards' },
  )
  animation.finished.then(clear, clear)
  // Animations stall in a background tab; the preview must go regardless.
  window.setTimeout(clear, duration + 100)
}

function overlayCard(): HTMLElement | null {
  return overlay?.querySelector<HTMLElement>('[data-drag-card]') ?? null
}

/** A drag ends with a click on whatever is under the pointer; it must not select or open it. */
function swallowNextClick(): void {
  const stop = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  window.setTimeout(() => {
    window.removeEventListener('click', stop, { capture: true })
  }, 0)
}
