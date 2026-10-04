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
} as const
