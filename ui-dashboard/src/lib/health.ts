/**
 * Health status computation for pool oracle monitoring.
 * Mirrors the deviation-threshold logic in the indexer's pool/health.ts;
 * behavioral parity enforced by indexer-envio/test/healthStatusParity.test.ts.
 */

export type HealthStatus =
  | "OK"
  | "WARN"
  | "WEEKEND"
  | "HALTED"
  | "CRITICAL"
  | "N/A";

import { isWeekend, tradingSecondsInRange } from "./weekend";
import { isVirtualPool } from "./types";
import { isUsdPegged } from "./tokens";
import { chainTokenSymbols } from "@mento-protocol/config/tokens";
import {
  DEVIATION_TOLERANCE_RATIO,
  DEVIATION_CRITICAL_RATIO,
} from "@mento-protocol/config/thresholds";

/**
 * Fallback oracle staleness threshold in seconds.
 *
 * Used when oracleExpiry is not yet indexed for a pool (e.g. pools created
 * before the indexer started capturing it). SortedOracles.reportExpirySeconds()
 * on Celo mainnet = 300s (5 min), which is the lowest value across supported chains.
 */
const ORACLE_STALE_SECONDS = 300;

/**
 * Per-chain fallback for SortedOracles.reportExpirySeconds().
 *
 * Values fetched on-chain 2025-03-14:
 *   - Celo mainnet  (42220): 300s  (0x12c)
 *   - Monad mainnet (143):   360s  (0x168)
 *
 * Used when oracleExpiry is 0 in the DB (pool created before the indexer
 * started fetching it, or first-seen on a chain that returned null).
 * Falls back to ORACLE_STALE_SECONDS (300) for unknown chains.
 */
const ORACLE_STALE_SECONDS_BY_CHAIN: Record<number, number> = {
  42220: 300, // Celo mainnet
  11142220: 300, // Celo Alfajores
  143: 360, // Monad mainnet
  10143: 360, // Monad testnet
};

interface PoolHealthState {
  source?: string | undefined;
  // Healed VPs intentionally retain `fpmm_*` source (pickPreferredSource
  // priority alignment); `wrappedExchangeId` is the canonical VP signal.
  // Both feed `isVirtualPool`, which gates the "N/A" branch below.
  wrappedExchangeId?: string | null | undefined;
  wrappedExchangeDeprecated?: boolean | undefined;
  vpDeprecationKnown?: boolean | undefined;
  token0?: string | null | undefined;
  token1?: string | null | undefined;
  oracleOk?: boolean | undefined;
  oracleTimestamp?: string | undefined;
  oracleFreshnessCheckedAt?: number | undefined;
  vpOracleFreshnessCheckedAt?: number | undefined;
  vpOracleTimestamp?: string | undefined;
  vpOracleNumReporters?: number | undefined;
  vpTokenDecimalsKnown?: boolean | undefined;
  oracleFreshnessCheckPending?: boolean | undefined;
  lastOracleReportAt?: string | undefined;
  medianLive?: boolean | undefined;
  oracleExpiry?: string | undefined;
  oracleFreshnessWindow?: string | undefined;
  oracleNumReporters?: number | undefined;
  wrappedExchangeMinimumReports?: string | undefined;
  // True once the indexer has read the VP's token decimals and the
  // self-healing freshness cursor is trustworthy. False/missing means the
  // VP oracle timestamp can be held at an older value while fresh reports
  // still arrive, so VP staleness must degrade to N/A instead of paging.
  tokenDecimalsKnown?: boolean | undefined;
  priceDifference?: string | undefined;
  degenerateReserves?: boolean | undefined;
  rebalanceThreshold?: number | undefined;
  // Direction-split thresholds — populated by the isolated
  // `ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN` / `POOL_THRESHOLDS_KNOWN_EXT`
  // queries. Both must be 0 (with Known=true) for `isNeverRebalance` to
  // hold; the active `rebalanceThreshold` alone can't be trusted because
  // it's just the side `pickActiveThreshold` chose at index time.
  rebalanceThresholdAbove?: number | undefined;
  rebalanceThresholdBelow?: number | undefined;
  // True when the indexer has read the on-chain values for both above/below
  // thresholds; false (or missing) when still at the schema default. Drives
  // the dual-sentinel `effectiveThreshold` semantics — see that function.
  rebalanceThresholdsKnown?: boolean | undefined;
  // Indexer's "is the deviation accrual trustworthy" flag. False when token
  // decimals are unknown (`normalizeTo18` would skew priceDifference) or
  // when threshold isn't yet read. Gates `computeHealthStatus` so a fresh
  // oracle report alongside untrusted priceDifference doesn't render as OK.
  hasHealthData?: boolean | undefined;
  lastRebalancedAt?: string | null | undefined;
  deviationBreachStartedAt?: string | null | undefined;
  // Indexer-denormalized: a price breaker (MEDIAN_DELTA / VALUE_DELTA, not
  // MARKET_HOURS) is tripped → swaps halted → "HALTED". Weekend FX closures
  // (MARKET_HOURS) flow through the WEEKEND path instead.
  breakerTripped?: boolean | undefined;
}

