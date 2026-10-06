// Postgres advisory locks used across services. The two-key form keeps them
// in a namespace of their own: pg_advisory_lock(NAMESPACE, key).
//
// Transactions that write take their locks in one order, so none can wait on
// another in a circle: the drive's tree lock, upload sessions, nodes (by id),
// the user's row, dirty-folder markers (by id), and the journal lock last.
// Starting uploads takes a shared tree lock, then the user's row, and after it
// only the key-share locks of foreign keys on nodes, which updates (such as
// completing an upload) don't block.

/** "DFS" in ASCII. */
export const LOCK_NAMESPACE = 0x444653

export const LOCKS = {
  /** Held while migrations run, so two migrators never race. */
  migrate: 1,
  /** Held for as long as a bot instance leads (DESIGN §11). */
  botLeader: 2,
  /** Taken right before journal records are written, so `journal.id` is commit order (§8). */
  journal: 3,
  /** Held while folder sizes are recomputed, so two recomputations never interleave. */
  folderStats: 4,
  /**
   * Taken while an admin task is queued, so two requests at once can't both
   * find none of its kind under way (Admin → Storage).
   */
  adminTask: 5,
  /**
   * Held while the journal is sealed into batches (§8), so one API instance
   * flushes at a time. Never `journal`: every journaled write takes that one.
   */
  journalFlush: 6,
} as const

/**
 * A second namespace for per-owner tree locks: `pg_advisory_xact_lock(TREE_LOCK_NAMESPACE,
 * hashtext(owner_id))` serializes moves, trash and restoration within one drive.
 * Creation holds the shared form to keep its destination visible until commit
 * while allowing other creations to proceed.
 */
export const TREE_LOCK_NAMESPACE = 0x445452
