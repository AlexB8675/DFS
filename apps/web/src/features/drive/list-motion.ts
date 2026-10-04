import { create } from 'zustand'
import { MOTION_MS, prefersReducedMotion } from '@/lib/motion'

/** How long a new row counts as new, so it pops in when it first shows up. */
const FRESH_MS = 1500

interface ListMotionState {
  /** Rows playing their exit animation, about to be removed. */
  leaving: ReadonlySet<string>
  /** Rows that just appeared (created, uploaded, restored). */
  fresh: ReadonlySet<string>
}

/**
 * Enter and exit animations for list rows. A row can't animate its own
 * removal, since it unmounts as soon as its node leaves the query cache, so
 * actions mark rows as leaving first, wait for the exit, then remove them.
 * The rows below then glide up into the gap (see VirtualList).
 */
export const useListMotion = create<ListMotionState>()(() => ({
  leaving: new Set(),
  fresh: new Set(),
}))

/** Plays the exit animation of these rows and resolves when it is done. */
export async function animateOut(ids: readonly string[]): Promise<void> {
  if (ids.length === 0 || prefersReducedMotion()) return
  useListMotion.setState((state) => ({ leaving: withIds(state.leaving, ids) }))
  await new Promise((resolve) => setTimeout(resolve, MOTION_MS.exit))
}

/** Ends the leaving state, once the rows are gone or the action failed and they stay. */
export function settleLeaving(ids: readonly string[]): void {
  useListMotion.setState((state) => ({ leaving: withoutIds(state.leaving, ids) }))
}

/** Lets these rows pop in when they first appear. */
export function markFresh(ids: readonly string[]): void {
  if (ids.length === 0 || prefersReducedMotion()) return
  useListMotion.setState((state) => ({ fresh: withIds(state.fresh, ids) }))
  setTimeout(() => {
    useListMotion.setState((state) => ({ fresh: withoutIds(state.fresh, ids) }))
  }, FRESH_MS)
}

function withIds(set: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return new Set([...set, ...ids])
}

function withoutIds(set: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (!ids.some((id) => set.has(id))) return set
  const next = new Set(set)
  for (const id of ids) next.delete(id)
  return next
}