/**
 * How long a pool may sit above the critical magnitude (5% over threshold)
 * before it escalates from WARN to CRITICAL. Within tolerance is always OK;
 * above tolerance but below critical magnitude stays WARN regardless of
 * duration; only sustained large breaches escalate.
 *
 * Anchored on `deviationBreachStartedAt` (indexed at the block the pool first
 * crossed the 1.01x tolerance line). If that field is missing — rare, only
 * when the indexer hasn't populated it yet — we stay at WARN rather than
 * spuriously escalating.
 */
export const DEVIATION_BREACH_GRACE_SECONDS = 3600;

/**
 * Tolerance + critical-magnitude multipliers over the rebalance threshold.
 * Re-exported from `@mento-protocol/config/thresholds` so the
 * dashboard, the metrics-bridge probe, and the indexer all read the same
 * numbers. Parity with the indexer's `pool.ts` is enforced by
 * `indexer-envio/test/healthStatusParity.test.ts`.
 */
export { DEVIATION_CRITICAL_RATIO } from "@mento-protocol/config/thresholds";

/** True iff governance has explicitly configured this pool to never
 * rebalance — BOTH split sides 0 AND `rebalanceThresholdsKnown=true`.
 * Mirrors `isNeverRebalance` in indexer `pool.ts` (parity test in
 * `indexer-envio/test/healthStatusParity.test.ts`). Used to short-
 * circuit breach/health predicates without relying on the
 * `effectiveThreshold` 1e12 cushion.
 *
 * Cannot infer from `rebalanceThreshold` alone: that's the ACTIVE side
 * picked at indexing time based on current reserves. An asymmetric pool
 * with `above=0, below=300` legitimately persists `rebalanceThreshold=0`
 * while reservePrice is on the above side, but the pool DOES rebalance
 * on the below side — classifying it never-rebalance would suppress
 * deviation alerts for the half of the time it should fire. Both split
 * fields must be 0 for the predicate to hold.
 *
 * If `rebalanceThresholdAbove` / `rebalanceThresholdBelow` aren't
 * fetched yet (older indexer schema or unmigrated query), the predicate
 * returns false — safe under-bound. The split fields are populated by
 * the isolated `ALL_POOLS_REBALANCE_THRESHOLDS_KNOWN` /
 * `POOL_THRESHOLDS_KNOWN_EXT` queries.
 */
export function isNeverRebalance(pool: {
  rebalanceThresholdAbove?: number | undefined;
  rebalanceThresholdBelow?: number | undefined;
  rebalanceThresholdsKnown?: boolean | undefined;
}): boolean {
  // STRICT equality on the split fields: an absent (undefined) value is
  // NOT treated as 0. A caller with `rebalanceThresholdsKnown: true` but
  // missing split fields was probably built from a query that didn't
  // fetch the isolated EXT triple — defaulting undefined→0 there would
  // misclassify a real-threshold pool as never-rebalance and suppress
  // its alerts. Both split sides must be explicitly 0 for the predicate
  // to hold.
  return (
    pool.rebalanceThresholdAbove === 0 &&
    pool.rebalanceThresholdBelow === 0 &&
    pool.rebalanceThresholdsKnown === true
  );
}

/** Resolve the effective threshold in bps. Mirrors the indexer's `pool.ts`
 * `effectiveThreshold` (parity-tested via `healthStatusParity`). Three states:
 *  - `> 0`: the on-chain configured threshold (active side).
 *  - `0` AND `rebalanceThresholdsKnown=true`: governance configured the pool
 *    to never rebalance. Treat as effectively infinite (1e12) so high deviation
 *    on a never-rebalance pool stays OK instead of false-tripping CRITICAL.
 *    Callers should also short-circuit on `isNeverRebalance(pool)` — the 1e12
 *    cushion handles realistic priceDifference magnitudes but not extreme
 *    reserve-skew edges.
 *  - `0` AND `rebalanceThresholdsKnown=false` (or missing): indexer hasn't
 *    read the on-chain value yet (pre-resync, RPC blip, or pre-PR-1.5 schema).
 *    Fall back to 10000 (100%) so the predicate doesn't false-trip while
 *    waiting for the indexed flag.
 *
 * The schema-default unknown case must NOT collapse with the legitimate
 * "never rebalance" case — both have `rebalanceThreshold === 0`, but only
 * the latter has `rebalanceThresholdsKnown=true`. A missing `rebalanceThresholdsKnown`
 * (older indexer schema or unmigrated query) defaults to the safe 10000
 * under-bound. 1e12 fits in a JS number (≪ Number.MAX_SAFE_INTEGER).
 */
export const effectiveThreshold = (pool: {
  rebalanceThreshold?: number | undefined;
  rebalanceThresholdAbove?: number | undefined;
  rebalanceThresholdBelow?: number | undefined;
  rebalanceThresholdsKnown?: boolean | undefined;
}): number => {
  const threshold = pool.rebalanceThreshold ?? 0;
  if (threshold > 0) return threshold;
  // Same asymmetric-disambiguation as indexer `pool.ts:effectiveThreshold`:
  // 1e12 cushion only applies when BOTH split sides are 0 (governance-
  // disabled never-rebalance), not when the active side just happens to
  // be 0 on a half-disabled pool.
  if (isNeverRebalance(pool)) return 1e12;
  return 10000;
};

