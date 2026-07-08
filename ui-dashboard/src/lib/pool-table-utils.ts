import {
  isVirtualPoolMedianInvalid,
  ORACLE_STALE_SECONDS_BY_CHAIN,
  oracleFreshnessTimestamp,
} from "@/lib/health";
import type { Network } from "@/lib/networks";
import { isVirtualPool, type Pool } from "@/lib/types";
import { tokenSymbol } from "@/lib/tokens";
import { formatDurationShort } from "@/lib/bridge-status";

/** Wall-clock "how long has the current breach been going" for the
 *  CRITICAL/WARN tooltip. Wall-clock (not trading-seconds) because
 *  operators reading the tooltip think in elapsed real time — "started
 *  1d 3h ago" — not in SLO-debited time. Returns null when there's no
 *  open breach anchor to measure from. */
function openBreachDuration(p: Pool, nowSeconds: number | null): string | null {
  if (nowSeconds === null) return null;
  const start = Number(p.deviationBreachStartedAt ?? "0");
  if (!start) return null;
  if (nowSeconds <= start) return null;
  return formatDurationShort(nowSeconds - start);
}

function criticalHealthTooltip(args: {
  pool: Pool;
  oracleIsStale: boolean;
  nowSeconds: number | null;
}): string {
  const { pool, oracleIsStale, nowSeconds } = args;
  if (isVirtualPoolMedianInvalid(pool)) {
    return "VirtualPool median or quorum invalid — swaps may revert until a valid median with enough active reporters is restored";
  }
  if (isVirtualPool(pool)) {
    return "VirtualPool oracle stale — no fresh report within the reset window";
  }
  if (oracleIsStale) return "Oracle stale — last update expired";
  const duration = openBreachDuration(pool, nowSeconds);
  return duration
    ? `Rebalance overdue — deviation above threshold for ${duration}`
    : "Rebalance overdue — deviation above threshold for more than 1h";
}

// Status-only tooltips (no oracle/breach context needed). A lookup instead of
// per-status branches keeps `healthTooltip` under the complexity budget.
const STATIC_HEALTH_TOOLTIP: Record<string, string> = {
  "N/A": "VirtualPool — oracle health not tracked",
  HALTED:
    "Trading halted — a price circuit breaker is tripped; swaps are paused until it resets",
  WEEKEND:
    "FX markets are closed this weekend — trading paused until ~Sunday 23:00 UTC",
};

function healthTooltip(
  status: string,
  p: Pool,
  chainId?: number,
  nowSeconds: number | null = Math.floor(Date.now() / 1000),
): string {
  const staticText = STATIC_HEALTH_TOOLTIP[status];
  if (staticText) return staticText;
  const oracleTs = oracleFreshnessTimestamp(p);
  // Mirror computeHealthStatus: use the indexed per-feed expiry, falling back to the
  // per-chain default so the tooltip root-cause matches the badge on non-300s networks.
  const chainFallback =
    (chainId !== undefined
      ? ORACLE_STALE_SECONDS_BY_CHAIN[chainId]
      : undefined) ?? 300;
  const stalenessThreshold = Number(p.oracleExpiry ?? "0") || chainFallback;
  const isOracleStale =
    oracleTs === 0 ||
    (nowSeconds !== null && nowSeconds - oracleTs > stalenessThreshold);
  if (status === "CRITICAL") {
    return criticalHealthTooltip({
      pool: p,
      oracleIsStale: isOracleStale,
      nowSeconds,
    });
  }
  if (status === "WARN") {
    const duration = openBreachDuration(p, nowSeconds);
    return duration
      ? `Deviation above threshold for ${duration} — rebalance expected within 1h`
      : "Deviation above threshold — rebalance expected within 1h";
  }
  return "Oracle healthy / Pool balanced";
}

function limitTooltipFragment(
  limitStatus: string,
  p: Pool,
  network: Network,
): string | null {
  if (limitStatus === "N/A" || limitStatus === "OK") return null;
  const p0 = Number(p.limitPressure0 ?? "0");
  const p1 = Number(p.limitPressure1 ?? "0");
  const sym0 = tokenSymbol(network, p.token0 ?? null);
  const sym1 = tokenSymbol(network, p.token1 ?? null);
  const parts: string[] = [];
  if (p0 > 0) parts.push(`${sym0} at ${(p0 * 100).toFixed(0)}%`);
  if (p1 > 0) parts.push(`${sym1} at ${(p1 * 100).toFixed(0)}%`);
  const detail = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  if (limitStatus === "CRITICAL") return `Trading limit breached${detail}`;
  return `Trading limit pressure ≥ 80%${detail}`;
}

export function combinedTooltip(
  healthStatus: string,
  limitStatus: string,
  p: Pool,
  network: Network,
  nowSeconds: number | null = Math.floor(Date.now() / 1000),
): string {
  const hTip = healthTooltip(healthStatus, p, network.chainId, nowSeconds);
  const lFrag = limitTooltipFragment(limitStatus, p, network);
  return lFrag ? `${hTip} · ${lFrag}` : hTip;
}
