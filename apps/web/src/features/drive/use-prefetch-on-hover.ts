import type { DriveNode } from '@dfs/shared'
import { useEffect, useRef } from 'react'
import { prefetchFolder } from './api'

/** Long enough that sweeping the pointer across a list does not fire requests. */
const HOVER_INTENT_MS = 80

/** Pointer handlers that prefetch a folder once the pointer rests on it. */
export function usePrefetchOnHover(node: DriveNode | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    [],
  )

  if (node?.kind !== 'folder') return {}

  return {
    onPointerEnter: () => {
      timer.current = setTimeout(() => {
        prefetchFolder(node)
      }, HOVER_INTENT_MS)
    },
    onPointerLeave: () => {
      clearTimeout(timer.current)
    },
  }
}