export function getOracleStalenessThreshold(
  pool: {
    source?: string | undefined;
    wrappedExchangeId?: string | null | undefined;
    oracleExpiry?: string | undefined;
    oracleFreshnessWindow?: string | undefined;
  },
  chainId?: number,
): number {
  if (isVirtualPool(pool)) {
    const vpWindow = Number(pool.oracleFreshnessWindow ?? "0");
    if (Number.isFinite(vpWindow) && vpWindow > 0) return vpWindow;
    return 0;
  }
  const indexed = Number(pool.oracleExpiry ?? "0");
  if (indexed > 0) return indexed;
  return (
    (chainId !== undefined
      ? ORACLE_STALE_SECONDS_BY_CHAIN[chainId]
      : undefined) ?? ORACLE_STALE_SECONDS
  );
}

function isVirtualPoolOracleFresh(
  pool: PoolHealthState,
  nowSeconds: number,
  chainId?: number,
): boolean {
  const medianValidity = vpMedianValidity(pool);
  if (medianValidity === false) return false;
  if (
    medianValidity === null ||
    (pool.vpTokenDecimalsKnown ?? pool.tokenDecimalsKnown) !== true
  ) {
    return true;
  }
  const stalenessThreshold = getOracleStalenessThreshold(pool, chainId);
  if (stalenessThreshold <= 0) return true;
  const oracleTs = Number(
    pool.vpOracleTimestamp ?? pool.oracleTimestamp ?? "0",
  );
  if (oracleTs === 0) return false;
  // VirtualPool freshness comes from an isolated extension query, so it owns a
  // separate observation time. Failed/partial refreshes retain both the row
  // and this timestamp, keeping the UI at its last confirmed state instead of
  // aging it into a synthetic CRITICAL while the degradation banner is shown.
  const checkedAt = confirmedFreshnessCheckedAt({
    oracleFreshnessCheckedAt: pool.vpOracleFreshnessCheckedAt,
  });
  return (checkedAt ?? nowSeconds) - oracleTs <= stalenessThreshold;
}

export function isOracleFresh(
  pool: PoolHealthState,
  nowSeconds = Math.floor(Date.now() / 1000),
  chainId?: number,
): boolean {
  if (isVirtualPool(pool)) {
    return isVirtualPoolOracleFresh(pool, nowSeconds, chainId);
  }
  const oracleTs = oracleFreshnessTimestamp(pool);
  if (oracleTs === 0) return false;
  const stalenessThreshold = getOracleStalenessThreshold(pool, chainId);
  // A cached FPMM row must not become CRITICAL solely because the browser clock
  // advanced past its expiry. That is the source of the homepage/detail
  // flashes: the backend already had a newer report, but the UI had not polled
  // it yet. Classify freshness at the last successful observation instead;
  // the 30s live-health poll confirms a genuinely stale timestamp on its next
  // response. While the first live check is in flight, suppress only this
  // locally inferred staleness (explicit oracleOk/median failures remain live).
  const checkedAt = confirmedFreshnessCheckedAt(pool);
  if (pool.oracleFreshnessCheckPending === true && checkedAt === null)
    return true;
  const evaluatedAt = checkedAt ?? nowSeconds;
  return evaluatedAt - oracleTs <= stalenessThreshold;
}

export function confirmedFreshnessCheckedAt(pool: {
  oracleFreshnessCheckedAt?: number | undefined;
}): number | null {
  const checkedAt = pool.oracleFreshnessCheckedAt;
  return checkedAt !== undefined && Number.isFinite(checkedAt) && checkedAt > 0
    ? checkedAt
    : null;
}

function isUsdPeggedVirtualPoolPair(
  pool: {
    token0?: string | null | undefined;
    token1?: string | null | undefined;
  },
  chainId?: number,
): boolean | null {
  if (chainId === undefined || !pool.token0 || !pool.token1) return null;
  const symbols = chainTokenSymbols(chainId);
  const sym0 = symbols[pool.token0.toLowerCase()];
  const sym1 = symbols[pool.token1.toLowerCase()];
  if (!sym0 || !sym1) return null;
  return isUsdPegged(sym0) && isUsdPegged(sym1);
}

function isVirtualPoolResetWindowStale(
  pool: {
    oracleTimestamp?: string | undefined;
    vpOracleTimestamp?: string | undefined;
    oracleFreshnessWindow?: string | undefined;
    vpOracleFreshnessCheckedAt?: number | undefined;
    tokenDecimalsKnown?: boolean | undefined;
    vpTokenDecimalsKnown?: boolean | undefined;
  },
  nowSeconds: number,
): boolean {
  if ((pool.vpTokenDecimalsKnown ?? pool.tokenDecimalsKnown) !== true)
    return false;
  const freshnessWindow = Number(pool.oracleFreshnessWindow ?? "0");
  const liveReportAt = Number(
    pool.vpOracleTimestamp ?? pool.oracleTimestamp ?? "0",
  );
  const checkedAt = confirmedFreshnessCheckedAt({
    oracleFreshnessCheckedAt: pool.vpOracleFreshnessCheckedAt,
  });
  const evaluatedAt = checkedAt ?? nowSeconds;
  return (
    Number.isFinite(freshnessWindow) &&
    freshnessWindow > 0 &&
    Number.isFinite(liveReportAt) &&
    liveReportAt > 0 &&
    evaluatedAt - liveReportAt > freshnessWindow
  );
}

