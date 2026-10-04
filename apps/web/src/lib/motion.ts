/** True when the user asked the OS for less motion. CSS handles its own animations; this is for JS ones. */
export function prefersReducedMotion(): boolean {
  // matchMedia is missing outside browsers (unit tests): no animations to skip there.
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Whether to run a View Transition: the browser supports them, motion is
 * welcome, and the page is on screen (a hidden page aborts them with an error).
 */
export function canUseViewTransitions(): boolean {
  return (
    'startViewTransition' in document &&
    document.visibilityState === 'visible' &&
    !prefersReducedMotion()
  )
}

/** Reads a spring curve from the theme (`--ease-spring` etc.), for Web Animations. */
export function themeEasing(name: 'glide' | 'spring' | 'bounce' | 'exit'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--ease-${name}`)
  return value.trim() || 'ease-out'
}

/** Durations that match the curves above (see index.css). */
export const MOTION_MS = { glide: 350, spring: 430, bounce: 580, exit: 150 } as const
