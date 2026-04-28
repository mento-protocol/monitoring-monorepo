import { Gauge, Counter, Registry } from "prom-client";
import {
  chainSlug,
  explorerAddressUrl,
  hasChain,
} from "@mento-protocol/monitoring-config/chains";
import {
  poolName,
  tokenSymbol,
} from "@mento-protocol/monitoring-config/tokens";
import {
  poolIdAddress,
  shortAddress,
} from "@mento-protocol/monitoring-config/format";
import type { PoolRow } from "./types.js";

// Pools we've already warned about — prevents log spam on the 30s poll loop.
const warnedUnknownPools = new Set<string>();

// PR #209 safety net — warn once per pool when any display label falls back,
// so a missing chain/token in shared-config or @mento-protocol/contracts
// doesn't silently ship degraded Slack alerts.
function warnIfUnknown(pool: PoolRow, pair: string | null): void {
  if (warnedUnknownPools.has(pool.id)) return;
  const missing: string[] = [];
  if (pair === null) {
    // Include token addresses so on-call can jump straight to @mento-protocol/contracts
    // without looking up the pool row in Hasura first.
    missing.push(
      `pair (token0=${pool.token0 ?? "null"}, token1=${pool.token1 ?? "null"})`,
    );
  }
  if (!hasChain(pool.chainId)) missing.push("chain_name", "block_explorer_url");
  if (missing.length === 0) return;
  warnedUnknownPools.add(pool.id);
  console.warn(
    `[metrics-bridge] pool ${pool.id} (chain ${pool.chainId}) missing ${missing.join(", ")} — falling back. Add the chain to shared-config/chain-metadata.json, or the token to @mento-protocol/contracts.`,
  );
}

export function healthStatusToNumber(status: string): number {
  switch (status) {
    case "OK":
      return 0;
    case "WARN":
      return 1;
    case "CRITICAL":
      return 2;
    default:
      return 3;
  }
}

const fp = (s: string) => parseFloat(s);

export const register = new Registry();

// Display-oriented labels are carried on every pool-scoped series so Slack
// alert templates can render a readable title + deep-links to the block
// explorer and dashboard without needing a PromQL join against an info metric.
// Cardinality is bounded by the number of pools (each label is 1:1 with
// pool_id), so adding them doesn't create new series — only widens them.
const poolLabels = [
  "pool_id",
  "chain_id",
  "chain_name",
  "pair",
  "pool_address_short",
  "block_explorer_url",
] as const;
const pressureLabels = [...poolLabels, "token_index"] as const;
// Reserve-share gauges carry an additional `token_symbol` label so the Slack
// alert annotation can render "17% USDT / 83% USDm" without parsing the `pair`
// label (sprig `splitList` is NOT in scope for Grafana annotation templates —
// only Go text/template builtins + Prometheus helpers like
// `humanizePercentage` are. Label access via `$values.X.Labels.Y` is a Go
// template builtin, so this is safe).
const reserveShareLabels = [...poolLabels, "token_symbol"] as const;
// `reason_code` and `reason_message` are bounded by the ERROR_MESSAGES enum
// (~30 codes) and one-to-one with each other — carrying both as labels
// lets the Slack template read `$labels.reason_message` directly without
// keeping a sprig lookup table in sync with the indexer ABI.
const rebalanceBlockedLabels = [
  ...poolLabels,
  "reason_code",
  "reason_message",
] as const;

