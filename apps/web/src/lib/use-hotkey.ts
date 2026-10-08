import { useEffect } from 'react'
import { isEditable } from './editable'

/**
 * Calls `handler` when `key` is pressed anywhere, unless the user is typing
 * in a field or is in a dialog (the viewer has keys of its own).
 */
export function useHotkey(key: string, handler: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== key || event.ctrlKey || event.metaKey || event.altKey) return
      if (isEditable(event.target) || inDialog(event.target)) return
      event.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [key, handler])
}

function inDialog(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]') !== null
  )
}
