import type { KeyboardEvent } from 'react'
import { isEditable } from '@/lib/editable'
import type { ViewHandle } from './view-handle'

/**
 * The keys of a file on screen: ← and → for the files around it, + − 0 to
 * zoom, Ctrl+F to search its text. Keys typed into a field are the field's.
 */
export function handlePreviewKey(
  event: KeyboardEvent,
  view: ViewHandle | null,
  previous: (() => void) | null,
  next: (() => void) | null,
): void {
  if (event.altKey || isEditable(event.target)) return
  const command = event.ctrlKey || event.metaKey
  if (command && event.key === 'f' && view?.find) {
    event.preventDefault()
    view.find()
    return
  }
  if (command) return
  const actions: Record<string, (() => void) | null | undefined> = {
    ArrowLeft: previous,
    ArrowRight: next,
    '+': view?.zoomIn,
    '=': view?.zoomIn,
    '-': view?.zoomOut,
    '0': view?.reset,
  }
  const action = actions[event.key]
  if (!action) return
  event.preventDefault()
  action()
}
