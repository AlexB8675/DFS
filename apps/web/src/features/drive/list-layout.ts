import type { DriveNode } from '@dfs/shared'

/** A node as listed; search results also carry the folder they are in. */
export type ListedNode = DriveNode & { location?: string }

export const ROW_HEIGHT = 40
/** A row with its location under the name, as search results read when the list is narrow. */
export const STACKED_ROW_HEIGHT = 56
export const TILE_HEIGHT = 156
export const TILE_MIN_WIDTH = 168

/**
 * Which columns of the list view fit. The list measures itself rather than
 * asking the screen's width: next to the sidebar, a page has far less room
 * than the screen suggests.
 */
export interface ListLayout {
  /** The modified date and the size. */
  details: boolean
  /** Where a search result's folder goes: a column of its own, or under the name. */
  location: 'none' | 'column' | 'under'
  /** The grid template shared by the header and the rows, so the columns line up. */
  columns: string
}

// Whole class names, so Tailwind finds them.
const NARROW: ListLayout = {
  details: false,
  location: 'none',
  columns: 'grid-cols-[minmax(0,1fr)_2rem]',
}
const WIDE: ListLayout = {
  details: true,
  location: 'none',
  columns: 'grid-cols-[minmax(0,1fr)_8rem_5rem_2rem]',
}
const NARROW_WITH_LOCATION: ListLayout = { ...NARROW, location: 'under' }
const MEDIUM_WITH_LOCATION: ListLayout = { ...WIDE, location: 'under' }
const WIDE_WITH_LOCATION: ListLayout = {
  details: true,
  location: 'column',
  columns: 'grid-cols-[minmax(0,1fr)_minmax(0,14rem)_8rem_5rem_2rem]',
}

/** The list's width, in pixels, from which the modified date and size are shown. */
const DETAILS_MIN_WIDTH = 500
/** From which a search result's folder gets a column of its own. */
const LOCATION_MIN_WIDTH = 800
/** Under the name, a folder takes room that names need: the date and size wait for more of it. */
const DETAILS_WITH_LOCATION_MIN_WIDTH = 640

/** `width` is 0 until the list has been measured: then the roomy layout, which is the usual one. */
export function listLayout(width: number, showLocation: boolean): ListLayout {
  const known = width > 0
  if (!showLocation) return !known || width >= DETAILS_MIN_WIDTH ? WIDE : NARROW
  if (!known || width >= LOCATION_MIN_WIDTH) return WIDE_WITH_LOCATION
  return width >= DETAILS_WITH_LOCATION_MIN_WIDTH ? MEDIUM_WITH_LOCATION : NARROW_WITH_LOCATION
}

/** DOM ID of a list option, for `aria-activedescendant`. */
export function optionId(nodeId: string): string {
  return `node-${nodeId}`
}
