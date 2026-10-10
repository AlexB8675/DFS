import { useSyncExternalStore } from 'react'

/** Whether a CSS media query matches now, and follows it as the window changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = matchMedia(query)
      list.addEventListener('change', notify)
      return () => {
        list.removeEventListener('change', notify)
      }
    },
    () => matchMedia(query).matches,
    () => false,
  )
}
