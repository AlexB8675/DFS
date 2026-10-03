import type { DriveNode } from '@dfs/shared'

/** A node as listed; search results also carry the folder they are in. */
export type ListedNode = DriveNode & { location?: string }

export const ROW_HEIGHT = 40
export const TILE_HEIGHT = 156
export const TILE_MIN_WIDTH = 168

// Header and rows share these grid templates so the columns line up. Hidden
// cells take no grid track, so each breakpoint lists only the visible columns.
const COLUMNS = 'grid-cols-[minmax(0,1fr)_2rem] sm:grid-cols-[minmax(0,1fr)_9.5rem_5.5rem_2rem]'
const COLUMNS_WITH_LOCATION = `${COLUMNS} lg:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_9.5rem_5.5rem_2rem]`

export function listColumns(showLocation: boolean): string {
  return showLocation ? COLUMNS_WITH_LOCATION : COLUMNS
}

/** DOM ID of a list option, for `aria-activedescendant`. */
export function optionId(nodeId: string): string {
  return `node-${nodeId}`
}