function vpMedianValidity(pool: {
  medianLive?: boolean | undefined;
  oracleNumReporters?: number | undefined;
  vpOracleNumReporters?: number | undefined;
  oracleFreshnessWindow?: string | undefined;
  tokenDecimalsKnown?: boolean | undefined;
  vpTokenDecimalsKnown?: boolean | undefined;
  wrappedExchangeMinimumReports?: string | undefined;
}): boolean | null {
  if ((pool.vpTokenDecimalsKnown ?? pool.tokenDecimalsKnown) !== true)
    return null;
  const freshnessWindow = Number(pool.oracleFreshnessWindow ?? "0");
  if (!Number.isFinite(freshnessWindow) || freshnessWindow <= 0) return null;
  const minimumReports = Number(pool.wrappedExchangeMinimumReports ?? "0");
  if (!Number.isFinite(minimumReports) || minimumReports <= 0) return null;
  const oracleNumReporters = Number(
    pool.vpOracleNumReporters ?? pool.oracleNumReporters,
  );
  if (!Number.isFinite(oracleNumReporters) || oracleNumReporters < 0) {
    return null;
  }
  if (pool.medianLive === false) return false;
  if (oracleNumReporters < minimumReports) return false;
  return pool.medianLive === true ? true : null;
}

export function isVirtualPoolMedianInvalid(pool: {
  medianLive?: boolean | undefined;
  oracleNumReporters?: number | undefined;
  vpOracleNumReporters?: number | undefined;
  oracleFreshnessWindow?: string | undefined;
  tokenDecimalsKnown?: boolean | undefined;
  vpTokenDecimalsKnown?: boolean | undefined;
  wrappedExchangeMinimumReports?: string | undefined;
}): boolean {
  return vpMedianValidity(pool) === false;
}

function computeVirtualPoolHealthStatus(
  pool: PoolHealthState,
  chainId: number | undefined,
  nowSeconds: number,
): HealthStatus {
  if (pool.wrappedExchangeDeprecated === true) return "N/A";
  if (pool.vpDeprecationKnown === false) return "N/A";
  const medianValidity = vpMedianValidity(pool);
  if (medianValidity === false) return "CRITICAL";
  if (medianValidity === null) return "N/A";
  if (!isVirtualPoolResetWindowStale(pool, nowSeconds)) return "N/A";
  const usdPeggedPair = isUsdPeggedVirtualPoolPair(pool, chainId);
  return isWeekend() && usdPeggedPair === false ? "WEEKEND" : "CRITICAL";
}

/**
 * Compute the health status for a pool. Returns:
 *  - "N/A" for VirtualPools (no oracle), and for FPMM pools whose indexer
 *    has flagged the deviation accrual as untrusted (`hasHealthData=false`
 *    — token decimals or threshold not yet read on chain)
 *  - "WEEKEND" when the oracle is stale during FX market closure
 *  - "CRITICAL" when the oracle is stale (real incident) OR devRatio > 1.05
 *    sustained past `DEVIATION_BREACH_GRACE_SECONDS`
 *  - "WARN" when devRatio is above tolerance but either below the critical
 *    magnitude or still within the grace window
 *  - "OK" otherwise, including degenerate-reserve windows where priceDifference
 *    remains a faithful reserve-skew signal but is excluded from deviation
 *    health accounting
 *
 * Staleness uses the last successful observation time plus indexed
 * `oracleExpiry` (per-feed), with a wall-clock fallback for unobserved callers
 * and `ORACLE_STALE_SECONDS` for pools that pre-date the field. The deviation
 * tier mirrors the indexer's `computeHealthStatus` (parity test lives in
 * `indexer-envio/test/healthStatusParity.test.ts`).
 *
 * The `hasHealthData` short-circuit is a dashboard-side defense for the
 * indexer's decimals-unknown early-return path (codex P2 #3214513402,
 * PR 1.6): the homepage table + OG card recompute health here without
 * checking `hasHealthData`, so without this gate a pool whose indexer
 * advanced raw oracle timestamps from before the freshness-cursor preserve
 * fix landed would render OK / fresh while its `priceDifference` is
 * still stale / default. Strict `=== false` so callers from queries
 * that don't fetch the field (older snapshots) keep the prior behaviour.
 */
export function computeHealthStatus(
  pool: PoolHealthState,
  chainId?: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): HealthStatus {
  if (isVirtualPool(pool)) {
    return computeVirtualPoolHealthStatus(pool, chainId, nowSeconds);
  }
  // Oracle-staleness is an alertable freshness incident — keep it ABOVE
  // the hasHealthData gate so a stale-oracle pool doesn't get masked into
  // "N/A" just because the deviation accrual is also untrusted (codex P2
  // PR #370 #3214756051).
  const isOracleStale = !isOracleFresh(pool, nowSeconds, chainId);
  if (isOracleStale) {
    // Distinguish expected weekend staleness from a real incident
    if (isWeekend()) return "WEEKEND";
    return "CRITICAL";
  }
  if (pool.oracleOk === false) return "CRITICAL";
  // Swaps halted now — above the data-trust/config gates (a halt is real even
  // if deviation is untrusted / never-rebalance / degenerate), below the oracle
  // gates (a stale/broken oracle is the deeper fault; weekend stays WEEKEND).
  if (pool.breakerTripped === true) return "HALTED";
  // Indexer flagged the deviation accrual as untrusted — don't render
  // synthesized health status. See docblock for rationale.
  if (pool.hasHealthData === false) return "N/A";
  // Governance-configured "never rebalance" pools stay OK regardless of
  // priceDifference magnitude. Mirrors indexer `computeHealthStatus`.
  if (isNeverRebalance(pool)) return "OK";
  if (pool.degenerateReserves === true) return "OK";
  return deviationTierStatus(pool, nowSeconds);
}

