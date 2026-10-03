import type { DriveNode } from '@dfs/shared'
import type { KeyboardEvent } from 'react'
import { useSelectionStore } from './selection'
import { useNodeActions } from './use-node-actions'

/**
 * Keyboard support for a node list, like a desktop file manager:
 * arrows move (Shift extends the selection), Home/End jump, Enter opens,
 * F2 renames, Delete trashes, Ctrl+A selects all, Escape clears, and
 * Backspace or Alt+↑ goes to the parent folder.
 */
export function useListKeyboard(nodes: DriveNode[], columns: number, onBack?: () => void) {
  const store = useSelectionStore()
  const actions = useNodeActions()

  return (event: KeyboardEvent<HTMLElement>) => {
    const state = store.getState()
    const index = nodes.findIndex((node) => node.id === state.activeId)
    const selectedNodes = nodes.filter((node) => state.selected.has(node.id))

    const moveTo = (target: number) => {
      const node = nodes[Math.min(nodes.length - 1, Math.max(0, target))]
      if (!node) return
      event.preventDefault()
      if (event.shiftKey) {
        state.selectRange(
          nodes.map((candidate) => candidate.id),
          node.id,
        )
      } else {
        state.select(node.id)
      }
    }

    switch (event.key) {
      case 'ArrowDown':
        moveTo(index === -1 ? 0 : index + columns)
        break
      case 'ArrowUp':
        if (event.altKey && onBack) {
          event.preventDefault()
          onBack()
        } else {
          moveTo(index === -1 ? 0 : index - columns)
        }
        break
      case 'ArrowRight':
        if (columns > 1) moveTo(index + 1)
        break
      case 'ArrowLeft':
        if (columns > 1) moveTo(index - 1)
        break
      case 'Home':
        moveTo(0)
        break
      case 'End':
        moveTo(nodes.length - 1)
        break
      case 'Enter': {
        const node = nodes[index]
        if (node) {
          event.preventDefault()
          actions.open(node)
        }
        break
      }
      case 'F2': {
        const [only] = selectedNodes
        if (only && selectedNodes.length === 1) {
          event.preventDefault()
          actions.rename(only)
        }
        break
      }
      case 'Delete':
        if (selectedNodes.length > 0) {
          event.preventDefault()
          actions.moveToTrash(selectedNodes)
        }
        break
      case 'Backspace':
        if (onBack) {
          event.preventDefault()
          onBack()
        }
        break
      case 'Escape':
        state.clear()
        break
      case 'a':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          state.selectAll(nodes.map((node) => node.id))
        }
        break
    }
  }
}
