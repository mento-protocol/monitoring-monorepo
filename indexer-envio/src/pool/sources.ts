const SOURCE_PRIORITY = {
  virtual_pool_factory: 100,
  fpmm_factory: 90,
  fpmm_rebalanced: 50,
  fpmm_update_reserves: 40,
  // Below state-sync events: a threshold update doesn't change reserves
  // or oracle, so the legacy "preferred-source" stickiness should keep
  // whichever live event source wrote last.
  fpmm_threshold_updated: 35,
  fpmm_swap: 30,
  fpmm_mint: 20,
  fpmm_burn: 20,
} as const;

/** Values the indexer passes as `source` when calling upsertPool / the
 *  breach helpers. Typing this as a union (rather than bare string) means
 *  a typo like "fpmm_update_reseves" is a compile error instead of a
 *  silently-unmatched deferral branch. */
export type PoolUpdateSource = keyof typeof SOURCE_PRIORITY;

// `existingSource` is typed as `string` because Pool.source is stored as
// a plain string in the DB (potentially including legacy values not in
// the current union). Use a safe lookup helper so unknown strings fall
// through to priority 0 without an unchecked cast.
const sourcePriority = (source: string): number =>
  (SOURCE_PRIORITY as Record<string, number>)[source] ?? 0;

export const pickPreferredSource = (
  existingSource: string | undefined,
  incomingSource: PoolUpdateSource,
): string => {
  if (!existingSource) return incomingSource;
  return sourcePriority(incomingSource) >= sourcePriority(existingSource)
    ? incomingSource
    : existingSource;
};