/**
 * Deviation-magnitude tier for a fresh, trusted, rebalancing pool. Extracted
 * from `computeHealthStatus` for the complexity budget; behaviour is identical.
 */
function deviationTierStatus(
  pool: PoolHealthState,
  nowSeconds: number,
): HealthStatus {
  const diff = Number(pool.priceDifference ?? "0");
  const devRatio = diff / effectiveThreshold(pool);
  if (devRatio <= DEVIATION_TOLERANCE_RATIO) return "OK";
  if (devRatio <= DEVIATION_CRITICAL_RATIO) return "WARN";
  const breachStart = Number(pool.deviationBreachStartedAt ?? "0");
  // No anchor (indexer hasn't populated the field yet): treat as a fresh
  // breach and stay at WARN instead of jumping to CRITICAL without data.
  if (breachStart <= 0) return "WARN";
  const breachAge = nowSeconds - breachStart;
  return breachAge < DEVIATION_BREACH_GRACE_SECONDS ? "WARN" : "CRITICAL";
}

/**
 * Compute the trading limit status for a pool based on pressure values.
 *
 * - "N/A":       VirtualPools (source-or-wrappedExchangeId-confirmed) — no limits
 * - "CRITICAL":  max pressure >= 1.0 (limit breached)
 * - "WARN":      max pressure >= 0.8
 * - "OK":        max pressure < 0.8
 */
export function computeLimitStatus(pool: {
  source?: string | undefined;
  wrappedExchangeId?: string | null | undefined;
  limitPressure0?: string | undefined;
  limitPressure1?: string | undefined;
}): HealthStatus {
  if (isVirtualPool(pool)) return "N/A";
  const p0 = Number(pool.limitPressure0 ?? "0");
  const p1 = Number(pool.limitPressure1 ?? "0");
  const max = Math.max(p0, p1);
  if (max >= 1.0) return "CRITICAL";
  if (max >= 0.8) return "WARN";
  return "OK";
}

/** Tailwind bg-color class for a trading-limit pressure ratio (1.0 = limit breached). */
export function pressureColorClass(pressure: number): string {
  if (pressure >= 1.0) return "bg-red-500";
  if (pressure >= 0.8) return "bg-amber-500";
  return "bg-emerald-500";
}

/**
 * Non-alarm text color for an uptime percentage. Uptime is a rolling
 * reliability metric, NOT a live health STATE, so it deliberately does NOT
 * spend the emerald/amber/red alarm palette that HealthBadge / LimitBadge
 * reserve for actual state. Painting a low-uptime-but-currently-OK pool's
 * number red would contradict its green Health badge on the same row; keeping
 * the number neutral makes that contradiction impossible. Severity is instead
 * carried by a shape-distinct, color-independent glyph (`uptimeTierGlyph`) so
 * it stays legible in grayscale / for deuteranopia.
 */
export function uptimeColorClass(pct: number): string {
  return Number.isFinite(pct) ? "text-slate-200" : "text-slate-500";
}

export interface UptimeTierGlyph {
  /** Shape-distinct, colorblind-safe glyph for the uptime tier. */
  glyph: string;
  /** Accessible tier name (sr-only / tooltip) — the glyph is aria-hidden. */
  label: string;
}

/**
 * Shape-only severity signal for pool uptime, mirroring the coarse tier
 * boundaries the old color scale used (>99 / 90-99 / 70-90 / <70). Four
 * maximally-distinct silhouettes — circle, diamond, triangle, square (the
 * classic matplotlib-marker set) — so the tier is distinguishable WITHOUT
 * color (grayscale + deuteranopia safe). Color is intentionally absent here
 * and in `uptimeColorClass`, which also guarantees the uptime cell can never
 * contradict the row's Health badge hue.
 */
export function uptimeTierGlyph(pct: number): UptimeTierGlyph | null {
  if (!Number.isFinite(pct)) return null;
  if (pct > 99) return { glyph: "●", label: "excellent uptime" };
  if (pct >= 90) return { glyph: "◆", label: "good uptime" };
  if (pct >= 70) return { glyph: "▲", label: "degraded uptime" };
  return { glyph: "■", label: "poor uptime" };
}

/** Clamp `binary / total` to a percentage, returning `null` when the
 * window is empty or either input isn't a finite non-negative number. */
function clampedPct(binary: number, total: number): number | null {
  if (!Number.isFinite(binary) || !Number.isFinite(total) || total <= 0)
    return null;
  return Math.max(0, Math.min(100, (binary / total) * 100));
}

const MAX_HEALTH_CARRY_SECONDS = DEVIATION_BREACH_GRACE_SECONDS;

