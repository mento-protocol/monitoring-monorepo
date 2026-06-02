import { Gauge } from "prom-client";
import {
  chainSlug,
  explorerAddressUrl,
} from "@mento-protocol/monitoring-config/chains";
import { toHumanUnits } from "@mento-protocol/monitoring-config/units";
import { register } from "./metrics.js";
import type { CdpInstance } from "./types.js";

// Mento's CDP debt tokens (GBPm / CHFm / JPYm) are 18-decimal ERC20s, like
// every Mento stable. All token-denominated columns (systemDebt, spDeposits,
// spHeadroom, shortfallSubsidyCum) are debt-token wei.
const DEBT_TOKEN_DECIMALS = 18;

// One series per CDP market (3 today: GBPm/CHFm/JPYm on Celo), so cardinality
// is bounded by market count. `symbol` lets the Slack alert template render a
// readable title + dashboard deep link without a PromQL join;
// `block_explorer_url` carries the TroveManager link for annotations/ad-hoc
// triage. `collateral_id` is the stable per-market grouping key
// ("{chainId}-{troveManager}").
const cdpLabels = [
  "symbol",
  "chain_id",
  "chain_name",
  "collateral_id",
  "block_explorer_url",
] as const;

type CdpLabelValues = Record<(typeof cdpLabels)[number], string>;

export const cdpGauges = {
  shutdown: new Gauge({
    name: "mento_cdp_shutdown",
    help: "1 when a CDP market has triggered Liquity ShutDown (system below SCR; borrowing disabled), 0 otherwise.",
    labelNames: cdpLabels,
    registers: [register],
  }),
  spHeadroom: new Gauge({
    name: "mento_cdp_sp_headroom",
    help: "Stability Pool headroom in debt-token units (spDeposits − MIN_BOLD_IN_SP). ≤ 0 means the SP is at/below the on-chain minimum buffer. Absent until SystemParams is loaded.",
    labelNames: cdpLabels,
    registers: [register],
  }),
  spDeposits: new Gauge({
    name: "mento_cdp_sp_deposits",
    help: "Total Stability Pool deposits in debt-token units.",
    labelNames: cdpLabels,
    registers: [register],
  }),
  systemDebt: new Gauge({
    name: "mento_cdp_system_debt",
    help: "Total outstanding CDP debt for the market in debt-token units (Σ open-trove debt).",
    labelNames: cdpLabels,
    registers: [register],
  }),
  liquidationTotal: new Gauge({
    name: "mento_cdp_liquidation_total",
    help: "Cumulative liquidation count for the market. Use increase() over a window for activity alerting; resets to 0 on indexer re-sync.",
    labelNames: cdpLabels,
    registers: [register],
  }),
  userRedemptionTotal: new Gauge({
    name: "mento_cdp_user_redemption_total",
    help: "Cumulative USER (non-rebalance) redemption count = redemptionCountCum − rebalanceRedemptionCountCum. Excludes CDPLiquidityStrategy-driven rebalances. Resets on re-sync.",
    labelNames: cdpLabels,
    registers: [register],
  }),
  shortfallSubsidyTotal: new Gauge({
    name: "mento_cdp_shortfall_subsidy_total",
    help: "Cumulative redemption shortfall absorbed by the protocol (RedemptionShortfallSubsidized), in debt-token units. A direct economic loss. Resets on re-sync.",
    labelNames: cdpLabels,
    registers: [register],
  }),
} as const;

function cdpDisplayLabels({
  instance,
  collateral,
}: CdpInstance): CdpLabelValues {
  return {
    symbol: collateral.symbol,
    chain_id: String(instance.chainId),
    chain_name: chainSlug(instance.chainId),
    collateral_id: instance.collateralId,
    block_explorer_url:
      explorerAddressUrl(instance.chainId, collateral.troveManager) ?? "",
  };
}

interface PreparedCdpSeries {
  labels: CdpLabelValues;
  shutdown: number;
  spDeposits: number;
  systemDebt: number;
  liquidationTotal: number;
  userRedemptionTotal: number;
  shortfallSubsidyTotal: number;
  // null when SystemParams is not yet loaded — the −1-wei sentinel is withheld.
  spHeadroom: number | null;
}

