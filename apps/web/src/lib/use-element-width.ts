import { useState, type RefCallback } from 'react'

/**
 * Tracks an element's width. Attach the returned ref to the element. Read as
 * `clientWidth` both at mount and on every resize, so the two never disagree
 * near a threshold: right for elements without padding, which these all are.
 */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0)

  const ref: RefCallback<T> = (element) => {
    if (!element) return
    // Measured at once, so the first paint already has it; the observer follows every change.
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }

  return [ref, width]
}
