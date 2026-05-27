// Pure data-shaping helpers shared by `<BreakerPanel />` (live strip on the
// pool header) and the oracle chart (band overlay). Both consumers read the
// same `POOL_BREAKER_CONFIG` payload — SWR dedupes the request via cache key
// — and need the same picker + effective-threshold semantics. Keeping a
// single canonical implementation here avoids drift if the picker rule
// changes (e.g. a future breaker kind takes precedence).

import type { BreakerConfig } from "@/lib/types";

/** Returns the trip-able BreakerConfig (filters out MARKET_HOURS, which has
 * no per-feed config and is rendered as the title-row pill instead). Prefers
 * enabled configs; production has ≤1 trip-able config per feed today. */
export function pickTrippableConfig(
  configs: BreakerConfig[],
): BreakerConfig | null {
  const candidates = configs.filter((c) => c.breaker.kind !== "MARKET_HOURS");
  return candidates.find((c) => c.enabled) ?? candidates[0] ?? null;
}

/** Effective threshold (Fixidity). Per-feed override else breaker default.
 * The on-chain BreakerBox treats a `rateChangeThreshold == 0` per-feed value
 * as "inherit from the Breaker default", so this resolution must match for
 * the dashboard to render the truly-applied limit. */
export function effectiveThreshold(cfg: BreakerConfig): bigint {
  const override = BigInt(cfg.rateChangeThreshold);
  if (override > BigInt(0)) return override;
  return BigInt(cfg.breaker.defaultRateChangeThreshold);
}
