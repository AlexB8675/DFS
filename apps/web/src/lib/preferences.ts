import type { MetricRange, SortField, SortOrder } from '@dfs/shared'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ViewMode = 'list' | 'grid'

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 420

interface PreferencesState {
  viewMode: ViewMode
  sortField: SortField
  sortOrder: SortOrder
  sidebarWidth: number
  /** The time range of the admin's graphs (§16), the same on every admin page. */
  metricRange: MetricRange
  setViewMode: (viewMode: ViewMode) => void
  /** Sorts by `field`; choosing the current field again flips the order. */
  sortBy: (field: SortField) => void
  setSidebarWidth: (width: number) => void
  setMetricRange: (range: MetricRange) => void
}

/** Per-browser UI preferences, persisted in localStorage. */
export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      viewMode: 'list',
      sortField: 'name',
      sortOrder: 'asc',
      sidebarWidth: 264,
      metricRange: '24h',
      setViewMode: (viewMode) => {
        set({ viewMode })
      },
      sortBy: (field) => {
        set((state) => ({
          sortField: field,
          sortOrder:
            state.sortField === field
              ? state.sortOrder === 'asc'
                ? 'desc'
                : 'asc'
              : defaultOrder(field),
        }))
      },
      setSidebarWidth: (width) => {
        set({ sidebarWidth: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)) })
      },
      setMetricRange: (metricRange) => {
        set({ metricRange })
      },
    }),
    { name: 'dfs.preferences', version: 1 },
  ),
)

/** Names read best A→Z; dates and sizes are most useful newest/largest first. */
function defaultOrder(field: SortField): SortOrder {
  return field === 'name' ? 'asc' : 'desc'
}