export const gauges = {
  oracleOk: new Gauge({
    name: "mento_pool_oracle_ok",
    help: "Oracle can-trade flag at last on-chain event (1=ok, 0=not ok). For live staleness, use (time() - oracle_timestamp) / oracle_expiry in PromQL.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleTimestamp: new Gauge({
    name: "mento_pool_oracle_timestamp",
    help: "Unix timestamp of the last oracle report. Use with oracle_expiry to compute live liveness ratio.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleExpiry: new Gauge({
    name: "mento_pool_oracle_expiry",
    help: "Oracle report expiry window in seconds",
    labelNames: poolLabels,
    registers: [register],
  }),
  deviationRatio: new Gauge({
    name: "mento_pool_deviation_ratio",
    help: "Deviation ratio (priceDifference / rebalanceThreshold)",
    labelNames: poolLabels,
    registers: [register],
  }),
  deviationBreachStart: new Gauge({
    name: "mento_pool_deviation_breach_start",
    help: "Unix timestamp when deviation breach started (0 = no breach)",
    labelNames: poolLabels,
    registers: [register],
  }),
  limitPressure: new Gauge({
    name: "mento_pool_limit_pressure",
    help: "Trading limit pressure per token direction",
    labelNames: pressureLabels,
    registers: [register],
  }),
  // Flat per-token reserve-share gauges. Split from a single
  // `mento_pool_reserve_share{token_index}` (PR #234 review) because
  // Grafana per-instance label match (`$values.R0` / `$values.R1` against
  // a firing alert keyed on `pool_id, chain_id, pair`) silently fails
  // when the annotation query carries an extra dimension that's not in
  // the firing fingerprint. The pool-fingerprint subset of labels MUST
  // match the deviation-ratio gauge's exactly so the `current_reserves`
  // annotation actually renders. The `token_symbol` extension carries
  // axlUSDC / USDm into the Slack alert without forcing the annotation
  // template to parse the `pair` label (which would require sprig
  // `splitList`, NOT in scope for Grafana annotation templates).
  reserveShareToken0: new Gauge({
    name: "mento_pool_reserve_share_token0",
    help: "Share of normalized reserves held in token0 (decimal-adjusted, no oracle conversion). r0_normalized / (r0_normalized + r1_normalized) ∈ [0, 1]. Skipped when both reserves are zero (share undefined); emits 1.0 / 0.0 for one-sided pools to preserve the diagnostic '100% USDT / 0% USDm' signal. Carries a `token_symbol` label (axlUSDC, USDm, …) so Slack alerts can name the imbalance without parsing the `pair` label.",
    labelNames: reserveShareLabels,
    registers: [register],
  }),
  reserveShareToken1: new Gauge({
    name: "mento_pool_reserve_share_token1",
    help: "Share of normalized reserves held in token1 (decimal-adjusted, no oracle conversion). r1_normalized / (r0_normalized + r1_normalized) ∈ [0, 1]. Skipped when both reserves are zero; emits 1.0 / 0.0 for one-sided pools (mirror of reserve_share_token0). Carries a `token_symbol` label.",
    labelNames: reserveShareLabels,
    registers: [register],
  }),
  lastRebalancedAt: new Gauge({
    name: "mento_pool_last_rebalanced_at",
    help: "Unix timestamp of the last rebalance",
    labelNames: poolLabels,
    registers: [register],
  }),
  rebalanceEffectiveness: new Gauge({
    name: "mento_pool_rebalance_effectiveness",
    help: "Last observed rebalance effectiveness ratio: (priceDiff_before - priceDiff_after) / (priceDiff_before - rebalanceThreshold). 1.0 = rebalance landed exactly on the rebalance boundary (ideal); >1.0 = overshoot past the boundary (e.g. all the way to the oracle, which is over-correction); 0 = no reduction; <0 = rebalance made deviation WORSE. -1 indexer sentinel (degenerate case — zero pre-deviation, missing threshold, or pool was already in-band) is skipped.",
    labelNames: poolLabels,
    registers: [register],
  }),
  swapFeeBps: new Gauge({
    name: "mento_pool_swap_fee_bps",
    help: "Combined swap fee (lpFee + protocolFee) in basis points. Used as the threshold for the Oracle Jump alert. Skipped when either fee is the -1 indexer sentinel (fetch failed at pool creation).",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleJumpBps: new Gauge({
    name: "mento_pool_oracle_jump_bps",
    help: "|newMedian − prevMedian| / prevMedian × 10_000 for the most recent MedianUpdated event, in basis points (4dp fixed-point). 0 before the second median on a feed.",
    labelNames: poolLabels,
    registers: [register],
  }),
  oracleJumpAt: new Gauge({
    name: "mento_pool_oracle_jump_at",
    help: "Unix timestamp of the MedianUpdated event that produced oracle_jump_bps. 0 before the first median. Alerts gate on (time() - this) to avoid firing on stale samples.",
    labelNames: poolLabels,
    registers: [register],
  }),
  healthStatus: new Gauge({
    name: "mento_pool_health_status",
    help: "Pool health status at last on-chain event (0=OK, 1=WARN, 2=CRITICAL, 3=N/A). Event-time snapshot, not live.",
    labelNames: poolLabels,
    registers: [register],
  }),
  bridgeLastPoll: new Gauge({
    name: "mento_pool_bridge_last_poll",
    help: "Unix timestamp of the last successful poll",
    registers: [register],
  }),
  rebalanceBlocked: new Gauge({
    name: "mento_pool_rebalance_blocked",
    help: "1 when a critical-breach pool's `rebalance(pool)` simulation reverts (i.e. the rebalancer can't close the breach right now). Labels carry the Solidity error code (`reason_code`) and a human-readable explanation (`reason_message`). Reset before each probe cycle, so transport failures and pools currently below the probe threshold simply leave the series absent.",
    labelNames: rebalanceBlockedLabels,
    registers: [register],
  }),
  rebalanceProbeLastRun: new Gauge({
    name: "mento_pool_rebalance_probe_last_run",
    help: "Unix timestamp of the last completed rebalance-reason probe cycle. 0 before the first cycle.",
    registers: [register],
  }),
};

export const counters = {
  pollErrors: new Counter({
    name: "mento_pool_bridge_poll_errors_total",
    help: "Total number of poll errors",
    registers: [register],
  }),
};

/**
 * Gauges that are NOT reset on each Hasura poll. Their lifecycles are owned
 * elsewhere:
 *   - `bridgeLastPoll` and `rebalanceProbeLastRun` are scalar self-monitoring
 *     gauges with no label set to evict.
 *   - `rebalanceBlocked` is reset by the rebalance probe cycle (not the poll
 *     cycle), so its labels survive between probes — wiping it on every
 *     30s poll would leave the alert annotation flickering off most of the
 *     time, since probes only run every Nth poll.
 */
const POLL_PRESERVED_GAUGES = new Set<Gauge>([
  gauges.bridgeLastPoll,
  gauges.rebalanceProbeLastRun,
  gauges.rebalanceBlocked,
]);

export function updateMetrics(pools: PoolRow[]): void {
  // Reset pool-level gauges to evict stale label sets from removed pools.
  for (const g of Object.values(gauges)) {
    if (!POLL_PRESERVED_GAUGES.has(g)) g.reset();
  }

  for (const pool of pools) {
    const address = poolIdAddress(pool.id);
    const derivedPair = poolName(pool.chainId, pool.token0, pool.token1);
    warnIfUnknown(pool, derivedPair);
    const labels = {
      pool_id: pool.id,
      chain_id: String(pool.chainId),
      chain_name: chainSlug(pool.chainId),
      pair: derivedPair ?? pool.id,
      pool_address_short: shortAddress(address),
      block_explorer_url: explorerAddressUrl(pool.chainId, address) ?? "",
    };

    gauges.healthStatus.set(labels, healthStatusToNumber(pool.healthStatus));
    gauges.oracleOk.set(labels, pool.oracleOk ? 1 : 0);
    gauges.oracleTimestamp.set(labels, Number(pool.oracleTimestamp));
    gauges.oracleExpiry.set(labels, Number(pool.oracleExpiry));
    // Skip the "-1" no-data sentinel. The indexer writes "-1" both on initial
    // pool creation AND during no-data intervals (rebalanceThreshold <= 0),
    // even after hasHealthData has been set to true.
    const devRatio = fp(pool.lastDeviationRatio);
    if (devRatio >= 0) {
      gauges.deviationRatio.set(labels, devRatio);
    }
    gauges.deviationBreachStart.set(
      labels,
      Number(pool.deviationBreachStartedAt),
    );
    gauges.lastRebalancedAt.set(labels, Number(pool.lastRebalancedAt));
    // Skip only the explicit "-1" no-data sentinel the indexer writes before
    // a pool has ever rebalanced (or for degenerate rebalances with zero
    // pre-deviation). Negative non-sentinel values (rebalance moved price
    // FURTHER from oracle) are legitimate observations and MUST publish — the
    // `Rebalance Ineffective` alert explicitly treats `< 0` as worse-than-noop.
    if (pool.lastEffectivenessRatio !== "-1") {
      gauges.rebalanceEffectiveness.set(
        labels,
        fp(pool.lastEffectivenessRatio),
      );
    }
    // Swap fee — skip the `-1` sentinel the indexer writes when the initial
    // RPC fetch at pool creation failed (rpc.ts:fetchFees). Without this gate
    // the `Oracle Jump` alert would see a "0 bps" threshold and fire on the
    // first real oracle movement. `-1` on either side means we can't trust
    // the sum.
    if (pool.lpFee >= 0 && pool.protocolFee >= 0) {
      gauges.swapFeeBps.set(labels, pool.lpFee + pool.protocolFee);
    }
    gauges.oracleJumpBps.set(labels, fp(pool.lastOracleJumpBps));
    gauges.oracleJumpAt.set(labels, Number(pool.lastOracleJumpAt));
    gauges.limitPressure.set(
      { ...labels, token_index: "0" },
      fp(pool.limitPressure0),
    );
    gauges.limitPressure.set(
      { ...labels, token_index: "1" },
      fp(pool.limitPressure1),
    );

    // Reserve share — face-value % of each token in the pool, decimal-
    // adjusted so 6dp / 18dp pairs (e.g. USDC / USDm) compute correctly.
    // Used by the deviation-breach Slack alert to render "17% USDT / 83%
    // USDm" alongside the magnitude. Both legs in USD-pegged FPMMs makes
    // this a meaningful imbalance indicator; on FX pools it's a decent
    // proxy.
    //
    // Casting BigInt-string reserves to Number is fine for a *ratio*: we
    // divide two values of similar magnitude and IEEE-754 float precision
    // (~15 decimal digits) is far more than needed for a percentage
    // rendered to one decimal place.
    //
    // Empty pool (both reserves zero) → skip emit; the share is undefined
    // and we don't want a misleading 0/0 series. One-sided dead pool
    // (single reserve zero) → emit 0.0/1.0 so the alert renders "100%
    // USDT / 0% USDm", which IS the diagnostic signal.
    //
    // Two flat gauges (token0 / token1) instead of a single gauge with a
    // `token_index` label so the annotation queries on the deviation-
    // breach critical alert match the firing alert's label set exactly.
    // The `token_symbol` label carries the resolved symbol so the
    // annotation template can render "axlUSDC / USDm" without parsing
    // `pair` (sprig `splitList` is unavailable in Grafana annotation
    // templates). Falls back to literal "token0" / "token1" when the
    // contract address isn't in @mento-protocol/contracts — matches the
    // existing fallback semantics for `pair`.
    const r0 = Number(pool.reserves0) / 10 ** pool.token0Decimals;
    const r1 = Number(pool.reserves1) / 10 ** pool.token1Decimals;
    const total = r0 + r1;
    if (Number.isFinite(total) && total > 0) {
      const token0Symbol = tokenSymbol(pool.chainId, pool.token0) ?? "token0";
      const token1Symbol = tokenSymbol(pool.chainId, pool.token1) ?? "token1";
      gauges.reserveShareToken0.set(
        { ...labels, token_symbol: token0Symbol },
        r0 / total,
      );
      gauges.reserveShareToken1.set(
        { ...labels, token_symbol: token1Symbol },
        r1 / total,
      );
    }
  }
}

/**
 * Build the shared pool-display label set used across all pool-scoped
 * gauges. Exposed so the rebalance probe can attach the same labels
 * (chain_name, pair, block_explorer_url, …) without re-deriving them.
 */
export type PoolDisplayLabels = {
  pool_id: string;
  chain_id: string;
  chain_name: string;
  pair: string;
  pool_address_short: string;
  block_explorer_url: string;
};

export function poolDisplayLabels(pool: PoolRow): PoolDisplayLabels {
  const address = poolIdAddress(pool.id);
  const derivedPair = poolName(pool.chainId, pool.token0, pool.token1);
  return {
    pool_id: pool.id,
    chain_id: String(pool.chainId),
    chain_name: chainSlug(pool.chainId),
    pair: derivedPair ?? pool.id,
    pool_address_short: shortAddress(address),
    block_explorer_url: explorerAddressUrl(pool.chainId, address) ?? "",
  };
}
