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
// is bounded by market count. `symbol` + `block_explorer_url` let the Slack
// alert template render a readable title and a TroveManager deep link without
// a PromQL join. `collateral_id` is the stable per-market grouping key
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

// Refreshes every CDP gauge from the joined instance/collateral rows. Reset
// first so a market that drops out of the indexer response evicts its stale
// series instead of freezing at the last value.
export function updateCdpMetrics(cdps: CdpInstance[]): void {
  for (const g of Object.values(cdpGauges)) g.reset();

  for (const cdp of cdps) {
    const { instance, collateral } = cdp;
    const labels = cdpDisplayLabels(cdp);

    cdpGauges.shutdown.set(labels, instance.isShutDown ? 1 : 0);
    cdpGauges.spDeposits.set(
      labels,
      toHumanUnits(BigInt(instance.spDeposits), DEBT_TOKEN_DECIMALS),
    );
    cdpGauges.systemDebt.set(
      labels,
      toHumanUnits(BigInt(instance.systemDebt), DEBT_TOKEN_DECIMALS),
    );
    cdpGauges.liquidationTotal.set(labels, instance.liqCountCum);
    cdpGauges.userRedemptionTotal.set(
      labels,
      Math.max(
        0,
        instance.redemptionCountCum - instance.rebalanceRedemptionCountCum,
      ),
    );
    cdpGauges.shortfallSubsidyTotal.set(
      labels,
      toHumanUnits(BigInt(instance.shortfallSubsidyCum), DEBT_TOKEN_DECIMALS),
    );

    // spHeadroom carries a −1-wei sentinel until SystemParams is loaded; a
    // real negative headroom (the danger we alert on) is orders of magnitude
    // larger. Gate on the collateral flag so the critical "below floor" rule
    // never reads the sentinel as a sub-zero breach.
    if (collateral.systemParamsLoaded) {
      cdpGauges.spHeadroom.set(
        labels,
        toHumanUnits(BigInt(instance.spHeadroom), DEBT_TOKEN_DECIMALS),
      );
    }
  }
}