// `toHumanUnits` floors to 6 fractional digits, so any |value| < 1e-6 tokens
// (< 1e12 wei) collapses to exactly 0 — dropping the sign AND the "is it
// nonzero / did it move" signal. That's a blind spot for the wei-denominated
// gauges whose alert rules treat ANY nonzero value (or any increment) as
// significant:
//   - `mento_cdp_sp_headroom < 0` — deposits a sub-microtoken below the floor
//     would publish 0 and never fire.
//   - `increase(mento_cdp_shortfall_subsidy_total[6h]) > 0` — a first subsidy
//     of 1 wei, OR a later 1→2 wei dust increment, would show no change and
//     never fire.
//
// A BigInt below 2^53 wei (~0.009 tokens) is exactly representable as a Number,
// so dividing by 1e18 keeps EVERY wei increment distinct and strictly
// monotonic — sign preserved, no two values collapse. Above 2^53 the shared
// scaled conversion takes over: low-order wei are far below alert resolution at
// that magnitude (and Number() would drop them anyway), while the rule has long
// since crossed its threshold. Counts (liqCountCum etc.) are plain integers,
// not wei, so they don't route through here.
const MAX_EXACT_WEI = 9_007_199_254_740_992n; // 2^53

function humanUnitsPreservingDust(raw: bigint): number {
  if (raw > -MAX_EXACT_WEI && raw < MAX_EXACT_WEI) {
    return Number(raw) / 10 ** DEBT_TOKEN_DECIMALS;
  }
  return toHumanUnits(raw, DEBT_TOKEN_DECIMALS);
}

// spHeadroom carries a −1-wei sentinel until SystemParams is loaded; a real
// negative headroom (the danger we alert on) is orders of magnitude larger.
// Gate on the collateral flag so the critical "below floor" rule never reads
// the sentinel as a sub-zero breach.
function prepareCdpSeries({
  instance,
  collateral,
}: CdpInstance): PreparedCdpSeries {
  return {
    labels: cdpDisplayLabels({ instance, collateral }),
    shutdown: instance.isShutDown ? 1 : 0,
    spDeposits: toHumanUnits(BigInt(instance.spDeposits), DEBT_TOKEN_DECIMALS),
    systemDebt: toHumanUnits(BigInt(instance.systemDebt), DEBT_TOKEN_DECIMALS),
    liquidationTotal: instance.liqCountCum,
    userRedemptionTotal: Math.max(
      0,
      instance.redemptionCountCum - instance.rebalanceRedemptionCountCum,
    ),
    shortfallSubsidyTotal: humanUnitsPreservingDust(
      BigInt(instance.shortfallSubsidyCum),
    ),
    spHeadroom: collateral.systemParamsLoaded
      ? humanUnitsPreservingDust(BigInt(instance.spHeadroom))
      : null,
  };
}

// Refreshes every CDP gauge from the joined instance/collateral rows.
//
// All conversions happen up front (prepareCdpSeries): a malformed value throws
// BEFORE any gauge is reset, so the poll loop's cdp_update handler keeps the
// last good series instead of leaving a half-cleared registry — which
// `no_data_state=OK` would otherwise read as a silent all-clear. The reset +
// publish loop below is pure `.set()` and cannot throw, so the registry only
// ever transitions between two consistent states. The reset still evicts the
// series of any market that dropped out of the indexer response.
export function updateCdpMetrics(cdps: CdpInstance[]): void {
  const prepared = cdps.map(prepareCdpSeries);

  for (const g of Object.values(cdpGauges)) g.reset();

  for (const row of prepared) {
    cdpGauges.shutdown.set(row.labels, row.shutdown);
    cdpGauges.spDeposits.set(row.labels, row.spDeposits);
    cdpGauges.systemDebt.set(row.labels, row.systemDebt);
    cdpGauges.liquidationTotal.set(row.labels, row.liquidationTotal);
    cdpGauges.userRedemptionTotal.set(row.labels, row.userRedemptionTotal);
    cdpGauges.shortfallSubsidyTotal.set(row.labels, row.shortfallSubsidyTotal);
    if (row.spHeadroom !== null) {
      cdpGauges.spHeadroom.set(row.labels, row.spHeadroom);
    }
  }
}
