// Pure data-shaping helpers shared by `<BreakerPanel />` (live strip on the
// pool header) and the oracle chart (band overlay). Both consumers read the
// same `POOL_BREAKER_CONFIG` payload — SWR dedupes the request via cache key
// — and need the same picker + effective-threshold semantics. Keeping a
// single canonical implementation here avoids drift if the picker rule
// changes (e.g. a future breaker kind takes precedence).

import type { BreakerConfig } from "@/lib/types";

/** Returns the trip-able BreakerConfig — enabled, non-MARKET_HOURS, and
 * deterministic when more than one exists (`POOL_BREAKER_CONFIG` orders by
 * `id asc`, so `.find` returns the lowest-id match). MARKET_HOURS has no
 * per-feed config and is rendered as the title-row pill instead.
 *
 * Returns `null` when no enabled trip-able config exists so consumers don't
 * surface a disabled breaker as live (the chart would draw a band the
 * contract wouldn't evaluate; `<BreakerPanel />` would render a stale strip).
 * Production has ≤1 trip-able config per feed today. */
export function pickTrippableConfig(
  configs: BreakerConfig[],
): BreakerConfig | null {
  return (
    configs.find((c) => c.enabled && c.breaker.kind !== "MARKET_HOURS") ?? null
  );
}

/** Effective breaker threshold (Fixidity). Per-feed override else breaker
 * default. The on-chain BreakerBox treats a `rateChangeThreshold == 0`
 * per-feed value as "inherit from the Breaker default", so this resolution
 * must match for the dashboard to render the truly-applied limit. Named to
 * avoid collision with `effectiveThreshold` in `@/lib/health`, which resolves
 * a Pool's rebalance threshold (different domain). */
export function effectiveBreakerThreshold(cfg: BreakerConfig): bigint {
  const override = BigInt(cfg.rateChangeThreshold);
  if (override > BigInt(0)) return override;
  return BigInt(cfg.breaker.defaultRateChangeThreshold);
}
