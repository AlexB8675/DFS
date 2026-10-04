import { useNavigate, type NavigateOptions, type To } from 'react-router'
import { canUseViewTransitions } from './motion'

/**
 * How the content pane animates to the next page (see index.css): `forward`
 * into a folder, `back` out of it, `section` between unrelated pages.
 */
export type NavStyle = 'forward' | 'back' | 'section'

/**
 * Sets the style of the next navigation's View Transition. Returns whether to
 * animate at all, which is what `viewTransition` on a navigation should be.
 */
export function prepareNavTransition(style: NavStyle): boolean {
  if (!canUseViewTransitions()) return false
  document.documentElement.dataset.nav = style
  return true
}

/**
 * Browser back and forward: React Router replays the View Transition of the
 * navigation being undone or redone, so set its direction to match. The
 * Navigation API tells which way the history moves; without it, assume back.
 */
export function followHistoryDirection(): void {
  // Typed as always present, but Safari before 26 and older Firefox lack it.
  const { navigation } = window as { navigation?: Navigation }
  if (navigation) {
    navigation.addEventListener('navigate', (event) => {
      if (event.navigationType !== 'traverse') return
      const from = navigation.currentEntry?.index ?? 0
      prepareNavTransition(event.destination.index < from ? 'back' : 'forward')
    })
  } else {
    window.addEventListener('popstate', () => {
      prepareNavTransition('back')
    })
  }
}

/** Clears the navigation style, so other View Transitions (the theme switch) use their own. */
export function clearNavTransition(): void {
  delete document.documentElement.dataset.nav
}

/** `navigate`, with the content pane animating in the given style. */
export function useTransitionNavigate() {
  const navigate = useNavigate()
  return (to: To, style: NavStyle, options: NavigateOptions = {}) => {
    void navigate(to, { ...options, viewTransition: prepareNavTransition(style) })
  }
}

/** Props for a `<Link>` that animates the content pane in the given style. */
export function transitionLinkProps(style: NavStyle) {
  return {
    viewTransition: canUseViewTransitions(),
    onClickCapture: () => {
      prepareNavTransition(style)
    },
  }
}
