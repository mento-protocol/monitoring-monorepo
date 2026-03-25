import { ORACLE_STALE_SECONDS_BY_CHAIN } from "@/lib/health";
import type { RebalancerStatus } from "@/lib/health";
import type { Network } from "@/lib/networks";
import type { Pool } from "@/lib/types";
import { tokenSymbol } from "@/lib/tokens";

export function healthTooltip(
  status: string,
  p: Pool,
  chainId?: number,
): string {
  if (status === "N/A") return "VirtualPool — oracle health not tracked";
  const oracleTs = Number(p.oracleTimestamp ?? "0");
  // Mirror computeHealthStatus: use the indexed per-feed expiry, falling back to the
  // per-chain default so the tooltip root-cause matches the badge on non-300s networks.
  const chainFallback =
    (chainId !== undefined
      ? ORACLE_STALE_SECONDS_BY_CHAIN[chainId]
      : undefined) ?? 300;
  const stalenessThreshold = Number(p.oracleExpiry ?? "0") || chainFallback;
  const isOracleStale =
    oracleTs === 0 ||
    Math.floor(Date.now() / 1000) - oracleTs > stalenessThreshold;
  if (status === "WEEKEND")
    return "FX markets are closed this weekend — trading paused until ~Sunday 23:00 UTC";
  if (status === "CRITICAL" && isOracleStale)
    return "Oracle stale — last update expired";
  if (status === "CRITICAL")
    return "Needs rebalance: price deviation ≥ threshold";
  if (status === "WARN") return "Price deviation ≥ 80% of rebalance threshold";
  return "Oracle healthy";
}

export function limitTooltipFragment(
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
): string {
  const hTip = healthTooltip(healthStatus, p, network.chainId);
  const lFrag = limitTooltipFragment(limitStatus, p, network);
  return lFrag ? `${hTip} · ${lFrag}` : hTip;
}

export function rebalancerTooltip(status: RebalancerStatus): string {
  if (status === "ACTIVE")
    return "Rebalancer active — last rebalance within 24h";
  if (status === "STALE")
    return "No rebalance in 24h while pool health is not OK";
  if (status === "NO_DATA") return "No rebalance events recorded yet";
  return "VirtualPool — rebalancer not applicable";
}
