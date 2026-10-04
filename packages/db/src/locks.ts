// Postgres advisory locks used across services. The two-key form keeps them
// in a namespace of their own: pg_advisory_lock(NAMESPACE, key).

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
} as const

/**
 * A second namespace for per-owner tree locks: `pg_advisory_xact_lock(TREE_LOCK_NAMESPACE,
 * hashtext(owner_id))` serializes moves within one drive, so two crossing moves can't
 * make a cycle.
 */
export const TREE_LOCK_NAMESPACE = 0x445452