type HealthCounterState = {
  source: string;
  wrappedExchangeId?: string | null | undefined;
  healthTotalSeconds?: string | undefined;
  healthBinarySeconds?: string | undefined;
  lastOracleSnapshotTimestamp?: string | undefined;
  lastDeviationRatio?: string | undefined;
  oracleExpiry?: string | undefined;
};

type ParsedCounterBase = {
  baseBinary: number;
  baseTotal: number;
};

type LiveCounterInterval = {
  intervalStart: number;
  lastTs: number;
};

function originalHealthCounters(pool: HealthCounterState): {
  healthBinarySeconds?: string | undefined;
  healthTotalSeconds?: string | undefined;
} {
  return {
    healthBinarySeconds: pool.healthBinarySeconds,
    healthTotalSeconds: pool.healthTotalSeconds,
  };
}

function parsedCounterBase(pool: HealthCounterState): ParsedCounterBase | null {
  const baseBinary = Number(pool.healthBinarySeconds);
  const baseTotal = Number(pool.healthTotalSeconds ?? "0");
  if (!Number.isFinite(baseBinary) || !Number.isFinite(baseTotal)) return null;
  return { baseBinary, baseTotal };
}

function counterBaseResult(base: ParsedCounterBase): {
  healthBinarySeconds: string;
  healthTotalSeconds: string;
} {
  return {
    healthBinarySeconds: String(base.baseBinary),
    healthTotalSeconds: String(base.baseTotal),
  };
}

function liveCounterInterval(
  pool: HealthCounterState,
  nowSeconds: number,
  fromSeconds?: number,
): LiveCounterInterval | null {
  const lastTs = Number(pool.lastOracleSnapshotTimestamp ?? "0");
  if (!Number.isFinite(lastTs) || lastTs <= 0 || nowSeconds <= lastTs) {
    return null;
  }
  const floorTs = fromSeconds == null ? lastTs : Number(fromSeconds);
  if (!Number.isFinite(floorTs)) return null;
  const intervalStart = Math.max(lastTs, floorTs);
  if (nowSeconds <= intervalStart) return null;
  return { intervalStart, lastTs };
}

function previousDeviationHealthy(
  prevRatio: string | undefined,
): boolean | null {
  const rawRatio = prevRatio ?? "";
  const parsedRatio = parseFloat(rawRatio);
  if (
    rawRatio === "" ||
    rawRatio === "-1" ||
    (Number.isFinite(parsedRatio) && parsedRatio < 0)
  ) {
    return null;
  }
  return (
    Number.isFinite(parsedRatio) && parsedRatio <= DEVIATION_TOLERANCE_RATIO
  );
}

function freshnessCarrySeconds(args: {
  pool: HealthCounterState;
  intervalStart: number;
  lastTs: number;
  nowSeconds: number;
}): number {
  const indexedExpiry = Number(args.pool.oracleExpiry ?? "0");
  const freshnessLimit = Math.min(
    indexedExpiry > 0 ? indexedExpiry : MAX_HEALTH_CARRY_SECONDS,
    MAX_HEALTH_CARRY_SECONDS,
  );
  const carryEnd = Math.min(args.nowSeconds, args.lastTs + freshnessLimit);
  return carryEnd > args.intervalStart
    ? tradingSecondsInRange(args.intervalStart, carryEnd)
    : 0;
}

/** Return the counter pair with the current open interval included.
 *
 * The indexer persists health counters only when a later health sample closes
 * the previous interval. During an active oracle outage there may be no later
 * event yet, so the stored counters can still read 100%. This mirrors the
 * indexer's interval split at render time: carry the previous healthy state
 * through the freshness window, then count the stale tail as unhealthy.
 * `fromSeconds` clips the open interval for windowed displays that subtract
 * an older cumulative anchor.
 */
export function liveHealthCounters(
  pool: HealthCounterState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  fromSeconds?: number,
): {
  healthBinarySeconds?: string | undefined;
  healthTotalSeconds?: string | undefined;
} {
  const base = parsedCounterBase(pool);
  if (!base) return originalHealthCounters(pool);
  const baseResult = counterBaseResult(base);
  const interval = liveCounterInterval(pool, nowSeconds, fromSeconds);
  if (!interval) return baseResult;
  const prevHealthy = previousDeviationHealthy(pool.lastDeviationRatio);
  if (prevHealthy === null) return baseResult;
  const duration = tradingSecondsInRange(interval.intervalStart, nowSeconds);
  if (duration <= 0) return baseResult;
  const carrySeconds = freshnessCarrySeconds({
    pool,
    intervalStart: interval.intervalStart,
    lastTs: interval.lastTs,
    nowSeconds,
  });

  return {
    healthBinarySeconds: String(
      base.baseBinary + (prevHealthy ? carrySeconds : 0),
    ),
    healthTotalSeconds: String(base.baseTotal + duration),
  };
}

export function oracleFreshnessTimestamp(pool: {
  oracleTimestamp?: string | undefined;
  vpOracleTimestamp?: string | undefined;
  lastOracleReportAt?: string | undefined;
}): number {
  return Number(pool.vpOracleTimestamp ?? pool.oracleTimestamp ?? "0");
}

/**
 * All-time uptime % for a pool. Reads the indexer's binary-health
 * accumulator (`healthBinarySeconds / healthTotalSeconds`), which counts
 * BOTH oracle staleness (post-freshness gaps) AND price-deviation breaches
 * as unhealthy time. Weekend hours are excluded from both numerator and
 * denominator inside the indexer, so FX pools aren't penalised for closure.
 *
 * Returns `null` for virtual pools, missing rollups (resync window), and
 * zero observation windows.
 */
