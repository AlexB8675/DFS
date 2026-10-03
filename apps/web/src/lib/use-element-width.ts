import { useState, type RefCallback } from 'react'

/** Tracks an element's content width. Attach the returned ref to the element. */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0)

  const ref: RefCallback<T> = (element) => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }

  return [ref, width]
}
