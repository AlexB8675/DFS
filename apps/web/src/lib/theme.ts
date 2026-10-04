import { create } from 'zustand'
import { canUseViewTransitions } from './motion'
import { clearNavTransition } from './navigation'

export type Theme = 'dark' | 'light' | 'system'

// Read by the inline script in index.html too, so it stays a plain string.
const STORAGE_KEY = 'dfs.theme'
const lightQuery = matchMedia('(prefers-color-scheme: light)')

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useThemeStore = create<ThemeState>()((set) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this tab only.
    }
    set({ theme })
    // Crossfade between the old and new colors instead of snapping.
    withViewTransition(() => {
      applyTheme(theme)
    })
  },
}))

/** The theme actually shown, after resolving `system`. */
export function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') return lightQuery.matches ? 'light' : 'dark'
  return theme
}

/** Applies the stored theme and follows OS changes while `system` is selected. */
export function initTheme(): void {
  applyTheme(useThemeStore.getState().theme)
  lightQuery.addEventListener('change', () => {
    const { theme } = useThemeStore.getState()
    if (theme === 'system') applyTheme(theme)
  })
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', resolveTheme(theme) === 'dark')
}

/** Runs a DOM update as a View Transition where supported and motion is welcome. */
function withViewTransition(update: () => void): void {
  if (!canUseViewTransitions()) {
    update()
    return
  }
  // A plain crossfade: drop the navigation style a page change may have left.
  clearNavTransition()
  document.startViewTransition(update)
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'system') return stored
  } catch {
    // Fall through to the default.
  }
  return 'dark'
}