export function computePoolUptimePct(
  pool: HealthCounterState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number | null {
  if (isVirtualPool(pool)) return null;
  if (pool.healthBinarySeconds == null) return null;
  const counters = liveHealthCounters(pool, nowSeconds);
  return clampedPct(
    Number(counters.healthBinarySeconds),
    Number(counters.healthTotalSeconds ?? "0"),
  );
}

/** How old the daily-snapshot anchor is allowed to be before
 * `computeWindowUptimePct` falls back to "—". The "last 7d" subtitle
 * cutoff is bucketed to UTC midnight, so the picked anchor row is at most
 * ~24h older than the cutoff under normal conditions. Anything past this
 * threshold means the pool was inactive long enough that no snapshot was
 * written close to the window start, and the window the math actually
 * computes is wider than the label promises. */
const ANCHOR_FRESHNESS_LIMIT_SECONDS = 8 * 86_400;

/**
 * Windowed uptime % from two snapshots of the indexer's binary-health
 * accumulator. Differencing today's `Pool.healthBinarySeconds` against a
 * `PoolDailySnapshot` captured at-or-before the window start gives the
 * binary uptime % over the window. Returns `null` when either side is
 * missing, the window has no measurable seconds, or the anchor row is so
 * old that the math would silently widen the window past the "last 7d"
 * label.
 *
 * The `anchorTotal === 0` short-circuit defends against the indexer
 * resync window: a snapshot row written under the previous schema gets
 * `0` defaults for the new `cumulativeHealth*` fields, which would
 * otherwise make `(now - 0) / (total - 0) = all-time` and silently
 * masquerade as a 7d number.
 */
export function computeWindowUptimePct(
  now: {
    healthBinarySeconds?: string | undefined;
    healthTotalSeconds?: string | undefined;
  },
  anchor: {
    timestamp?: string | undefined;
    cumulativeHealthBinarySeconds?: string | undefined;
    cumulativeHealthTotalSeconds?: string | undefined;
  } | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number | null {
  if (!anchor) return null;
  const anchorTs = Number(anchor.timestamp ?? "0");
  if (anchorTs > 0 && nowSeconds - anchorTs > ANCHOR_FRESHNESS_LIMIT_SECONDS)
    return null;
  const anchorTotal = Number(anchor.cumulativeHealthTotalSeconds ?? "0");
  if (anchorTotal <= 0) return null;
  const anchorBinary = Number(anchor.cumulativeHealthBinarySeconds ?? "0");
  const nowBinary = Number(now.healthBinarySeconds ?? "0");
  const nowTotal = Number(now.healthTotalSeconds ?? "0");
  return clampedPct(nowBinary - anchorBinary, nowTotal - anchorTotal);
}

/**
 * Severity rank used to pick the worst status across oracle health and limit health.
 * N/A is least severe; CRITICAL is most severe.
 */
const STATUS_RANK: Record<HealthStatus, number> = {
  "N/A": 0,
  OK: 1,
  WARN: 2,
  WEEKEND: 3,
  // Rank applies only to the limit axis via worstStatus: a limit-CRITICAL
  // outranks a halt. A deviation-CRITICAL is short-circuited by the HALTED
  // return in computeHealthStatus above and is never compared here.
  HALTED: 4,
  CRITICAL: 5,
};

export function worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

type IndexedLimitStatus = Extract<
  HealthStatus,
  "N/A" | "OK" | "WARN" | "CRITICAL"
>;

const INDEXED_LIMIT_STATUSES = new Set<IndexedLimitStatus>([
  "N/A",
  "OK",
  "WARN",
  "CRITICAL",
]);

function isIndexedLimitStatus(
  value: string | undefined,
): value is IndexedLimitStatus {
  return (
    value !== undefined &&
    INDEXED_LIMIT_STATUSES.has(value as IndexedLimitStatus)
  );
}

/** Resolve a pool's effective limit status. Reads the indexer-stored
 * `limitStatus` string when present and valid, falling back to the live
 * `computeLimitStatus` for older pools that pre-date the indexed field or
 * malformed GraphQL payloads. */
export function resolveLimitStatus(pool: {
  source?: string | undefined;
  wrappedExchangeId?: string | null | undefined;
  limitStatus?: string | undefined;
  limitPressure0?: string | undefined;
  limitPressure1?: string | undefined;
}): HealthStatus {
  if (isIndexedLimitStatus(pool.limitStatus)) return pool.limitStatus;
  return computeLimitStatus(pool);
}

/**
 * Compute the effective display status for a pool, taking the worst of
 * oracle health and trading limit status. This is what the Health badge shows.
 *
 * `N/A` half-short-circuit: `worstStatus` is rank-based
 * (`STATUS_RANK["N/A"]=0 < "OK"=1`), so without intervention
 * `worstStatus("N/A", "OK")` resolves to `"OK"` — defeating the
 * `hasHealthData=false` gate from `computeHealthStatus` and rendering
 * no-data pools as healthy on the homepage / OG paths. When health is
 * `N/A` AND limits aren't surfacing a real risk signal (OK / N/A), return
 * `N/A` so the UI degrades visibly. When limits ARE elevated (WARN /
 * CRITICAL / WEEKEND) those still flow through — limit risk dominates
 * health uncertainty by design.
 */
export function computeEffectiveStatus(
  pool: {
    source?: string | undefined;
    wrappedExchangeId?: string | null | undefined;
    token0?: string | null | undefined;
    token1?: string | null | undefined;
    oracleOk?: boolean | undefined;
    oracleTimestamp?: string | undefined;
    oracleFreshnessCheckedAt?: number | undefined;
    vpOracleFreshnessCheckedAt?: number | undefined;
    vpOracleTimestamp?: string | undefined;
    vpOracleNumReporters?: number | undefined;
    vpTokenDecimalsKnown?: boolean | undefined;
    oracleFreshnessCheckPending?: boolean | undefined;
    medianLive?: boolean | undefined;
    oracleExpiry?: string | undefined;
    oracleFreshnessWindow?: string | undefined;
    oracleNumReporters?: number | undefined;
    wrappedExchangeMinimumReports?: string | undefined;
    wrappedExchangeDeprecated?: boolean | undefined;
    vpDeprecationKnown?: boolean | undefined;
    tokenDecimalsKnown?: boolean | undefined;
    priceDifference?: string | undefined;
    rebalanceThreshold?: number | undefined;
    rebalanceThresholdAbove?: number | undefined;
    rebalanceThresholdBelow?: number | undefined;
    rebalanceThresholdsKnown?: boolean | undefined;
    // Untrusted-deviation flag — propagated through `computeHealthStatus`.
    // See `PoolHealthState.hasHealthData` for the gating semantics.
    hasHealthData?: boolean | undefined;
    degenerateReserves?: boolean | undefined;
    deviationBreachStartedAt?: string | null | undefined;
    lastRebalancedAt?: string | null | undefined;
    // Price-breaker halt flag — propagated through `computeHealthStatus` to
    // surface "HALTED". See `PoolHealthState.breakerTripped`.
    breakerTripped?: boolean | undefined;
    limitStatus?: string | undefined;
    limitPressure0?: string | undefined;
    limitPressure1?: string | undefined;
  },
  chainId?: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): HealthStatus {
  const health = computeHealthStatus(pool, chainId, nowSeconds);
  const limit = resolveLimitStatus(pool);
  if (health === "N/A" && (limit === "OK" || limit === "N/A")) return "N/A";
  return worstStatus(health, limit);
}

type RebalancerStatus = "ACTIVE" | "STALE" | "N/A" | "NO_DATA";

/**
 * Compute rebalancer liveness for a pool.
 *
 * - "N/A":     VirtualPools — rebalancer not applicable by design
 * - "NO_DATA": FPMM pool with no rebalance events recorded yet
 * - "STALE":   age > 86400s AND pool is currently breached (deviation above
 *              threshold) — a rebalancer that hasn't fired in 24h while the
 *              pool is out of range is the actual concern
 * - "ACTIVE":  within 24h OR pool is under threshold (no work to do,
 *              silence is expected)
 */
export function computeRebalancerLiveness(
  pool: {
    source?: string | undefined;
    wrappedExchangeId?: string | null | undefined;
    lastRebalancedAt?: string | undefined;
    priceDifference?: string | undefined;
    rebalanceThreshold?: number | undefined;
    rebalanceThresholdAbove?: number | undefined;
    rebalanceThresholdBelow?: number | undefined;
    rebalanceThresholdsKnown?: boolean | undefined;
  },
  nowSeconds: number,
): RebalancerStatus {
  if (isVirtualPool(pool)) return "N/A";
  // Never-rebalance pools never have rebalance work to do — silence is
  // expected by design. Short-circuit BEFORE the lastRebalancedAt
  // check, otherwise a freshly-deployed never-rebalance pool (the most
  // natural state — never rebalanced because it never should) would
  // return NO_DATA instead of ACTIVE. Mirrors `computeHealthStatus`'s
  // short-circuit so liveness ↔ health stay aligned for these pools.
  if (isNeverRebalance(pool)) return "ACTIVE";
  if (!pool.lastRebalancedAt || pool.lastRebalancedAt === "0") return "NO_DATA";
  const age = nowSeconds - Number(pool.lastRebalancedAt);
  if (age <= 86400) return "ACTIVE";
  const diff = Number(pool.priceDifference ?? "0");
  // A rebalancer that hasn't fired in 24h is only actually stale if the
  // pool genuinely needs rebalancing — i.e. above the 1% tolerance line, in
  // lockstep with `isInDeviationBreach` and `computeHealthStatus`. Within
  // tolerance, silence is expected.
  const needsRebalance =
    diff > effectiveThreshold(pool) * DEVIATION_TOLERANCE_RATIO;
  return needsRebalance ? "STALE" : "ACTIVE";
}

/**
 * Format deviation as a percentage of the threshold.
 * Returns a string like "49.1%" or "0%".
 */
export function formatDeviationPct(
  priceDifference: string,
  rebalanceThreshold: number,
): string {
  if (!rebalanceThreshold || rebalanceThreshold === 0) return "0%";
  const ratio = Number(priceDifference) / rebalanceThreshold;
  return `${(ratio * 100).toFixed(1)}%`;
}
